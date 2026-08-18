import { readCheckpoints, type IncidentCheckpoint } from '../utils/checkpoint-store.js'
import { readHypotheses, summarizeHypotheses } from '../utils/hypothesis-store.js'

/**
 * 事故事实层快照：在 auto-compact 压缩前从 hypothesis_tracker + incident_checkpoint
 * 提取结构化事实，注入到压缩后的 summary 中，保证事故关键信息在长排查中不被丢弃。
 *
 * PRD P1-5 验收：compact 后事故标题、假设状态、关键命令存活；
 * 假设链为空时不注入（无事故场景降级为原行为）。
 */
export type IncidentFactSnapshot = {
  incident_title: string
  severity: string
  start_time: number
  hypotheses: {
    active: number
    confirmed: number
    refuted: number
    summary: string
  }
  key_commands: string[]
  next_steps: string
}

/** key_commands 上限：避免快照过长侵蚀 compact 节省的 token。 */
export const MAX_KEY_COMMANDS = 10

/**
 * 从 cwd 对应的 hypothesis-store + checkpoint-store 提取事故事实快照。
 *
 * 返回 null 的条件（PRD 验收"假设链为空时不注入"）：
 * - 假设链不存在或为空 → null（无事故场景，降级为原 compact 行为）
 *
 * checkpoint 缺失时仍可生成快照（用默认值填充 incident_title/severity/start_time），
 * 因为假设链存在即说明有排查在进行。
 */
export async function extractIncidentFactSnapshot(
  cwd: string,
): Promise<IncidentFactSnapshot | null> {
  const hypoList = await readHypotheses(cwd)
  if (hypoList.hypotheses.length === 0) {
    return null
  }

  const summary = summarizeHypotheses(hypoList)

  // 优先用活动检查点的元信息；无活动则用最新检查点；无检查点则用默认值
  const cpList = await readCheckpoints(cwd)
  const activeCp = cpList.checkpoints.find(c => c.active)
  const latestCp = cpList.checkpoints.length > 0
    ? [...cpList.checkpoints].sort((a, b) => b.created_at - a.created_at)[0]
    : undefined
  const cp: Partial<IncidentCheckpoint> | undefined = activeCp ?? latestCp

  // key_commands：优先用活动检查点记录的，否则从假设链 evidence 中按时间戳取前 10 条
  const keyCommands =
    cp?.key_commands && cp.key_commands.length > 0
      ? cp.key_commands.slice(0, MAX_KEY_COMMANDS)
      : collectKeyCommandsFromEvidence(hypoList.hypotheses)

  // next_steps：从 confirmed 假设的 conclusion 推导；无 confirmed 则提示待验证
  const nextSteps = deriveNextSteps(hypoList.hypotheses)

  return {
    incident_title: cp?.incident_title ?? '(未命名事故)',
    severity: cp?.severity ?? 'unknown',
    start_time: cp?.created_at ?? hypoList.hypotheses[0]!.created_at,
    hypotheses: {
      active: summary.active,
      confirmed: summary.confirmed,
      refuted: summary.refuted,
      summary: summary.summary,
    },
    key_commands: keyCommands,
    next_steps: nextSteps,
  }
}

/** 从所有 evidence 中按时间戳排序取前 MAX_KEY_COMMANDS 条 command。 */
function collectKeyCommandsFromEvidence(
  hypotheses: { evidence: { command: string; timestamp: number }[] }[],
): string[] {
  const all = hypotheses.flatMap(h => h.evidence)
  all.sort((a, b) => a.timestamp - b.timestamp)
  return all.slice(0, MAX_KEY_COMMANDS).map(e => e.command)
}

/**
 * 推导下一步建议：
 * - 有 confirmed 假设 → 用其 conclusion 作为根因定位后的下一步
 * - 无 confirmed 但有 active 假设 → 提示继续验证最高优先级假设
 * - 全部 refuted → 提示重新生成假设
 */
function deriveNextSteps(
  hypotheses: {
    status: string
    priority: number
    description: string
    conclusion?: string
    created_at: number
  }[],
): string {
  const confirmed = hypotheses.find(h => h.status === 'confirmed')
  if (confirmed) {
    return confirmed.conclusion
      ? `根因已确认: ${confirmed.conclusion}。建议进入处置/复盘阶段。`
      : `根因假设 "${confirmed.description}" 已确认。建议进入处置/复盘阶段。`
  }

  const active = hypotheses
    .filter(h => h.status === 'pending' || h.status === 'investigating')
    .sort((a, b) => a.priority - b.priority || a.created_at - b.created_at)
  if (active.length > 0) {
    return `继续验证最高优先级假设: P${active[0]!.priority} "${active[0]!.description}"。`
  }

  const allRefuted = hypotheses.length > 0 && hypotheses.every(h => h.status === 'refuted')
  if (allRefuted) {
    return '所有假设已排除，建议重新生成根因假设。'
  }

  return '继续排查。'
}

/**
 * 将快照格式化为可注入 compact summary 的 Markdown 块。
 * 设计为紧凑结构，避免侵蚀 compact 节省的 token。
 */
export function formatIncidentFactSnapshot(snapshot: IncidentFactSnapshot): string {
  const startTime = new Date(snapshot.start_time).toISOString()
  const commands =
    snapshot.key_commands.length > 0
      ? snapshot.key_commands.map(cmd => `- \`${cmd}\``).join('\n')
      : '(暂无关键命令记录)'

  return [
    '',
    '---',
    '## 事故事实层（compact 保活，请勿丢失）',
    '',
    `- **事故**: ${snapshot.incident_title}`,
    `- **严重级别**: ${snapshot.severity}`,
    `- **开始时间**: ${startTime}`,
    `- **假设状态**: active=${snapshot.hypotheses.active} confirmed=${snapshot.hypotheses.confirmed} refuted=${snapshot.hypotheses.refuted}`,
    '',
    '### 假设链摘要',
    snapshot.hypotheses.summary,
    '',
    '### 已执行关键命令',
    commands,
    '',
    '### 推荐下一步',
    snapshot.next_steps,
    '---',
  ].join('\n')
}
