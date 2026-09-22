/**
 * 服务端装配入口（T3）——把 HTTP 层、存储层、就绪探测拼起来并监听。
 *
 * 为什么单开一个文件而不是塞进 `http.ts`：
 * `http.ts` 负责**路由语义**（可脱离进程单测），本文件负责**进程装配**
 * （选 JobStore、接 PG、装信号处理），两者关注点不同、测试方式也不同。
 */
import type http from 'node:http'
import os from 'node:os'
import { requirePgPool, pingPg, resolvePgConfigFromEnv } from '../db/pool.js'
import { createMemoryJobStore } from '../jobs/memory-store.js'
import { createPgJobStore } from '../jobs/pg-store.js'
import type { JobStore } from '../jobs/store.js'
import type { Job } from '../jobs/types.js'
import { createMemoryUsageStore, createPgUsageStore, type UsageStore } from '../usage/index.js'
import { createWorker, type Worker } from '../jobs/worker.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertAuthConfigForBinding,
  resolveApiKeysFromEnv,
  type ApiKeyEntry,
} from './auth.js'
import { createServerApp, MAX_BODY_BYTES } from './http.js'
import type { Alert } from '../webhook/types.js'
import type { IngestResult, IngestContext } from '../ingest/pipeline.js'
import { createTracingSink, type TracingSink } from '../observability/tracing.js'

export type ServeOptions = {
  /** 服务端工作区路径（plan G4），缺省 `process.cwd()`。 */
  cwd: string
  port: number
  host: string
  /**
   * 共享 secret（T3 形态）。绑定非回环地址时**强制要求**，否则拒绝启动。
   *
   * T6 起逐步被下面的 `apiKeys` 取代 —— 单 secret 只能答"是不是自己人"，
   * 答不了"你是谁"，无法支撑 per-user 隔离。留着是为了兼容老部署。
   */
  secret?: string
  /**
   * T6 鉴权 key 表（key → userId）。缺省时从环境变量解析
   * （`LITE_AI_API_KEYS` / `LITE_AI_API_KEY`，见 `auth.ts`）。
   */
  apiKeys?: readonly ApiKeyEntry[]
  /** 外部注入 store（测试用）；缺省按 DATABASE_URL 自动选。 */
  store?: JobStore
  /**
   * 用量 / 审计账本（T7）。**与 `store` 独立选择**：审计要求持久化，
   * 而 job 队列可以容忍内存形态，所以两者的降级策略不能绑死。
   * 缺省按 `DATABASE_URL` 自动选 —— 有 PG 用 PG，没有则内存并**显式告警**。
   */
  usage?: UsageStore
  /**
   * Worker 执行器（T5 接线 `runAgentTurn`）。
   * 缺省时用一个**明确抛错**的占位实现 —— 让缺接线这件事暴露成 failed，
   * 而不是静默假装成功。
   */
  execute?: (job: Job) => Promise<void>
  /** Worker claim 轮询间隔（测试可调）。 */
  workerPollMs?: number
  /**
   * 前端静态资源目录（T10）。缺省 `dist/web`（相对仓库根）。
   *
   * **不传 = 自动探测**：目录存在就托管，不存在就跳过（不是错误）——
   * 这样"没跑过 build:web"的纯 API 部署不会因为缺目录而启动失败，
   * 只会在访问 `/` 时 404（并打一条提示）。
   */
  webRoot?: string
  /**
   * 【T57】管理面开关。默认 **false** —— 只有显式开启（或
   * `LITE_AI_ENABLE_ADMIN_API=1`）才挂 `POST /admin/reload`。
   *
   * 为什么默认关：热重载配置是"运维口子"，暴露给任何持有普通 API key 的调用方
   * 都会放大影响面。对齐 HolmesGPT 的 `ENABLE_ADMIN_API` 口径。
   */
  adminApiEnabled?: boolean
  /**
   * 【G7】告警摄入开关。默认 true —— `--serve` 直接吸收 `POST /webhook`，
   * 告警经归一化 / 去重 / 关联后入**同一个 jobs 队列**（`kind='alert'`），
   * 由本进程的 Worker 消费，不再单独起 webhook 进程。
   * 显式 false → 不挂 `/webhook` 路由（纯人工对话部署）。
   */
  enableAlerts?: boolean
  /**
   * 【G7】告警摄入实现覆盖（测试注入）。
   * 缺省按 `loadWebhookConfig()` 装配真实管道。
   */
  alertIngest?: (alerts: Alert[], ctx: IngestContext) => IngestResult
  /**
   * 【T-obs】可观测性 sink 覆盖（测试注入）。缺省按环境变量装配
   * （`createTracingSink`：无凭据 / `LITE_AI_TRACING=0` → noop）。
   */
  tracing?: TracingSink
  /** 外部触发关闭。 */
  abortSignal?: AbortSignal
}

