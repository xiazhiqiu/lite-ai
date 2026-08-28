/**
 * 确定性模拟：固定窗口模型 + 每轮追加"告警诊断"典型载荷，
 * 全程套用 agent-loop 触发顺序（snip → microcompact），统计占用率与各层命中次数，
 * 看占用率何时跨过 blocked(95%)，或稳定在某个平台值。
 *
 * 口径说明：
 *  - 只统计不需要 LLM 的两层（snip / microcompact）。
 *  - context-collapse(≥75%) 与 auto-compact(≥85%, step0) 依赖 LLM 摘要，此处不跑，
 *    因此得到的是"下限"——真实 agent 借助这两层会压得更低、撑得更久。
 *  - 大结果落盘/工具输出裁剪由 tool_result 载荷的固定大小近似体现。
 */
import { computeContextStats } from '../src/utils/token-estimator.js'
import { microcompact } from '../src/compact/microcompact.js'
import { snipCompactConversation } from '../src/compact/snipCompact.js'
import { getModelContextWindow } from '../src/utils/model-context.js'
import type { ChatMessage } from '../src/types.js'

const ROUNDS_CAP = 500
const MAX_UTIL = 0.95

// 每轮的"典型告警诊断"载荷：1 提问 + 短回答 + 2 条大只读工具结果 + 进度
function roundPayload(round: number): ChatMessage[] {
  const spec = `http_requests_total{namespace=\"default\"} p95 检测, rate5m 聚合结果, ${'x'.repeat(3600)}`
  const pod = `default/compute and default/storage pods list, ${'y'.repeat(3600)}`
  return [
    { role: 'user', content: `检测到 payment 服务 p95 升高，定位根因（第 ${round} 轮）。` },
    { role: 'assistant', content: `已发现异常，继续排查（第 ${round} 轮）。` },
    { role: 'assistant_tool_call', toolName: 'prometheus_query_range', toolUseId: `p${round}`, content: '{}' },
    { role: 'tool_result', toolName: 'prometheus_query_range', toolUseId: `p${round}`, content: spec },
    { role: 'assistant_tool_call', toolName: 'kubernetes_pods', toolUseId: `k${round}`, content: '{}' },
    { role: 'tool_result', toolName: 'kubernetes_pods', toolUseId: `k${round}`, content: pod },
    { role: 'assistant_progress', content: '已并行拉取指标与实例清单，比对中…' },
  ]
}

const foldable = new Set(['prometheus_query_range', 'kubernetes_pods'])

async function simulate(model: string): Promise<void> {
  const win = getModelContextWindow(model)
  const effective = win.effectiveInput
  let messages: ChatMessage[] = []
  let snipHits = 0
  let microHits = 0
  let lastUtil = 0

  for (let round = 1; round <= ROUNDS_CAP; round++) {
    messages = [...messages, ...roundPayload(round)]
    const stats = computeContextStats(messages, model)

    const snip = await snipCompactConversation({
      messages,
      contextStats: stats,
      modelContextWindow: effective,
    })
    if (snip.didSnip) {
      messages = snip.messages
      snipHits++
    }

    const before = messages
    messages = microcompact(messages, model, foldable)
    if (messages !== before) microHits++

    lastUtil = computeContextStats(messages, model).utilization
    if (lastUtil >= MAX_UTIL) {
      console.log(
        `[${model.padEnd(16)}] blocked @ round ${String(round).padStart(3)}, ` +
          `util=${lastUtil.toFixed(3)} | snip=${snipHits} micro=${microHits}`,
      )
      return
    }
  }
  console.log(
    `[${model.padEnd(16)}] ${ROUNDS_CAP} 轮内未达 blocked, ` +
      `plateau util=${lastUtil.toFixed(3)} | snip=${snipHits} micro=${microHits} | effective=${effective}`,
  )
}

for (const m of ['gpt-4o', 'claude-3-5-sonnet', 'gemini-2.5-flash', 'deepseek-chat', 'unknown-model']) {
  await simulate(m)
}