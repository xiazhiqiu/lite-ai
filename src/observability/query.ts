/**
 * 可观测性指标查询：从 LITE_AI_HOME/metrics.db 读取聚合统计。
 * 用于 /metrics 命令展示，只读、失败静默降级。
 */

import Database from 'better-sqlite3'
import { metricsDbPath, metricsEnabled } from './metrics.js'

export type MetricsOverview = {
  enabled: boolean
  dbExists: boolean
  turns: number
  llmCalls: number
  toolCalls: number
  toolOk: number
  toolMismatch: number
  toolUnknown: number
  toolSchema: number
  turnsError: number
}

export type ToolStat = {
  toolName: string
  count: number
  ok: number
  okRate: number
}

export type MetricsReport = {
  overview: MetricsOverview
  toolStats: ToolStat[]
  llm: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    avgLatencyMs: number
    stopReasons: Array<{ stopReason: string; count: number }>
  }
  turns: {
    avgSteps: number
    avgToolCalls: number
    avgContextUtilization: number
    maxStepsHit: number
    emptyResponses: number
    thinkingRetries: number
  }
}

function open(): Database.Database | null {
  const dbPath = metricsDbPath()
  try {
    return new Database(dbPath, { readonly: true })
  } catch {
    return null
  }
}

/**
 * 生成可观测性聚合报告。数据库缺失 / 损坏 / 禁用时仍返回结构（overview 置 0/标志位），
 * 由调用方决定如何提示。
 */
export function buildMetricsReport(): MetricsReport {
  const report: MetricsReport = {
    overview: {
      enabled: metricsEnabled(),
      dbExists: false,
      turns: 0,
      llmCalls: 0,
      toolCalls: 0,
      toolOk: 0,
      toolMismatch: 0,
      toolUnknown: 0,
      toolSchema: 0,
      turnsError: 0,
    },
    toolStats: [],
    llm: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgLatencyMs: 0,
      stopReasons: [],
    },
    turns: {
      avgSteps: 0,
      avgToolCalls: 0,
      avgContextUtilization: 0,
      maxStepsHit: 0,
      emptyResponses: 0,
      thinkingRetries: 0,
    },
  }

  const db = open()
  if (!db) return report
  try {
    report.overview.dbExists = true

    const turns = db.prepare(
      'SELECT COUNT(*) n FROM turns',
    ).get() as { n: number }
    const turnsError = db.prepare(
      "SELECT COUNT(*) n FROM turns WHERE error IS NOT NULL",
    ).get() as { n: number }
    const llmCalls = db.prepare(
      'SELECT COUNT(*) n FROM llm_calls',
    ).get() as { n: number }
    const toolCalls = db.prepare(
      "SELECT COUNT(*) n FROM tool_calls",
    ).get() as { n: number }
    const toolOk = db.prepare(
      'SELECT COUNT(*) n FROM tool_calls WHERE ok = 1',
    ).get() as { n: number }
    const toolUnknown = db.prepare(
      "SELECT COUNT(*) n FROM tool_calls WHERE mismatch = 'unknown'",
    ).get() as { n: number }
    const toolSchema = db.prepare(
      "SELECT COUNT(*) n FROM tool_calls WHERE mismatch = 'schema'",
    ).get() as { n: number }

    report.overview.turns = turns.n
    report.overview.llmCalls = llmCalls.n
    report.overview.toolCalls = toolCalls.n
    report.overview.toolOk = toolOk.n
    report.overview.toolMismatch = toolUnknown.n + toolSchema.n
    report.overview.toolUnknown = toolUnknown.n
    report.overview.toolSchema = toolSchema.n
    report.overview.turnsError = turnsError.n

    const toolRows = db.prepare(
      `SELECT tool_name AS toolName,
              COUNT(*) AS count,
              SUM(ok) AS ok
       FROM tool_calls
       GROUP BY tool_name
       ORDER BY count DESC
       LIMIT 20`,
    ).all() as Array<{ toolName: string; count: number; ok: number }>
    report.toolStats = toolRows.map(row => ({
      toolName: row.toolName,
      count: row.count,
      ok: row.ok,
      okRate: row.count > 0 ? row.ok / row.count : 0,
    }))

    const llmAgg = db.prepare(
      `SELECT SUM(total_tokens) AS totalTokens,
              SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens,
              AVG(latency_ms) AS avgLatencyMs
       FROM llm_calls`,
    ).get() as {
      totalTokens: number | null
      inputTokens: number | null
      outputTokens: number | null
      avgLatencyMs: number | null
    }
    report.llm.totalTokens = llmAgg.totalTokens ?? 0
    report.llm.inputTokens = llmAgg.inputTokens ?? 0
    report.llm.outputTokens = llmAgg.outputTokens ?? 0
    report.llm.avgLatencyMs = Math.round(llmAgg.avgLatencyMs ?? 0)

    const stopRows = db.prepare(
      `SELECT COALESCE(stop_reason, '(none)') AS stopReason, COUNT(*) AS count
       FROM llm_calls
       GROUP BY COALESCE(stop_reason, '(none)')
       ORDER BY count DESC
       LIMIT 10`,
    ).all() as Array<{ stopReason: string; count: number }>
    report.llm.stopReasons = stopRows

    const turnAgg = db.prepare(
      `SELECT AVG(steps) AS avgSteps,
              AVG(tool_calls) AS avgToolCalls,
              AVG(context_utilization) AS avgCtx,
              SUM(max_steps_hit) AS maxStepsHit,
              SUM(empty_responses) AS emptyResponses,
              SUM(thinking_retries) AS thinkingRetries
       FROM turns`,
    ).get() as {
      avgSteps: number | null
      avgToolCalls: number | null
      avgCtx: number | null
      maxStepsHit: number | null
      emptyResponses: number | null
      thinkingRetries: number | null
    }
    report.turns.avgSteps = Math.round(turnAgg.avgSteps ?? 0)
    report.turns.avgToolCalls = Math.round(turnAgg.avgToolCalls ?? 0)
    report.turns.avgContextUtilization = turnAgg.avgCtx ?? 0
    report.turns.maxStepsHit = turnAgg.maxStepsHit ?? 0
    report.turns.emptyResponses = turnAgg.emptyResponses ?? 0
    report.turns.thinkingRetries = turnAgg.thinkingRetries ?? 0
  } catch {
    // 读取失败（如受损库）→ 返回空结构，不向主流程抛错。
  } finally {
    db.close()
  }

  return report
}