/**
 * 选存储实现：
 * - 配了 `DATABASE_URL` / `PG*` → PG（生产路径，多实例共享队列）
 * - 否则 → 内存（单进程开发/演示；**重启即丢**，且多实例不共享）
 */
async function selectStore(opts: ServeOptions): Promise<{
  store: JobStore
  ready: () => Promise<boolean>
  dispose: () => Promise<void>
}> {
  if (opts.store !== undefined) {
    return { store: opts.store, ready: async () => true, dispose: async () => {} }
  }

  const pgConfig = resolvePgConfigFromEnv(process.env)
  if (pgConfig === null) {
    console.warn(
      '[serve] 未检测到 DATABASE_URL / PG* 配置，使用**内存队列**（重启即丢、多实例不共享）。' +
        '生产部署请配置 Postgres。',
    )
    return {
      store: createMemoryJobStore(),
      ready: async () => true,
      dispose: async () => {},
    }
  }

  // 缺配置时失败快（对齐 HolmesGPT server.py:911,918）——不要静默降级成内存，
  // 否则运维以为在跑生产队列、实际数据没有落库。
  const pool = requirePgPool(process.env)
  return {
    store: createPgJobStore(pool),
    // pingPg 失败时**抛错**而非返回 false，这里转成布尔以适配 /readyz 的探测语义。
    // 不吞异常：抛错即"未就绪"，与 DB 真的不可用时行为一致。
    ready: async () => {
      try {
        await pingPg(pool)
        return true
      } catch {
        return false
      }
    },
    dispose: async () => {
      await pool.end()
    },
  }
}

/**
 * 选用量账本实现（T7）。
 *
 * **与 `selectStore`（job 队列）分开判断，但共用同一份 PG 配置来源**：
 * 审计数据与队列数据的持久化要求不同 —— 队列用内存只是"重启后任务丢了、重发即可"，
 * 而审计用内存等于**合规检查时拿不出记录**。所以这里即使 job 队列是内存，
 * 只要配了 PG 就仍然把账本写到 PG；反之，**job 队列是 PG 而账本是内存**才是
 * 最危险的组合（运维看到 PG 连上了就以为一切持久化），必须显式告警。
 */
function selectUsage(opts: ServeOptions, jobStoreIsPg: boolean): UsageStore {
  if (opts.usage !== undefined) return opts.usage
  if (jobStoreIsPg) return createPgUsageStore(requirePgPool(process.env))
  console.warn(
    '[serve] 未检测到 Postgres：审计用量写入**内存**（重启即丢）。' +
      '这只适合本机演示 —— 生产环境的用量/审计账本必须落 PG，否则合规检查时无据可查。',
  )
  return createMemoryUsageStore()
}

/**
 * 真实执行器装配（T5）。
 *
 * 模型选择沿用 `diagnose.ts` 的约定：`LITE_AI_MODEL_MODE=mock` 时用 MockModelAdapter
 * （离线演示 / 冒烟测试），否则按运行时 provider 建真实 adapter。
 *
 * 模型走**工厂**而非实例：adapter 构造需要 tools（见 `diagnose.ts:40-52`），
 * 而 tools 要到每次执行时才装配。工厂形态也让"服务启动"与"建模型客户端"解耦 ——
 * 模型配置错误不该让 `/healthz` 起不来，而应落到那次 job 的 failed 上。
 *
 * 懒加载：只有真要跑 job 时才 import agent 栈。
 */
