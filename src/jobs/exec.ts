/**
 * T5 执行接线 —— 把「唯一一份调查逻辑」（`runAgentTurn`）接进 Worker。
 *
 * 设计要点（对应 plan T5 / G2 / G3 / G4）：
 *
 * 1. **不改 `agent-loop.ts`**：本文件只做"组装入参 + 翻译回调"，调查逻辑仍是那一份。
 *    这保证了 CLI 与服务端跑的是**同一条推理链**，不存在"服务端另有实现"的漂移。
 *
 * 2. **事件是唯一的对外可见面**：前端通过 `/jobs/:id/stream` 看到的全部内容都来自
 *    `job_events`。因此 `onToolStart/onToolResult/onAssistantMessage` 必须**逐条翻译**，
 *    一条都不能吞 —— 吞掉的是运维在排障时唯一能看到的现场。
 *
 * 3. **批量写**：一次 turn 里工具事件可能上千条，逐条 IO 会把 DB 打爆。
 *    用内存缓冲按 `flushMs` 合并落库，但**结束前必须 flush 干净**（含失败路径）。
 *    批量只减少 IO 次数，**绝不减少事件条数**。
 *
 * 4. **G3 权限**：服务端没有交互通道。只读工具 auto-allow，`ask_user` 直接摘掉 ——
 *    留着它 agent 一问、无人可答，job 就永远卡在 running 直到租期超时才被回收。
 *
 * 5. **G2 续接**：执行前 `load` 历史、执行后 `save` 回**同一 session**，
 *    这样 `diagnose` 落下的告警会话可以被人工直接接管续问（"机器先查、人接着问"）。
 */
import { ToolRegistry } from '../tool.js'
import type { ChatMessage, ModelAdapter } from '../types.js'
import type { JobStore } from './store.js'
import type { Job } from './types.js'
import type { SessionStore } from '../session/store.js'
import type { PermissionManager } from '../permissions.js'

/**
 * 事件批量落库的窗口（毫秒）。窗口内累积的事件一次写库。
 * 取 50ms：比一次 LLM 流式 chunk 间隔还小，用户感知不到延迟，又能把
 * 一次 turn 里几十上百条工具事件压成个位数 IO。
 */
export const DEFAULT_EVENT_FLUSH_MS = 50

/** 单批最多落多少条（防止长 turn 一次攒出巨大 batch）。 */
export const DEFAULT_EVENT_FLUSH_SIZE = 200

/** `runAgentTurn` 的可注入替身签名（测试注入假 runner，生产用真的）。 */
export type TurnRunner = (args: {
  model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
  maxSteps?: number
  modelName?: string
  onToolStart?: (toolUseId: string, toolName: string, input: unknown) => void
  onToolResult?: (toolUseId: string, toolName: string, output: string, isError: boolean) => void
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
  signal?: AbortSignal
}) => Promise<ChatMessage[]>