/** 将报告渲染为终端文本，供 /metrics 展示。 */
export function renderMetricsReport(report: MetricsReport): string {
  const { overview, llm, turns, toolStats } = report

  if (!overview.enabled) {
    return '[metrics] 已通过 LITE_AI_METRICS=0 关闭。'
  }
  if (!overview.dbExists) {
    return '[metrics] 无可观测性数据。运行过 agent 回合后会自动生成 metrics.db。'
  }

  const pct = (num: number, denom: number): string =>
    denom > 0 ? `${((num / denom) * 100).toFixed(1)}%` : '-'

  const lines: string[] = []
  lines.push('[metrics] 概览（全部周期）')
  lines.push(`  turns: ${overview.turns}  llm_calls: ${overview.llmCalls}  tool_calls: ${overview.toolCalls}`)
  lines.push(`  tool 成功率: ${pct(overview.toolOk, overview.toolCalls)}  (ok=${overview.toolOk}/${overview.toolCalls})`)
  lines.push(`  tool 匹配失败: ${overview.toolMismatch}  (unknown=${overview.toolUnknown}, schema=${overview.toolSchema})`)
  lines.push(`  回合失败: ${overview.turnsError}`)

  lines.push('')
  lines.push('[metrics] LLM 调用')
  lines.push(`  tokens: input=${llm.inputTokens}  output=${llm.outputTokens}  total=${llm.totalTokens}`)
  lines.push(`  平均时延: ${llm.avgLatencyMs}ms`)
  if (llm.stopReasons.length > 0) {
    lines.push(
      `  stop_reason: ${llm.stopReasons.map(r => `${r.stopReason}:${r.count}`).join(', ')}`,
    )
  }

  lines.push('')
  lines.push('[metrics] 回合')
  lines.push(
    `  平均步数: ${turns.avgSteps}  平均工具调用: ${turns.avgToolCalls}`,
  )
  lines.push(
    `  平均上下文利用率: ${(turns.avgContextUtilization * 100).toFixed(1)}%`,
  )
  lines.push(
    `  max_steps_hit: ${turns.maxStepsHit}  空转(empty): ${turns.emptyResponses}  thinking 重试: ${turns.thinkingRetries}`,
  )

  if (toolStats.length > 0) {
    lines.push('')
    lines.push('[metrics] 工具分布（top 20）')
    for (const stat of toolStats) {
      lines.push(
        `  ${stat.toolName}  count=${stat.count}  ok=${stat.ok}  rate=${pct(stat.ok, stat.count)}`,
      )
    }
  }

  return lines.join('\n')
}

/**
 * 按 turn_id 回溯单个回合的调用链（Langfuse Trace 语义）。
 * 返回该回合的 turn 汇总 + 全部 llm 调用 + 全部工具调用；turn_id 不存在返回 null。
 */
export function queryTurnTrace(turnId: string): {
  turn: { steps: number; toolCalls: number; toolErrors: number; durationMs: number; error: string | null }
  llmCalls: Array<{ model: string | null; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; stopReason: string | null }>
  toolCalls: Array<{ toolName: string; ok: number; latencyMs: number | null; mismatch: string | null }>
} | null {
  const db = open()
  if (!db) return null
  try {
    const turn = db.prepare(
      `SELECT steps, tool_calls AS toolCalls, tool_errors AS toolErrors,
              duration_ms AS durationMs, error
       FROM turns WHERE turn_id = ?`,
    ).get(turnId) as { steps: number; toolCalls: number; toolErrors: number; durationMs: number; error: string | null } | undefined
    if (!turn) return null
    const llmCalls = db.prepare(
      `SELECT model, input_tokens AS inputTokens, output_tokens AS outputTokens,
              latency_ms AS latencyMs, stop_reason AS stopReason
       FROM llm_calls WHERE turn_id = ? ORDER BY id`,
    ).all(turnId) as Array<{ model: string | null; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; stopReason: string | null }>
    const toolCalls = db.prepare(
      `SELECT tool_name AS toolName, ok, latency_ms AS latencyMs, mismatch
       FROM tool_calls WHERE turn_id = ? ORDER BY id`,
    ).all(turnId) as Array<{ toolName: string; ok: number; latencyMs: number | null; mismatch: string | null }>
    return { turn, llmCalls, toolCalls }
  } catch {
    return null
  } finally {
    db.close()
  }
}