async function defaultExecute(
  store: JobStore,
  cwd: string,
  usage: UsageStore,
  tracing: TracingSink,
): Promise<(job: Job) => Promise<void>> {
  const { createJobExecutor } = await import('../jobs/exec.js')
  const { getSessionStore } = await import('../session.js')

  // 模型名（审计账本用）：装配期解析一次。此前这里写死空串 `''`，导致 `/usage`
  // 的 model 列恒为 null；而 exec 侧"从 adapter 探测模型名"是无根据的
  // （`ModelAdapter` 接口只有 `next()`）。这里读的是与 adapter **同一份**配置，
  // 不会漂移。
  const modelName =
    process.env.LITE_AI_MODEL_MODE === 'mock' ? 'mock' : await readConfiguredModelName()

  return createJobExecutor({
    jobStore: store,
    usage,
    // T-obs：job 执行时扇出 OTel span 到此 sink（noop 时零开销）。
    tracing,
    sessionStore: getSessionStore(),
    cwd,
    model: async ({ tools }) => {
      if (process.env.LITE_AI_MODEL_MODE === 'mock') {
        const { MockModelAdapter } = await import('../mock-model.js')
        return new MockModelAdapter()
      }
      const { loadRuntimeConfig } = await import('../config.js')
      const runtime = await loadRuntimeConfig()
      if (runtime.provider === 'openai') {
        const { OpenAIModelAdapter } = await import('../openai-adapter.js')
        return new OpenAIModelAdapter(tools, loadRuntimeConfig)
      }
      const { AnthropicModelAdapter } = await import('../anthropic-adapter.js')
      return new AnthropicModelAdapter(tools, loadRuntimeConfig)
    },
    modelName,
    log: (level, message) => {
      if (level === 'error') console.error(message)
      else if (level === 'warn') console.warn(message)
      else console.log(message)
    },
  })
}

/**
 * 读「运行时配置里生效的模型名」，供审计账本使用。
 *
 * **为什么不从 adapter 拿**：`ModelAdapter` 接口只有 `next()`，没有模型名字段；
 * adapter 内部是在 `next()` 里现读 `loadRuntimeConfig().model` 的，外层拿不到。
 * 既然两边读的是同一份配置，这里读一次即等价，且不需要给 adapter 加接口。
 *
 * 读不到（无配置 / 解析失败）返回 `''` —— exec 侧会落 `null`，**不猜**模型名。
 * 真正的配置错误会在 adapter 自己调用时报出来，落到那次 job 的 failed 上。
 */
async function readConfiguredModelName(): Promise<string> {
  try {
    const { loadRuntimeConfig } = await import('../config.js')
    const runtime = await loadRuntimeConfig()
    return typeof runtime.model === 'string' ? runtime.model : ''
  } catch {
    return ''
  }
}

/**
 * 【T56】读配置里的 provider 名（`/info` 用）。读不到返回 `null`，不猜。
 */
async function readConfiguredProvider(): Promise<string | null> {
  try {
    const { loadRuntimeConfig } = await import('../config.js')
    const runtime = await loadRuntimeConfig()
    return typeof runtime.provider === 'string' ? runtime.provider : null
  } catch {
    return null
  }
}

/**
 * 【T56】读包版本（`/info` 用）。读不到返回 `'unknown'` —— 宁可不报，不编造。
 */
async function readPackageVersion(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    // 相对本文件：`src/server/index.ts` → 仓库根 `package.json`。
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 【T57】配置快照 —— 只取"运维关心"的几个字段（`/admin/reload` 比对差异用）。
 *
 * 刻意**不含** `authToken` / `apiKey`：这个对象会被 diff 成响应体回给调用方，
 * 放凭证进去就是把密钥印在 reload 的回执上。
 */
type RuntimeSnapshot = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  mcpServers: string[]
}

/** 【T57】读一份配置快照。读不到就全空 —— 不编造。 */
async function readRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  try {
    const { loadRuntimeConfig } = await import('../config.js')
    const runtime = await loadRuntimeConfig()
    return {
      provider: runtime.provider,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      mcpServers: Object.keys(runtime.mcpServers).sort(),
    }
  } catch {
    return { provider: null, model: null, baseUrl: null, mcpServers: [] }
  }
}

/** 【T57】比对两份快照，产出 `{field, from, to}` 列表。 */
function diffSnapshots(
  before: RuntimeSnapshot | null,
  after: RuntimeSnapshot,
): Array<{ field: string; from: string | null; to: string | null }> {
  if (before === null) return []
  const changes: Array<{ field: string; from: string | null; to: string | null }> = []
  const push = (field: string, a: string | null, b: string | null): void => {
    if (a !== b) changes.push({ field, from: a, to: b })
  }
  push('provider', before.provider, after.provider)
  push('model', before.model, after.model)
  push('baseUrl', before.baseUrl, after.baseUrl)
  // MCP 服务器按**名字集合**比对（配置体可能很大，回执只需说清"增删了哪个"）。
  push('mcpServers', before.mcpServers.join(',') || null, after.mcpServers.join(',') || null)
  return changes
}

