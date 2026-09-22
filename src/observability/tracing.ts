/**
 * T-obs：可观测性扇出（OTel → Langfuse）—— **抽象层**。
 *
 * ## 这一层解决什么
 *
 * plan 的可观测性决策是「**单埋点 → 双 sink**」：
 *
 * ```
 * exec.ts  onToolStart / onToolResult / onAssistantMessage / onProgressMessage
 *    ├─→ job_events (JobStore/PG)  ──→ SSE ──→ 前端     （真相源，G5 持久化 + 跨实例）
 *    └─→ OTel span                ──→ OTLP ──→ Langfuse （分析 sink，可延迟/可挂）
 * ```
 *
 * A 轨（`job_events`）已经落地；本模块负责 **B 轨的接线与纪律**。
 *
 * ## 为什么先抽一层接口，而不是直接在 `exec.ts` 里 import Langfuse
 *
 * 1. **纪律 4「不做过度工程」**：开发/CI 环境没有 Langfuse 凭据，SDK 不该被加载。
 *    接口 + 门控让"没配 key"时**一行 SDK 代码都不执行**（`createTracingSink` 走 noop，
 *    `langfuse-sink.ts` 只在动态 import 里出现）。
 * 2. **纪律 2「tracing 必须 error-safe」**：`exec.ts` 只调这个接口。真实实现里的
 *    每一次 SDK 调用都包了 try/catch —— 观测失败最多丢一个 span，**绝不影响调查**。
 * 3. **可测**：单测注入假 sink 断言"扇出被调用"，不必真起 OTLP 导出器。
 *    这也让"Langfuse 挂掉调查照跑"这条纪律**能被自动化验证**，而不是靠人工相信。
 *
 * ## 方向单向（纪律 1）
 *
 * 本模块**只出、不入**：没有任何读取 Langfuse 的 API。实时 UX 的真相源永远是
 * `job_events`（PG 表 + `server/http.ts` 的 SSE 订阅端点）。反过来，
 * **Langfuse 不可作实时 UX 源** —— 它走异步 OTLP 导出，可见性有分钟级延迟，
 * 且本模块按规定不提供任何查询接口。
 *
 * （此处原写作「`job_events` 读端点延迟约 10 分钟、且无 SSE 订阅端点，不可作 UX 源」
 * ——那是把 Langfuse 的性质安到了 `job_events` 头上，与同段前半句自相矛盾，已更正。）
 *
 * ## 跨进程链路关联：本仓**并存两套 traceId**（刻意的，不是疏漏）
 *
 * OTel 的 `traceId` 是 32 位十六进制。lite-ai 的 `jobId`（`job-<uuid>`）不是合法
 * traceId，所以这里用 `deriveTraceId(jobId)` **确定性派生**（sha256 → 前 32 hex）：
 * 任何拿到 jobId 的地方（HTTP / Worker / exec / 审计回查）都能重算出同一个
 * traceId，**无需新增 schema 列**。
 *
 * ⚠️ 另一套在 `server/trace.ts:40 traceIdForJob` —— `tr-<jobId>`，**取值与本函数
 * 不相等**（`tr-job-x` ≠ sha256 的 32 hex），别误以为两处指的是同一个东西。
 * 并存是刻意的：
 *   - **本函数（32 hex）**：OTel 规范强制该格式，且要与上游 `traceparent` 接得上；
 *   - **`traceIdForJob`（`tr-` 前缀）**：① 日志里可 `grep 'tr-'` 一眼识别；
 *     ② 能被 `jobIdFromTrace()` **反解**回 jobId（审计回查用）。
 * 想"统一成一套"的两个方向都不划算：让 OTel 用 `tr-` 前缀违反规范；让审计账本
 * 改用 32 hex 会**废掉反解能力**（`test/server/trace.test.ts` 与 3 个 e2e 都钉着它）。
 * 跨轨对账请一律走 **jobId**（三轨都持有），别指望两个 traceId 能直接 join。
 *
 * 若上游 HTTP 请求带了 W3C `traceparent`（`00-<32hex>-<16hex>-<2hex>`），则沿用其
 * traceId（`parseTraceparent`），让 Langfuse 的树接到上游调用链上。
 */
import crypto from 'node:crypto'

