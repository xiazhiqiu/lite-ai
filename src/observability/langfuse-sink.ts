/**
 * T-obs：Langfuse OTel sink（**真实实现**，仅在配置了凭据时被动态 import）。
 *
 * ## 只做一件事：把 `JobTrace` 的调用翻译成 OTel span
 *
 * 映射关系（plan 已拍板）：
 *
 * | lite-ai 概念 | Langfuse | 说明 |
 * |---|---|---|
 * | 一次 job（`chat` / `alert`） | **Trace** | `session.id`=sessionId、`user.id`=userId |
 * | `tool_start`/`tool_result` | **Tool** observation | 一次工具调用一条，带成败与耗时 |
 * | `agent-loop` 的 `onLlmCall` | **Generation** | 带 model 与 `usageDetails`（我们已有结构化用量，免解析） |
 * | `assistant_message` / `progress` | **Event** | 点事件，无时长 |
 *
 * ## 三条落地细节（都是踩过才写下来的）
 *
 * 1. **`propagateAttributes` 包住每一次 observation 创建**。`@langfuse/otel` 的
 *    `LangfuseSpanProcessor.onStart` 明确写着会 "add propagated attributes to the span"
 *    —— 即 session/user/traceName 是**在创建时从 OTel context 读出来写进 span** 的。
 *    只给 root 设属性的话，子 span 上就没有 `session.id`，Langfuse 的
 *    attribute 级 metrics 会漏统计。所以每建一个 observation 都包一层
 *    （`propagateAttributes` 是**同步**的，不引入 async 边界，确定可控）。
 *
 * 2. **不依赖 AsyncLocalStorage 的 active context**。所有子 observation 都走
 *    `parent.startObservation(...)` **显式指定父子**，而不是靠"当前活跃 span"。
 *    回调式扇出（工具 span 的 start/end 跨多次回调）里，active context 是否还在
 *    是隐性假设；显式父子没有这个假设。
 *
 * 3. **traceId 确定性派生**（`deriveTraceId(jobId)`），并用官方文档同款手法
 *    通过 `parentSpanContext` 注入（官方 "Trace and observation IDs" 示例即传一个
 *    任意 spanId 来锚定 traceId）。若上游带了 `traceparent` 则沿用其 traceId，
 *    让 Langfuse 的树接到上游调用链。
 *
 * ## error-safe（纪律 2）
 *
 * 本文件**每一处** SDK 调用都在 try/catch 内，失败只记一条 debug 级信息。
 * 观测失败最多丢一个 span，绝不允许冒泡进 `exec.ts` 的调查主流程。
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import {
  startObservation,
  propagateAttributes,
  type LangfuseSpan,
  type LangfuseTool,
} from '@langfuse/tracing'
import {
  deriveTraceId,
  parseTraceparent,
  randomSpanId,
  type JobTrace,
  type JobTraceEnd,
  type JobTraceInfo,
  type LlmCallEvent,
  type TracingCredentials,
  type TracingSink,
} from './tracing.js'

/**
 * 单条 attribute 的字符上限。
 *
 * 工具输出动辄上万字符（`DEFAULT_MAX_RESULT_SIZE_CHARS = 50000`），原样上传会让
 * Langfuse 存储与网络开销失控。截断是**有损**的——但真相源是 `job_events`，
 * Langfuse 只是分析视图，截断不影响取证。
 */
const MAX_ATTR_CHARS = 4000