/**
 * 解析前端静态资源目录（T10）。
 *
 * 缺省推导：`dist/web` 相对**本文件编译产物**的位置往上找。但本仓库以 tsx
 * 直接跑 TS（无编译产物），所以更稳的是相对**仓库根**——由
 * `import.meta.url` 回溯：`src/server/index.ts` → `../../dist/web`。
 *
 * @returns 目录存在则返回绝对路径；不存在返回 `undefined`（调用方跳过托管）。
 */
function resolveWebRoot(explicit?: string): string | undefined {
  const candidate =
    explicit ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web')
  return existsSync(candidate) ? candidate : undefined
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const host = opts.host

  // ── 鉴权配置（T6）──
  // 解析顺序：显式 opts.apiKeys > 环境变量 LITE_AI_API_KEYS/LITE_AI_API_KEY >
  // 老形态 opts.secret（降级为单一身份）。
  let apiKeys: readonly ApiKeyEntry[] = opts.apiKeys ?? resolveApiKeysFromEnv(process.env)
  if (apiKeys.length === 0 && opts.secret !== undefined && opts.secret.length > 0) {
    // 老部署兼容：单个共享 secret → 映射成单一 userId（per-user 隔离随之退化，
    // 只挡"外人"、不区分"内部谁是谁"）。这里显式打日志，别让它静默发生。
    apiKeys = [{ key: opts.secret, userId: 'operator' }]
    console.warn(
      '[serve] 使用单 secret 形态（webhook.secret）：所有调用方共享身份 operator，' +
        'per-user 隔离不生效。要区分用户请配置 LITE_AI_API_KEYS="<key>:<userId>,..."。',
    )
  }

  // fail-closed：非回环绑定必须有 key，否则任何人可触发诊断（提权/RCE 面）。
  // 回环绑定允许**无 key 启动**（本机开发形态，Docker/k8s 探针也不需要凭证）。
  // ⚠️ 但「启动放行」≠「请求放行」：空 key 表下没有任何 key 能匹配，业务端点仍
  // 一律 401。这里必须把话说全，否则运维会以为本机无需配 key 就能用（见下面的 warn）。
  assertAuthConfigForBinding(host, apiKeys)
  if (apiKeys.length === 0) {
    console.warn(
      '[serve] 回环地址且未配置 API key：业务端点（/chat、/jobs、/usage、/sessions、/info、SSE）' +
        '**将一律返回 401**（fail-closed，即便回环也不静默放行）。' +
        '本机开发请用 LITE_AI_API_KEY=<key> 启动，并在前端「访问密钥」处填入同一个 key。',
    )
  }

  const { store, ready, dispose } = await selectStore(opts)

  // T7：用量 / 审计账本。与 job 队列**独立选择**（见 selectUsage 的说明）。
  const jobStoreIsPg = resolvePgConfigFromEnv(process.env) !== null
  const usage = selectUsage(opts, jobStoreIsPg)

  // ── T-obs：可观测性 sink（OTel → Langfuse，B 轨）──
  // 配置门控：无 LANGFUSE_* 凭据 / LITE_AI_TRACING=0 → noop，且**不加载 SDK**。
  // 与上面的 usage 是两条独立轨道：usage 是合规账本（自己查），tracing 是分析 sink。
  const tracing =
    opts.tracing ??
    (await createTracingSink({
      log: (level, message) => {
        if (level === 'error') console.error(message)
        else if (level === 'warn') console.warn(message)
        else console.log(message)
      },
    }))

  // T10：托管前端（若已构建）。缺失不是错误 —— 纯 API 部署照常工作。
  const webRoot = resolveWebRoot(opts.webRoot)

  // ── G7 告警摄入：与 /chat 同一进程、同一队列 ──
  // 诊断不再在管道自己的池里跑，而是落成 kind='alert' 的 job 由 Worker 认领，
  // 因此告警诊断自动获得 job 的一切：过程可见（SSE）、失败可重派、故障转移。
  const alerts =
    opts.alertIngest !== undefined
      ? { ingest: opts.alertIngest, dispose: async (): Promise<void> => {} }
      : opts.enableAlerts === false
        ? null
        : await createAlertIngest(store, opts.cwd)

  // 会话管理（第 1 档）：`/sessions` 的列表 / rename / fork 需要 SessionStore。
  // 与 exec 侧取的是**同一个** store（同一后端选择：file 或 pg），不会各挑一份。
  const { getSessionStore } = await import('../session.js')

  // ── 【T57】管理面（**默认关闭**） ──
  // 只有显式开启时才读一份配置快照（作为 reload 的比对基线）—— 关闭时零开销。
  const adminEnabled =
    opts.adminApiEnabled ?? process.env.LITE_AI_ENABLE_ADMIN_API === '1'
  let configSnapshot: RuntimeSnapshot | null = adminEnabled
    ? await readRuntimeSnapshot()
    : null

  const app = createServerApp({
    store,
    usage,
    sessions: getSessionStore(),
    cwd: opts.cwd,
    ready,
    auth: { keys: apiKeys },
    webRoot,
    abortSignal: opts.abortSignal,
    // 未启用告警形态时不传 → /webhook 明确 404（不是 200 空响应）。
    ...(alerts !== null ? { alertIngest: alerts.ingest } : {}),
    // ── 【T56】GET /info：实例自述 ──
    // 只暴露"这个实例装了什么"，供运维/前端一次问清。
    // ⚠️ 安全红线：`RuntimeConfig` 带 `authToken`/`apiKey` —— 这里**逐字段挑选**，
    // 绝不整体展开 runtime（那会把密钥 JSON 出去）。`cwd` 同理不外泄。
    info: async () => ({
      version: await readPackageVersion(),
      model:
        process.env.LITE_AI_MODEL_MODE === 'mock'
          ? 'mock'
          : (await readConfiguredModelName()) || null,
      provider: await readConfiguredProvider(),
      capabilities: {
        tracing: tracing.enabled,
        alerts: alerts !== null,
        // sessions 恒接线（上面的 getSessionStore()）—— 除非将来改成可选。
        sessions: true,
        // 内存账本重启即丢；只有配了 PG 才敢说"持久"。注入的实现无法在本层
        // 判断其内部，故以 PG 配置为准 —— 宁可低估，不可高估合规能力。
        usageDurable: jobStoreIsPg,
        static: webRoot !== undefined,
        admin: adminEnabled,
      },
      runtime: {
        node: process.versions.node,
        pid: process.pid,
        host: os.hostname(),
      },
    }),
    // ── 【T57】POST /admin/reload（默认关闭，显式开启才挂） ──
    // 如实报告：`changes` 是配置差异，`note` 说清**生效时机** —— 不假装全热更。
    ...(adminEnabled
      ? {
          admin: {
            reload: async () => {
              const next = await readRuntimeSnapshot()
              const changes = diffSnapshots(configSnapshot, next)
              configSnapshot = next
              return {
                reloaded: true,
                changes,
                note:
                  '配置已重读，新值已反映在 GET /info。已装配的模型 adapter 与工具集' +
                  '在**下次 job** 生效 —— 换 provider / 模型建议重启进程以彻底生效。',
              }
            },
          },
        }
      : {}),
  })

  // ── Worker 装配（T4）+ 执行器接线（T5）──
  // 真实执行器 = `createJobExecutor`：组装 runAgentTurn（唯一一份调查逻辑）
  // 并把回调翻译成 job_events。测试/嵌入方可用 `opts.execute` 覆盖。
  const execute = opts.execute ?? (await defaultExecute(store, opts.cwd, usage, tracing))
  const worker: Worker = createWorker({
    store,
    assignee: `${os.hostname()}-${process.pid}`,
    execute,
    pollMs: opts.workerPollMs,
  })
  worker.start()

  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(opts.port, host, () => {
      const addr = app.server.address()
      const shown =
        typeof addr === 'object' && addr !== null ? addr.port : opts.port
      console.log(`[serve] listening on http://${host}:${shown}`)
      console.log('[serve]   POST /chat            入队（202 + jobId）')
      console.log('[serve]   GET  /jobs/:id         状态 + 事件增量（?after=<seq>）')
      console.log('[serve]   GET  /jobs/:id/stream  SSE 事件流')
      console.log('[serve]   GET  /usage           用量 / 审计账本（T7）')
      console.log('[serve]   GET  /sessions        会话列表（per-user，按 job 归属过滤）')
      console.log('[serve]   POST /sessions/:id/rename|fork  重命名 / 分叉会话')
      console.log('[serve]   GET  /info            实例自述（版本 / 模型 / 能力开关）')
      if (adminEnabled) {
        console.log('[serve]   POST /admin/reload    重读配置（管理面；默认关闭）')
      }
      console.log(
        tracing.enabled
          ? '[serve]   tracing             Langfuse 已启用（OTel span → OTLP）'
          : `[serve]   tracing             未启用（${tracing.reason ?? 'noop'}）`,
      )
      console.log('[serve]   GET  /healthz /readyz  健康/就绪（免鉴权）')
      if (alerts !== null) {
        console.log(
          '[serve]   POST /webhook          告警摄入（入同一 jobs 队列，kind=alert）',
        )
      }
      console.log(`[serve]   worker ${os.hostname()}-${process.pid} 已启动（消费 jobs 队列）`)
      if (webRoot !== undefined) {
        console.log(`[serve]   GET  /                前端值班台（${webRoot}）`)
      } else {
        console.log(
          '[serve]   GET  /                未托管前端（dist/web 不存在；跑 `npm run build:web` 后重启）',
        )
      }
      resolve()
    })
  })

  return new Promise<void>(resolve => {
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      console.log('[serve] 收到退出信号，关闭 ...')
      // 顺序很重要：先停 claim（不再接新活），等在途 job 跑完，最后关连接与池。
      // 反过来的话，正在执行的 job 会被拦腰砍断，而它已经占着 running 状态，
      // 只能等租期超时才被回收 —— 白白浪费一次已完成的调查。
      worker.stop()
      app.server.close()
      app.server.closeAllConnections?.()
      void worker
        .drained()
        // T-obs 纪律 3：先把 Langfuse 缓冲 flush 出去再释放资源（否则最后一波 span 丢）。
        // 必须早于 dispose（关 PG 池）—— shutdown 里可能还要用网络导出。
        .then(() => tracing.shutdown())
        .then(() => dispose())
        .then(() => (alerts !== null ? alerts.dispose() : undefined))
        .then(() => resolve())
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    opts.abortSignal?.addEventListener('abort', shutdown, { once: true })
  })
}

