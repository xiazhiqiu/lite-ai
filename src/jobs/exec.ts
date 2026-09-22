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
import type { ChatMessage, CompressionResult, ModelAdapter } from '../types.js'
import type { SnipCompactResult } from '../compact/snipCompact.js'
import type { ContextCollapseResult } from '../compact/context-collapse.js'
import type { JobStore } from './store.js'
import type { Job } from './types.js'
import type { SessionStore } from '../session/store.js'
import type { PermissionManager } from '../permissions.js'
import type { UsageStore } from '../usage/index.js'
import type { Alert, Incident } from '../webhook/types.js'
import { traceIdForJob } from '../server/trace.js'
import {
  createNoopTracingSink,
  type JobTrace,
  type LlmCallEvent,
  type TracingSink,
} from '../observability/tracing.js'

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
  /** 【T-obs】LLM 调用用量回调（透传给 `runAgentTurn`）。 */
  onLlmCall?: (record: LlmCallEvent) => void
  /**
   * 【T55】上下文压缩可见性。TTY 形态早已展示（`tty-app.ts` 的三个同名回调），
   * 服务端此前**一条都没接** —— 值班台只能看到 token 数在动，看不到"上下文被压缩"。
   * 这三个回调把压缩事实透出成 `context_compacted` 事件（见 emitAutoCompact 等）。
   */
  onAutoCompact?: (result: CompressionResult) => void | Promise<void>
  onSnipCompact?: (result: SnipCompactResult) => void | Promise<void>
  onContextCollapse?: (result: ContextCollapseResult) => void | Promise<void>
  signal?: AbortSignal
}) => Promise<ChatMessage[]>

/**
 * 【G7】告警诊断执行器签名（与 `runAlertDiagnosis` 的参数面对齐）。
 *
 * 刻意**不**复用上面的 `TurnRunner`：告警诊断走 `runAlertDiagnosis` 这条既有链路
 * （自带事件包构造 / 会话落盘 / 告警记录 / 通知），与人工对话的组装方式不同。
 * 可注入让测试能验证"告警 job 被执行 + 事件落库"而不真烧 token。
 */
export type AlertDiagnoser = (args: {
  cwd: string
  alert: Alert
  incident?: Incident
  deps?: {
    onToolStart?: (toolUseId: string, toolName: string, input: unknown) => void
    onToolResult?: (
      toolUseId: string,
      toolName: string,
      output: string,
      isError: boolean,
    ) => void
    onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
    onProgressMessage?: (content: string) => void
    /** 【T-obs】LLM 调用用量回调（透传给 `runAgentTurn`）。 */
    onLlmCall?: (record: LlmCallEvent) => void
  }
}) => Promise<{ sessionId: string; diagnosisSummary: string }>

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
  /**
   * 【G7】告警诊断执行器；缺省懒加载真实 `runAlertDiagnosis`。
   * 仅 `kind='alert'` 的 job 用到；chat job 走上面的 `turnRunner`。
   */
  alertDiagnoser?: AlertDiagnoser
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
  /**
   * 用量 / 审计账本（T7）。**不传 = 不记账**（单测与 CLI 场景不需要）。
   *
   * 记账点刻意放在执行器而**不是** Worker：只有执行器知道这一轮的 token 与耗时，
   * Worker 只看见"成功/失败"。而 Worker 负责的是终态落库 —— 两者职责不重叠。
   */
  usage?: UsageStore
  /** 结构化日志。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * 【T-obs】可观测性 sink（OTel → Langfuse）。**不传 = 不导出 span**。
   *
   * 与 `usage`（T7 本地审计台账）是**两条独立轨道**：`usage` 是合规账本（自己查，
   * 落 PG），`tracing` 是分析 sink（外部系统看成本/延迟/质量/eval）。互不替代。
   *
   * 扇出点就在本文件：`job_events` 与 span **同时** emit，方向单向（见 tracing.ts）。
   */
  tracing?: TracingSink
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
 * 【G7】从 alert job 的 payload 还原告警（与可选事件）。
 *
 * payload 由 IngestPipeline 入队时写入，经 PG 后会走一轮 JSON 序列化 ——
 * 因此这里按"纯 JSON 对象"处理（`Incident` 的 `reasons` 是数组而非 Set，可安全往返）。
 * 缺 alert 直接抛错：宁可让这条 job 明确 failed，也不要静默跑一个空诊断。
 */