export type JobExecutorDeps = {
  /** job 事件要写到这里。 */
  jobStore: JobStore
  /** 会话历史读取/回写（G2）。 */
  sessionStore: SessionStore
  /** 服务端工作区路径（G4）——**不是**用户本地目录。 */
  cwd: string
  /**
   * 模型。可传实例（测试），也可传**工厂**（生产）——工厂形态让"服务启动"
   * 与"模型客户端建立"解耦：模型配置错误不该让 `/healthz` 起不来，
   * 而应在真正跑 job 时报错并落 failed。
   */
  model: ModelAdapter | ((args: { tools: ToolRegistry }) => Promise<ModelAdapter>)
  /** 工具集；缺省由 `buildServiceToolRegistry` 从 cwd 构建。 */
  tools?: ToolRegistry
  /** 权限管理器；缺省用 `buildServicePermissions(cwd)`。 */
  permissions?: PermissionManager
  /** turn runner；缺省懒加载真实 `runAgentTurn`（避免测试拉起整个 agent 栈）。 */
  turnRunner?: TurnRunner
  /** 最大工具步数，默认 200（与 diagnose 对齐）。 */
  maxSteps?: number
  /** 模型名（写入 trace / 事件元数据）。 */
  modelName?: string
  /** 事件批量落库窗口。 */
  flushMs?: number
  /** 单批事件上限。 */
  flushSize?: number
  /** cwd 注入（覆盖 deps.cwd，用于 job 自带 cwd 的场景）。 */
  cwdForJob?: (job: Job) => string
  /** 结构化日志。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** 执行器：给 Worker 直接当 `execute` 用。 */
export type JobExecutor = (job: Job) => Promise<void>

/**
 * 服务端权限策略（G3）：**所有权限请求一律放行一次**。
 *
 * 为什么敢全放行：服务端的工具集本身已被 `buildServiceToolRegistry` 收窄到只读子集
 * （沿用 webhook 只读通道的做法）。权限层在这里的作用不是"再挡一道"，
 * 而是**不阻塞** —— 没有交互通道时，任何需要询问的请求都只能等于拒绝或挂死。
 */
export async function buildServicePermissions(cwd: string): Promise<PermissionManager> {
  const { PermissionManager } = await import('../permissions.js')
  const permissions = new PermissionManager(cwd, async () => ({
    decision: 'allow_once' as const,
  }))
  await permissions.whenReady()
  return permissions
}

/** 服务端**禁用**的工具（不是"收窄"，是"直接摘掉"）。 */
const SERVER_DISABLED_TOOLS = new Set(['ask_user'])

/**
 * 从给定注册表派生服务端注册表：摘掉禁用工具，其余原样保留（含 metadata 与 disposer）。
 *
 * 为什么重建而不是原地改：`ToolRegistry` 没有 remove 接口 —— 原地删会动到
 * 调用方（诊断通道）持有的同一个对象，产生意外的跨用途污染。派生的新实例是隔离的。
 */
export function buildServiceToolRegistry(args: {
  cwd: string
  tools?: ToolRegistry
}): ToolRegistry {
  if (args.tools === undefined) {
    // 无工具可派生时给一个空注册表（fail-closed：宁可不给工具，也不放错工具进来）。
    return new ToolRegistry([])
  }
  const kept = args.tools.list().filter(tool => !SERVER_DISABLED_TOOLS.has(tool.name))
  const derived = new ToolRegistry(kept, {
    skills: args.tools.getSkills(),
    mcpServers: args.tools.getMcpServers(),
  })
  // MCP 连接等资源需要在 turn 结束后释放 —— 派生注册表必须继承原注册表的 disposer，
  // 否则 turn 结束不会断开连接，长跑服务会泄漏。
  const withDisposers = args.tools as unknown as {
    disposers?: Array<() => Promise<void>>
  }
  for (const dispose of withDisposers.disposers ?? []) {
    derived.addDisposer(dispose)
  }
  return derived
}

/** 从 job 取本轮要处理的用户消息。 */
function jobMessage(job: Job): string {
  const raw = job.payload?.message
  return typeof raw === 'string' ? raw : ''
}

/**
 * 创建执行器。
 *
 * 返回的函数即 Worker 的 `execute`：**它自己不管终态** —— 落 `completed` / `failed`
 * 是 Worker 的职责（`worker.ts`）。这里只负责"跑完这一轮 + 事件与会话落库"，
 * 出错就原样抛给 Worker，让终态只在一处写。
 */
export function createJobExecutor(deps: JobExecutorDeps): JobExecutor {
  const log = deps.log ?? ((): void => {})
  const flushMs = deps.flushMs ?? DEFAULT_EVENT_FLUSH_MS
  const flushSize = deps.flushSize ?? DEFAULT_EVENT_FLUSH_SIZE

  return async function executeJob(job: Job): Promise<void> {
    const cwd = deps.cwdForJob ? deps.cwdForJob(job) : deps.cwd

    // ── G2：取历史（带 sessionId 才取；刻意不校验会话是否已存在，
    //         以便对 diagnose 落下的告警会话直接续接） ──
    let history: ChatMessage[] = []
    if (job.sessionId !== null) {
      const loaded = await deps.sessionStore.load(cwd, job.sessionId)
      if (loaded !== null) history = loaded
    }
    const business: ChatMessage[] = [
      ...history,
      { role: 'user', content: jobMessage(job) },
    ]

    const tools =
      deps.tools ??
      (await buildServiceToolRegistryAsync({ cwd }))
    const permissions = deps.permissions ?? (await buildServicePermissions(cwd))

    // ── 事件缓冲（批量写） ──
    let pending: Array<{ kind: string; payload: Record<string, unknown> }> = []
    let flushing: Promise<void> = Promise.resolve()
    let closed = false

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      // 串行化：避免多个 flush 并发落库时 seq 交错（内存实现虽同步，
      // 但 PG 实现下并发 append 无法保证会话内事件顺序与产生顺序一致）。
      flushing = flushing.then(async () => {
        // 优先走批量 API（一次往返写完整批）；实现未提供时回退逐条。
        if (typeof deps.jobStore.appendEvents === 'function') {
          await deps.jobStore.appendEvents(job.id, batch)
          return
        }
        for (const evt of batch) {
          await deps.jobStore.appendEvent(job.id, evt.kind, evt.payload)
        }
      })
      await flushing
    }

    const push = (kind: string, payload: Record<string, unknown>): void => {
      if (closed) return
      pending.push({ kind, payload })
      if (pending.length >= flushSize) {
        void flush().catch(err => {
          log('error', `[exec] ${job.id} 事件落库失败: ${String(err)}`)
        })
      }
    }

    const timer = setInterval(() => {
      void flush().catch(err => {
        log('error', `[exec] ${job.id} 事件落库失败: ${String(err)}`)
      })
    }, flushMs)
    timer.unref?.()

    const runner = deps.turnRunner ?? (await resolveRealTurnRunner())
    const model =
      typeof deps.model === 'function' ? await deps.model({ tools }) : deps.model

    let finalMessages: ChatMessage[] = business
    try {
      finalMessages = await runner({
        model,
        tools,
        messages: business,
        cwd,
        permissions,
        maxSteps: deps.maxSteps ?? 200,
        modelName: deps.modelName ?? '',
        onToolStart: (toolUseId, toolName, input) => {
          push('tool_start', { toolUseId, toolName, input })
        },
        onToolResult: (toolUseId, toolName, output, isError) => {
          push('tool_result', { toolUseId, toolName, output, isError })
        },
        onAssistantMessage: (content, metadata) => {
          push('assistant_message', { content, final: metadata?.final === true })
        },
        onProgressMessage: content => {
          push('progress', { content })
        },
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      push('error', { message: reason })
      // 失败也要**尽力落盘**：留一个可 resume 的会话，值班员接着查。
      // 这里用 catch 吞掉落盘失败 —— 原始报错才是要抛给 Worker 的那个。
      await persistSession(deps, cwd, job, finalMessages, log).catch(() => {})
      closed = true
      clearInterval(timer)
      await flush().catch(() => {})
      throw error
    }

    closed = true
    clearInterval(timer)
    await flush()

    // ── G2：回写同一 session（保留 append-only 语义） ──
    await persistSession(deps, cwd, job, finalMessages, log)
  }
}

/** 懒加载真实 `runAgentTurn`（测试注入 runner 时完全不加载 agent 栈）。 */
async function resolveRealTurnRunner(): Promise<TurnRunner> {
  const mod = await import('../agent-loop.js')
  return mod.runAgentTurn as unknown as TurnRunner
}

/**
 * 懒加载服务端工具集（需要 MCP 连接等异步装配）。
 *
 * 复用 webhook 只读通道的 `createWebhookDiagnosisToolRegistry`：它已排除
 * run_command / web_fetch / web_search 与一切写类工具，只留只读数据源查询、
 * tail_logs、历史事故检索与 load_skill（外加只读 MCP 工具）。
 * 服务端与告警自动诊断共用同一子集 —— 语义一致，不引入第二套白名单。
 * 再经 `buildServiceToolRegistry` 摘掉 `ask_user`。
 */
async function buildServiceToolRegistryAsync(args: {
  cwd: string
}): Promise<ToolRegistry> {
  const { loadRuntimeConfig } = await import('../config.js')
  const { createWebhookDiagnosisToolRegistry } = await import('../tools/index.js')
  const runtime = await loadRuntimeConfig().catch(() => null)
  const registry = await createWebhookDiagnosisToolRegistry({
    cwd: args.cwd,
    runtime,
  })
  return buildServiceToolRegistry({ cwd: args.cwd, tools: registry })
}

/** 会话回写：sessionId 缺省时用 job.id 兜底（保证任何 job 都能被复盘）。 */
async function persistSession(
  deps: JobExecutorDeps,
  cwd: string,
  job: Job,
  messages: ChatMessage[],
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  const sessionId = job.sessionId ?? `job-${job.id}`
  // system prompt 不进会话（与 diagnose / CLI 一致：会话是可 resume 的业务对话）。
  const persistable = messages.filter(m => m.role !== 'system')
  try {
    await deps.sessionStore.save(cwd, sessionId, persistable)
  } catch (error) {
    log('error', `[exec] ${job.id} 会话回写失败（${sessionId}）: ${String(error)}`)
    throw error
  }
}