/**
 * 【G7】装配告警摄入：告警 → 归一化 / 去重 / 关联 → 入**同一个 jobs 队列**。
 *
 * 与旧形态的唯一差别就在 `enqueueDiagnosis`：诊断不再在摄入管道自己的池里跑，
 * 而是落成 `kind='alert'` 的 job 交给 Worker。去重 / 关联这些**零 LLM 的规则判定**
 * 仍留在同步的 `ingest()` 里（HTTP 要立刻回 accepted/deduplicated）。
 */
async function createAlertIngest(
  store: JobStore,
  cwd: string,
): Promise<{
  ingest: (alerts: Alert[], ctx: IngestContext) => IngestResult
  dispose: () => Promise<void>
}> {
  const [{ IngestPipeline }, { loadWebhookConfig }, { alertSessionId }] =
    await Promise.all([
      import('../ingest/pipeline.js'),
      import('../config.js'),
      import('../webhook/types.js'),
    ])

  const config = await loadWebhookConfig()
  const pipeline = new IngestPipeline(cwd, config, {
    enqueueDiagnosis: (alert, incident, ctx) => {
      // sessionId 取 incidentId（事件级）或告警派生 id（单条）—— 与 diagnose 内部
      // 的口径一致，因此人工后续可用同一 sessionId 续问（"机器先查、人接着问"）。
      const sessionId = incident ? incident.incidentId : alertSessionId(alert)
      void store
        .create({
          userId: ctx?.userId ?? 'alertmanager',
          cwd,
          kind: 'alert',
          incidentId: incident?.incidentId ?? null,
          sessionId,
          payload: { alert, incident: incident ?? null },
        })
        .catch(err => {
          console.error(
            '[serve] 告警 job 入队失败:',
            err instanceof Error ? err.message : String(err),
          )
        })
    },
  })
  pipeline.start()

  return {
    ingest: (alerts, ctx) => pipeline.ingest(alerts, ctx),
    dispose: async () => {
      pipeline.close()
      await pipeline.drained()
    },
  }
}

export { MAX_BODY_BYTES, createServerApp }
export type { http }