function parseAlertPayload(payload: Record<string, unknown>): {
  alert: Alert
  incident?: Incident
} {
  const alert = payload.alert as Alert | undefined
  if (alert === undefined || alert === null || typeof alert !== 'object') {
    throw new Error('alert job 的 payload 缺少 alert 对象')
  }
  const incident = payload.incident as Incident | undefined
  return incident ? { alert, incident } : { alert }
}

/** 懒加载真实 `runAlertDiagnosis`（测试注入 diagnoser 时完全不加载 agent 栈）。 */
async function resolveRealAlertDiagnoser(): Promise<AlertDiagnoser> {
  const mod = await import('../webhook/diagnose.js')
  return mod.runAlertDiagnosis as unknown as AlertDiagnoser
}

/**
 * 记账：往审计账本追加一条本轮的用量事实（T7）。
 *
 * **两条硬约束**：
 * 1. **本函数永不抛错**。审计写失败不能把"已经跑成功的 job"变成 failed ——
 *    审计库抖动导致全站调查挂掉是可用性灾难（见 `usage/store.ts` 的模块注释）。
 *    所以这里 catch 并降级为错误日志，把"账本缺一条"这件事实**显式喊出来**，
 *    而不是静默吞掉（静默吞掉就违背了可追溯的初衷）。
 * 2. **模型名从实际使用的 adapter 取，取不到就落 null**。不猜、不用占位串 ——
 *    `null` 诚实地表示"这一轮的模型未知"，而 `'unknown'` 会被下游当成一个真实模型名统计。
 */