/**
 * 一次 LLM 调用的用量事实（由 `agent-loop.ts` 的 `onLlmCall` 透传）。
 *
 * 字段**全部可选**：`MockModelAdapter` 无真实 usage，provider 也可能不回传
 * （见 plan 纪律 4）。缺字段时下游**不得报错**，只能少写几个 attribute。
 */
export type LlmCallEvent = {
  model?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  latencyMs?: number
  stopReason?: string
  error?: string
}

/** 开启一条 job trace 所需的上下文。 */
export type JobTraceInfo = {
  jobId: string
  /** job 类型（`chat` / `alert`），进 trace 名与 metadata。 */
  kind: string
  /** 会话 id（`/chat` 为 `sin-<uuid>`；告警为 incidentId / alertSessionId）。 */
  sessionId: string | null
  /** 归属用户（T6 鉴权身份；告警缺省 `alertmanager`）。 */
  userId?: string | null
  /** 上游 W3C traceparent（可选）：给了就沿用其 traceId，把本段接到上游调用链。 */
  traceparent?: string | null
  /** trace 名，缺省 `job:<kind>`。 */
  name?: string
}

/** trace 收尾事实。 */
export type JobTraceEnd = {
  status?: 'ok' | 'error'
  error?: string
  output?: unknown
}

/**
 * 一条 job trace 的句柄。
 *
 * **契约（实现者必须遵守）**：所有方法**永不抛错**。这些方法在 `exec.ts` 的
 * 事件回调里被同步调用，一旦抛错就会沿着 `runAgentTurn` 的回调链把整轮调查打挂
 * ——那正是纪律 2 要防的事。实现内部的 SDK 调用必须各自包 try/catch 并静默降级。
 */
export interface JobTrace {
  toolStart(toolUseId: string, toolName: string, input: unknown): void
  toolEnd(toolUseId: string, toolName: string, output: string, isError: boolean): void
  generation(record: LlmCallEvent): void
  event(name: string, payload?: Record<string, unknown>): void
  end(result?: JobTraceEnd): void
}

/** 可观测性 sink。缺省/无凭据时为 noop（`enabled === false`）。 */
export interface TracingSink {
  readonly enabled: boolean
  /**
   * 当前状态的人类可读原因（noop 时说明为什么）。
   * 启动日志打印它，避免"以为接了 Langfuse 其实没接"的静默偏差。
   */
  readonly reason?: string
  startJobTrace(info: JobTraceInfo): JobTrace
  /** 把缓冲的 span 刷出去（纪律 3：SIGTERM 关闭序列里调用）。**永不抛错**。 */
  flush(): Promise<void>
  /** 优雅关停（flush + 释放）。纪律 3：挂在 `dispose` 之前。**永不抛错**。 */
  shutdown(): Promise<void>
}

/** Langfuse 凭据（从环境变量解析）。 */
export type TracingCredentials = {
  publicKey: string
  secretKey: string
  /** 自托管实例地址；缺省走 Langfuse 云。注意环境变量名是 `LANGFUSE_BASE_URL`。 */
  baseUrl?: string
  environment?: string
  release?: string
}

// ───────────────────────────── traceId / spanId 工具 ─────────────────────────────

/**
 * 从 jobId **确定性派生** OTel traceId（32 位十六进制）。
 *
 * 取 sha256 前 128 bit：既满足 OTel 对 traceId 的格式要求（32 hex），又保持
 * "同 jobId 必同 traceId"——HTTP 层、Worker、exec、审计回查都能各自算出同一个值。
 */
export function deriveTraceId(jobId: string): string {
  return crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 32)
}

/** 随机 spanId（16 位十六进制）。用于 root span；子 span 由 SDK 自行分配。 */
export function randomSpanId(): string {
  return crypto.randomBytes(8).toString('hex')
}

/** 解析后的 W3C trace 上下文。 */
export type ParsedTraceparent = {
  traceId: string
  spanId: string
  traceFlags: number
}