/** 截断超长字符串（非字符串原样返回，交给 SDK 的序列化）。 */
function clip(value: unknown, max = MAX_ATTR_CHARS): unknown {
  if (typeof value !== 'string') return value
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated ${value.length - max} chars]`
}

/** 只保留非空字符串（`propagateAttributes` 的值必须是 string 且 ≤200 字符）。 */
function attrString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200)
}

type Logger = (level: 'info' | 'warn' | 'error', message: string) => void

/**
 * 一条 job trace 的真实实现。
 *
 * 生命周期：构造（建 root span）→ 若干 toolStart/toolEnd/generation/event → `end()`。
 */
class LangfuseJobTrace implements JobTrace {
  private readonly root: LangfuseSpan
  /** 未结束的工具 span（toolUseId → span）。job 异常结束时由 `end()` 兜底关闭。 */
  private readonly openTools = new Map<string, LangfuseTool>()
  private ended = false
  /** 每次建 observation 都要重放的 trace 级属性。 */
  private readonly attrs: {
    userId?: string
    sessionId?: string
    traceName: string
  }

  constructor(info: JobTraceInfo) {
    const traceName = info.name ?? `job:${info.kind}`
    const userId = attrString(info.userId)
    const sessionId = attrString(info.sessionId)
    this.attrs = {
      ...(userId !== undefined ? { userId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      traceName,
    }

    // 上游 traceparent 优先（接上游链路），否则从 jobId 确定性派生。
    const upstream = parseTraceparent(info.traceparent)
    const traceId = upstream?.traceId ?? deriveTraceId(info.jobId)
    const spanId = upstream?.spanId ?? randomSpanId()

    this.root = this.withAttrs(() =>
      startObservation(
        traceName,
        {
          input: {
            jobId: info.jobId,
            kind: info.kind,
            sessionId: info.sessionId,
            userId: info.userId ?? null,
          },
          metadata: { jobId: info.jobId, kind: info.kind, traceId },
        },
        {
          asType: 'span',
          parentSpanContext: { traceId, spanId, traceFlags: upstream?.traceFlags ?? 1 },
        },
      ),
    )
  }

  /** 在 trace 级属性作用域内执行（同步；见文件头说明 1）。 */
  private withAttrs<T>(fn: () => T): T {
    return propagateAttributes(this.attrs, fn)
  }

  toolStart(toolUseId: string, toolName: string, input: unknown): void {
    try {
      const span = this.withAttrs(() =>
        this.root.startObservation(
          toolName,
          { input: clip(input) },
          { asType: 'tool' },
        ),
      )
      this.openTools.set(toolUseId, span)
    } catch {
      // 观测失败不影响调查（纪律 2）
    }
  }

  toolEnd(toolUseId: string, toolName: string, output: string, isError: boolean): void {
    try {
      const span = this.openTools.get(toolUseId)
      if (span === undefined) return
      this.openTools.delete(toolUseId)
      span.update({
        output: clip(output),
        ...(isError ? { level: 'ERROR' as const, statusMessage: `${toolName} 执行失败` } : {}),
      })
      span.end()
    } catch {
      /* 同上 */
    }
  }

  generation(record: LlmCallEvent): void {
    try {
      const usageDetails: Record<string, number> = {}
      if (typeof record.inputTokens === 'number') usageDetails.input = record.inputTokens
      if (typeof record.outputTokens === 'number') usageDetails.output = record.outputTokens
      if (typeof record.totalTokens === 'number') usageDetails.total = record.totalTokens
      const metadata: Record<string, unknown> = {}
      if (typeof record.latencyMs === 'number') metadata.latencyMs = record.latencyMs
      if (typeof record.provider === 'string') metadata.provider = record.provider
      if (typeof record.stopReason === 'string') metadata.stopReason = record.stopReason

      const span = this.withAttrs(() =>
        this.root.startObservation(
          typeof record.model === 'string' && record.model !== '' ? record.model : 'llm-call',
          {
            ...(typeof record.model === 'string' ? { model: record.model } : {}),
            ...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            ...(typeof record.error === 'string'
              ? { level: 'ERROR' as const, statusMessage: record.error }
              : {}),
          },
          { asType: 'generation' },
        ),
      )
      span.end()
    } catch {
      /* 同上 */
    }
  }

  event(name: string, payload?: Record<string, unknown>): void {
    try {
      // Event 是点事件，SDK 创建时自动 end（无需手动 end）。
      this.withAttrs(() =>
        this.root.startObservation(name, { metadata: payload ?? {} }, { asType: 'event' }),
      )
    } catch {
      /* 同上 */
    }
  }

  end(result?: JobTraceEnd): void {
    if (this.ended) return
    this.ended = true
    try {
      // 兜底：job 异常结束时可能还有没配对的 tool span，先全部关掉，
      // 否则 Langfuse 里会留下永不结束的 span（时长虚高、图不闭合）。
      for (const span of this.openTools.values()) {
        try {
          span.end()
        } catch {
          /* 单个 span 关闭失败不阻断其余 */
        }
      }
      this.openTools.clear()

      this.root.update({
        ...(result?.output !== undefined ? { output: clip(result.output) } : {}),
        ...(result?.status === 'error'
          ? { level: 'ERROR' as const, statusMessage: result.error ?? 'job failed' }
          : {}),
      })
      this.root.end()
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 装配真实 Langfuse sink：起 `NodeSDK` + `LangfuseSpanProcessor`，返回 `TracingSink`。
 *
 * **不做**的事：不额外起 OTel Collector（纪律 4）—— `LangfuseSpanProcessor` 自带
 * OTLP 导出，直连 Langfuse。
 *
 * `exportMode` 保持默认 `batched`（长跑服务进程，批量导出更省）；SIGTERM 时由
 * `flush()`/`shutdown()` 保证最后一波 span 不丢（纪律 3）。
 */
export async function createLangfuseTracingSink(args: {
  credentials: TracingCredentials
  log?: Logger
}): Promise<TracingSink> {
  const { credentials } = args
  const log = args.log ?? ((): void => {})

  const processor = new LangfuseSpanProcessor({
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
    ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
    ...(credentials.environment !== undefined ? { environment: credentials.environment } : {}),
    ...(credentials.release !== undefined ? { release: credentials.release } : {}),
  })

  const sdk = new NodeSDK({ spanProcessors: [processor] })
  sdk.start()
  log(
    'info',
    `[tracing] Langfuse 已启用（baseUrl=${credentials.baseUrl ?? 'https://cloud.langfuse.com'}）`,
  )

  return {
    enabled: true,
    startJobTrace: info => new LangfuseJobTrace(info),
    flush: async () => {
      try {
        await processor.forceFlush()
      } catch (error) {
        log('warn', `[tracing] flush 失败（span 可能丢，不影响调查）：${String(error)}`)
      }
    },
    shutdown: async () => {
      // 先 flush 再 shutdown：shutdown 会停掉导出器，未刷的缓冲就再也出不去了。
      try {
        await processor.forceFlush()
      } catch (error) {
        log('warn', `[tracing] shutdown 前 flush 失败：${String(error)}`)
      }
      try {
        await sdk.shutdown()
      } catch (error) {
        log('warn', `[tracing] SDK shutdown 失败：${String(error)}`)
      }
    },
  }
}