async function recordUsage(
  deps: JobExecutorDeps,
  job: Job,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  args: {
    modelName: string | null
    durationMs: number
    status: 'completed' | 'failed'
    /** 本轮 LLM 调用的 token 累积（缺省 0 = provider 未回传 usage）。 */
    inputTokens?: number
    outputTokens?: number
  },
): Promise<void> {
  if (deps.usage === undefined) return
  try {
    await deps.usage.record({
      userId: job.userId,
      jobId: job.id,
      sessionId: job.sessionId,
      // traceId 由 jobId 派生（T7-a）：一次调查一条 trace，任何拿到 jobId
      // 的地方都能重算，不需要在 jobs 表加列、也不需要在这里生成再存。
      traceId: traceIdForJob(job.id),
      model: args.modelName,
      // token 来自本轮 onLlmCall 的累积（见 emitLlmCall）。provider 未回传
      // usage 时保持 0 —— 仍然**不编造数字**。
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      durationMs: args.durationMs,
      status: args.status,
    })
  } catch (error) {
    log(
      'error',
      `[exec] ${job.id} 用量记账失败（审计账本缺一条，job 本身不受影响）: ${String(error)}`,
    )
  }
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
    // 记账用起点。放在最前（含读历史/建工具集的耗时）—— 审计关心的是
    // "这次调查占用了多久"，而不是"纯推理花了多久"。
    const startedAt = Date.now()

    // ── 事件缓冲（批量写） ──
    // 刻意提到 kind 分派**之前**：alert 与 chat 两条分支共用同一套落库与 flush
    // 语义，"结束前必须 flush 干净（含失败路径）"这条纪律才有单一实现，
    // 不会在将来加第三条分支时被漏掉。
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

    // ── T-obs：可观测性扇出（B 轨）──
    // 与上面的 `job_events`（A 轨，真相源）**并行** emit：A 轨给前端 SSE，
    // B 轨给 Langfuse 分析。方向单向 —— 这里只写不读，绝不拿 Langfuse 当事件源（纪律 1）。
    const trace: JobTrace = startJobTrace(deps, job)
    // 所有 trace 调用再包一层 try/catch：实现侧已自带 error-safe，这里防的是
    // 「注入的假 sink 不守约」或「将来换实现时退化」——观测失败绝不能让 job failed。
    const traced = (fn: () => void): void => {
      try {
        fn()
      } catch (error) {
        log('warn', `[exec] ${job.id} tracing 扇出失败（不影响调查）: ${String(error)}`)
      }
    }
    // 四个 emit helper = 「落 job_events」+「扇出 span」的单一实现。
    // chat / alert 两条分支共用它们，避免将来加第三条分支时漏接一轨。
    const emitToolStart = (toolUseId: string, toolName: string, input: unknown): void => {
      push('tool_start', { toolUseId, toolName, input })
      traced(() => trace.toolStart(toolUseId, toolName, input))
    }
    const emitToolResult = (
      toolUseId: string,
      toolName: string,
      output: string,
      isError: boolean,
    ): void => {
      push('tool_result', { toolUseId, toolName, output, isError })
      traced(() => trace.toolEnd(toolUseId, toolName, output, isError))
    }
    const emitAssistantMessage = (content: string, metadata?: { final?: boolean }): void => {
      push('assistant_message', { content, final: metadata?.final === true })
      traced(() =>
        trace.event('assistant_message', {
          final: metadata?.final === true,
          content: content.length > 2000 ? `${content.slice(0, 2000)}…` : content,
        }),
      )
    }
    const emitProgress = (content: string): void => {
      push('progress', { content })
      traced(() => trace.event('progress', { content }))
    }
    // ── 一轮 job 的用量累积（T-obs 尾差修复）──
    // `onLlmCall` 每次调用都带回 provider 的 usage；这里累加成整轮总量，收尾时落进
    // 审计账本（recordUsage）。此前账本硬编码 0，注释写着「等 runner 把 usage 透传
    // 上来再填」—— T-obs 加的这个回调已经把它透出来了，只是没接上。
    // 纪律不变：只有 provider **真给了数字**才累加，缺字段不强加（不编造）。
    let llmInputTokens = 0
    let llmOutputTokens = 0
    let llmModel: string | null = null
    const emitLlmCall = (record: LlmCallEvent): void => {
      if (typeof record.inputTokens === 'number') llmInputTokens += record.inputTokens
      if (typeof record.outputTokens === 'number') llmOutputTokens += record.outputTokens
      // 取最后一次调用的模型名：一轮内通常同一模型；若中途换了，记最终生效的那个。
      if (typeof record.model === 'string' && record.model !== '') llmModel = record.model
      traced(() => trace.generation(record))
    }

    // ── 【T55】上下文压缩可见性（L1 snip / L2 collapse / L3 compact） ──
    // 与 T-obs 同一条纪律：**只落压缩器给出的事实**，不在此重算 token。
    // 压缩是"静默偷走上下文"的操作：不透明化会让运维误判 agent 的记忆边界
    // （"我明明讲了三遍，它怎么还是忘了" —— 因为 snip 把那几条摘掉了）。
    const emitAutoCompact = (result: CompressionResult): void => {
      push('context_compacted', {
        level: 'compact',
        removedCount: result.removedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
    }
    const emitSnipCompact = (result: SnipCompactResult): void => {
      // 没真剪（didSnip=false）不报 —— 否则每次巡检都刷一条零信息噪音。
      if (!result.didSnip) return
      push('context_compacted', {
        level: 'snip',
        removedCount: result.removedMessageIds.length,
        tokensFreed: Math.round(result.tokensFreed),
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
    }
    const emitContextCollapse = (result: ContextCollapseResult): void => {
      // 同理：collapsed=false 是"检查过但没折"，不是一个发生过的动作。
      if (!result.collapsed) return
      // `ContextCollapseResult` 自身不带 token（只有 span 带）——取本次生效的那个。
      const span = result.span ?? result.spans[result.spans.length - 1]
      push('context_compacted', {
        level: 'collapse',
        ...(span === undefined
          ? {}
          : {
              removedCount: span.messageIds.length,
              tokensBefore: span.tokensBefore,
              tokensAfter: span.tokensAfter,
              reason: span.reason,
            }),
      })
    }

    // ── G7：告警诊断分支（kind='alert'，由 IngestPipeline 入队） ──
    //
    // 关键差异：告警诊断走**既有的** `runAlertDiagnosis` 链路 —— 它自带
    // 「事件包构造（主告警 + 全部成员）/ 会话落盘 / 告警记录 / 通知」，
    // 这些是告警语义的一部分，不能在服务端另写一套（否则又是两条 divergent 口径）。
    // 因此这里**不**复用上面的 tools/model，让 diagnose 内部按自己的工具集装配。
    if (job.kind === 'alert') {
      const { alert, incident } = parseAlertPayload(job.payload)
      const diagnoser = deps.alertDiagnoser ?? (await resolveRealAlertDiagnoser())
      // 提到 try 外：成功分支的 `trace.end` 需要 sessionId（走到那里必已赋值）。
      let diagnosedSessionId: string | null = null
      try {
        const result = await diagnoser({
          cwd,
          alert,
          incident,
          deps: {
            // 过程逐条落库：告警诊断第一次拥有"可见的调查过程" —— 值班台 SSE 能
            // 看到工具调用 / 证据 / 结论逐条冒出，失败也能被 stale sweep 重派。
            // 【T-obs】同一份事件再扇出到 Langfuse（双 sink，方向单向）。
            onToolStart: emitToolStart,
            onToolResult: emitToolResult,
            onAssistantMessage: emitAssistantMessage,
            onProgressMessage: emitProgress,
            onLlmCall: emitLlmCall,
          },
        })
        diagnosedSessionId = result.sessionId
        push('diagnosis', {
          sessionId: result.sessionId,
          summary: result.diagnosisSummary,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        push('error', { message: reason })
        // 不重复 persistSession：runAlertDiagnosis 内部（含其失败分支）已负责
        // 尽力落一个可 resume 的会话，这里再写一次会重复追加事件。
        closed = true
        clearInterval(timer)
        await flush().catch(() => {})
        traced(() => trace.end({ status: 'error', error: reason }))
        await recordUsage(deps, job, log, {
          // 失败前若已发生过 LLM 调用，模型与 token 一样记（失败调查的用量同样要审计）。
          modelName: llmModel,
          durationMs: Date.now() - startedAt,
          status: 'failed',
          inputTokens: llmInputTokens,
          outputTokens: llmOutputTokens,
        })
        throw error
      }

      closed = true
      clearInterval(timer)
      await flush()
      traced(() => trace.end({ status: 'ok', output: { sessionId: diagnosedSessionId } }))
      await recordUsage(deps, job, log, {
        // 模型由 runAlertDiagnosis 内部按运行时配置自建 —— 装配期拿不到，但诊断过程中
        // 的 onLlmCall 会把它带回来，所以这里用实测的 llmModel（此前写死 null 是因为
        // 「拿不到」，现在拿得到了）。
        modelName: llmModel,
        durationMs: Date.now() - startedAt,
        status: 'completed',
        inputTokens: llmInputTokens,
        outputTokens: llmOutputTokens,
      })
      return
    }

    // ── chat 分支：人工对话 / 续聊追问 ──
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

    const runner = deps.turnRunner ?? (await resolveRealTurnRunner())
    const model =
      typeof deps.model === 'function' ? await deps.model({ tools }) : deps.model

    // 实际生效的模型名（审计 / 日志用）：由装配期显式给定（见 server/index.ts）。
    // **刻意不从 adapter 探测** —— `ModelAdapter` 接口只有 `next()`，压根没有模型名
    // 字段；原先那句 `(model as { model? }).model` 永远取到 undefined，是无效代码。
    // 取不到就是 null，不猜（下游会用 `null` 而非 `'unknown'` 区分"未知"）。
    const effectiveModel =
      deps.modelName !== undefined && deps.modelName !== '' ? deps.modelName : null

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
        onToolStart: emitToolStart,
        onToolResult: emitToolResult,
        onAssistantMessage: emitAssistantMessage,
        onProgressMessage: emitProgress,
        onLlmCall: emitLlmCall,
        // 【T55】压缩可见性：此前服务端完全没接，值班台看不到上下文被压缩。
        onAutoCompact: emitAutoCompact,
        onSnipCompact: emitSnipCompact,
        onContextCollapse: emitContextCollapse,
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
      traced(() => trace.end({ status: 'error', error: reason }))
      // 失败同样是"发生过的调查"，也进账本（否则审计只记成功，
      // 而运维最想查的恰恰是失败那些）。
      await recordUsage(deps, job, log, {
        // 实测模型优先；一次 LLM 都没调成（如装工具就炸）才回退到装配期探测值。
        modelName: llmModel ?? effectiveModel,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        inputTokens: llmInputTokens,
        outputTokens: llmOutputTokens,
      })
      throw error
    }

    closed = true
    clearInterval(timer)
    await flush()

    // T-obs：正常收尾。sink 的 `end()` 会先关闭本 trace 内未配对的 span（防泄漏）。
    traced(() => trace.end({ status: 'ok' }))

    // ── G2：回写同一 session（保留 append-only 语义） ──
    await persistSession(deps, cwd, job, finalMessages, log)

    // 记账放在会话回写之后：若回写抛错，会走上面的 catch 路径记 failed，
    // 不会出现"同一轮记两条"（成功一条 + 失败一条）。
    await recordUsage(deps, job, log, {
      modelName: llmModel ?? effectiveModel,
      durationMs: Date.now() - startedAt,
      status: 'completed',
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
    })
  }
}

/** 缺省 sink：不导出任何 span（job 未接 tracing 或接入失败时使用）。 */
const NOOP_SINK = createNoopTracingSink('exec-no-sink')

/** 空的 job trace 信息（降级路径复用）。 */
function noopTraceFor(job: Job): JobTrace {
  return NOOP_SINK.startJobTrace({ jobId: job.id, kind: job.kind, sessionId: job.sessionId })
}

/**
 * 【T-obs】为一次 job 开启 trace。
 *
 * 三件事：
 * 1. 没传 sink / sink 未启用 → noop（零开销）。
 * 2. 从 job payload 取上游 `traceparent`（入队时由 HTTP 层塞入），让 Langfuse 的树
 *    接到上游调用链；缺省则由 sink 从 jobId **确定性派生** traceId。
 * 3. **永不让开 trace 拖垮 job**：任何异常都降级为 noop 并记一条 warn。
 *
 * trace 级属性：`sessionId` = job.sessionId（告警 job = incidentId；chat = `sin-<uuid>`），
 * `userId` = 鉴权身份。两者是 Langfuse 聚合（Sessions / Users 页）的依据。
 */
function startJobTrace(deps: JobExecutorDeps, job: Job): JobTrace {
  const sink = deps.tracing
  if (sink === undefined || !sink.enabled) return noopTraceFor(job)
  try {
    return sink.startJobTrace({
      jobId: job.id,
      kind: job.kind,
      sessionId: job.sessionId,
      userId: job.userId,
      traceparent: traceparentFromJob(job),
    })
  } catch (error) {
    deps.log?.(
      'warn',
      `[exec] ${job.id} 开启 trace 失败（继续不带 tracing 跑）: ${String(error)}`,
    )
    return noopTraceFor(job)
  }
}

/** 从 job payload 读上游 W3C traceparent（缺失/非字符串 → null）。 */
function traceparentFromJob(job: Job): string | null {
  const raw = job.payload?.traceparent
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
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