/**
 * 解析 W3C `traceparent` 头。
 *
 * 严格按规范校验：`<version 2hex>-<traceId 32hex>-<spanId 16hex>-<flags 2hex>`，
 * 且 traceId / spanId **不得全零**。任何不符一律返回 `null`（调用方退化为派生 traceId），
 * **不抛错** —— 一个畸形头不该让调查起不来。
 */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (typeof header !== 'string') return null
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    header.trim().toLowerCase(),
  )
  if (match === null) return null
  const traceId = match[1]!
  const spanId = match[2]!
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null
  return { traceId, spanId, traceFlags: Number.parseInt(match[3]!, 16) }
}

/** 序列化为 W3C `traceparent` 头（跨进程传播用）。 */
export function formatTraceparent(ctx: ParsedTraceparent, version = '00'): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, '0')
  return `${version}-${ctx.traceId}-${ctx.spanId}-${flags}`
}

// ───────────────────────────── noop 实现 ─────────────────────────────

/** 共享的 noop job trace（无状态，可安全复用同一实例）。 */
const NOOP_JOB_TRACE: JobTrace = {
  toolStart: () => {},
  toolEnd: () => {},
  generation: () => {},
  event: () => {},
  end: () => {},
}

/** 创建一个 noop sink（不导出任何 span）。 */
export function createNoopTracingSink(reason = 'noop'): TracingSink {
  return {
    enabled: false,
    reason,
    startJobTrace: () => NOOP_JOB_TRACE,
    flush: async () => {},
    shutdown: async () => {},
  }
}

// ───────────────────────────── 门控与装配 ─────────────────────────────

/**
 * 从环境变量解析 Langfuse 凭据。
 *
 * 两个 key **都**要给齐才算"配置了"：只给一个（常见的把 secret 写进 env、public
 * 忘了写）时返回 `null` → 降级 noop，而不是带着半套凭据启动、每次导出都 401 刷屏。
 *
 * 环境变量名以 `@langfuse/otel` 的 `LangfuseSpanProcessorParams` 定义为准：
 * `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`
 * （注意是 `BASE_URL`，带下划线；`LANGFUSE_BASEURL` 不是它认的名字）。
 */
export function resolveTracingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): TracingCredentials | null {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (publicKey === undefined || publicKey === '' || secretKey === undefined || secretKey === '') {
    return null
  }
  const baseUrl = env.LANGFUSE_BASE_URL?.trim()
  const environment = env.LANGFUSE_TRACING_ENVIRONMENT?.trim()
  const release = env.LANGFUSE_RELEASE?.trim()
  return {
    publicKey,
    secretKey,
    ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}),
    ...(environment !== undefined && environment !== '' ? { environment } : {}),
    ...(release !== undefined && release !== '' ? { release } : {}),
  }
}

/**
 * 装配 tracing sink（配置门控）。
 *
 * 判定顺序（任一不满足即降级 noop，**且不加载 SDK**）：
 * 1. `LITE_AI_TRACING=0` → 显式关闭（给人一个"临时关掉"的开关，不用去删 key）
 * 2. 缺 Langfuse 凭据 → noop（开发/CI 的常态路径）
 * 3. 动态 import 真实 sink 失败（依赖未装 / 加载报错）→ noop + 告警
 *
 * 真实 sink 走**动态 import**：这样"没配 key"的进程里，`@langfuse/*` 与
 * `@opentelemetry/*` 一行都不会被求值——依赖装了也不产生启动开销与副作用。
 */
export async function createTracingSink(
  opts: {
    env?: NodeJS.ProcessEnv
    log?: (level: 'info' | 'warn' | 'error', message: string) => void
  } = {},
): Promise<TracingSink> {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((): void => {})

  if (env.LITE_AI_TRACING === '0') {
    return createNoopTracingSink('disabled-by-env')
  }

  const credentials = resolveTracingCredentials(env)
  if (credentials === null) {
    return createNoopTracingSink('no-langfuse-credentials')
  }

  try {
    const mod = await import('./langfuse-sink.js')
    return await mod.createLangfuseTracingSink({ credentials, log })
  } catch (error) {
    // 依赖缺失/加载失败**不是**致命错误：可观测性是增强，不是主链路。
    // 但必须显式喊出来，别让运维以为 span 正在上报。
    log(
      'warn',
      `[tracing] Langfuse sink 加载失败，降级为 no-op（调查不受影响）：${String(error)}`,
    )
    return createNoopTracingSink('sdk-load-failed')
  }
}
