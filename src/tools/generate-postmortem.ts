import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { LITE_AI_DIR } from '../config.js'
import {
  type IncidentCheckpoint,
  checkpointProjectSlug,
  readCheckpoints,
} from '../utils/checkpoint-store.js'
import {
  type Evidence,
  type Hypothesis,
  readHypotheses,
} from '../utils/hypothesis-store.js'

const InputSchema = z.object({
  checkpoint_id: z.string().min(1).optional(),
  impact: z
    .string()
    .optional()
    .describe('影响范围描述（受影响服务/用户/业务损失）。不传则留空待填。'),
  remediation_actions: z
    .array(z.string().min(1))
    .optional()
    .describe('处置记录（已采取的恢复/缓解动作）。不传则标记为未记录。'),
  lessons_learned: z
    .array(z.string().min(1))
    .optional()
    .describe('经验教训与改进项。不传则标记为待补充。'),
})

type Input = z.infer<typeof InputSchema>

/** postmortem 报告落盘路径：LITE_AI_HOME/postmortems/{project}-{checkpoint_id}.md */
export function postmortemFilePath(cwd: string, checkpointId: string): string {
  return path.join(
    LITE_AI_DIR,
    'postmortems',
    `${checkpointProjectSlug(cwd)}-${checkpointId}.md`,
  )
}

function formatTimestamp(ts: number): string {
  // evidence.timestamp 可能是 Unix 秒或毫秒——启发式判断：
  // 小于 1e10 视为秒（< 2286 年的秒数），否则视为毫秒
  const ms = ts < 1e10 ? ts * 1000 : ts
  return new Date(ms).toISOString()
}

/** 从所有 evidence 中按时间戳排序生成时间线条目。 */
function buildTimeline(hypotheses: Hypothesis[]): {
  time: string
  command: string
  summary: string
  source: string
}[] {
  const all: { evidence: Evidence; hypothesisId: string }[] = []
  for (const h of hypotheses) {
    for (const e of h.evidence) {
      all.push({ evidence: e, hypothesisId: h.id })
    }
  }
  // 统一为毫秒再排序，避免秒/毫秒混排导致顺序错乱
  const toMs = (ts: number) => (ts < 1e10 ? ts * 1000 : ts)
  all.sort((a, b) => toMs(a.evidence.timestamp) - toMs(b.evidence.timestamp))
  return all.map(({ evidence }) => ({
    time: formatTimestamp(evidence.timestamp),
    command: evidence.command,
    summary: evidence.output_summary,
    source: evidence.data_source,
  }))
}

function formatTimeline(timeline: ReturnType<typeof buildTimeline>): string {
  if (timeline.length === 0) return '(暂无证据记录)'
  const rows = timeline.map(
    (t, i) =>
      `| ${i + 1} | ${t.time} | \`${t.command}\` | ${t.source} | ${t.summary} |`,
  )
  return '| # | 时间 | 命令 | 数据源 | 摘要 |\n|---|---|---|---|---|\n' + rows.join('\n')
}

function formatConfirmedRootCause(hypotheses: Hypothesis[]): string {
  const confirmed = hypotheses.filter(h => h.status === 'confirmed')
  if (confirmed.length === 0) {
    return '(无 confirmed 假设——根因未定位或未确认)'
  }
  return confirmed
    .map(h => {
      const evLines = h.evidence.map(
        e =>
          `  - ${e.supports ? 'SUPPORTS' : 'REFUTES'} [${e.data_source}] \`${e.command}\`: ${e.output_summary}`,
      )
      const conclusion = h.conclusion ? `\n  结论: ${h.conclusion}` : ''
      return `### ${h.id}: ${h.description}${conclusion}\n\n证据:\n${evLines.join('\n')}`
    })
    .join('\n\n')
}

function formatRefutedHypotheses(hypotheses: Hypothesis[]): string {
  const refuted = hypotheses.filter(h => h.status === 'refuted')
  if (refuted.length === 0) return '(无已排除假设)'
  return refuted
    .map(h => {
      const evCount = h.evidence.length
      const evBrief =
        evCount > 0
          ? h.evidence
              .map(e => `\`${e.command}\` → ${e.output_summary}`)
              .join('; ')
          : '(无证据)'
      const conclusion = h.conclusion ? ` 结论: ${h.conclusion}` : ''
      return `- **${h.id}**: ${h.description} — ${evBrief}${conclusion}`
    })
    .join('\n')
}

function formatActions(actions: string[] | undefined, placeholder: string): string {
  if (!actions || actions.length === 0) return placeholder
  return actions.map(a => `- ${a}`).join('\n')
}

function formatFullHypothesisChain(hypotheses: Hypothesis[]): string {
  if (hypotheses.length === 0) return '(无假设记录)'
  const sorted = [...hypotheses].sort(
    (a, b) => a.priority - b.priority || a.created_at - b.created_at,
  )
  return sorted
    .map(h => {
      const evLines = h.evidence.map(
        e =>
          `  - [${e.supports ? 'SUPPORTS' : 'REFUTES'}] \`${e.command}\`: ${e.output_summary}`,
      )
      const conclusion = h.conclusion ? `\n  结论: ${h.conclusion}` : ''
      return `- [${h.status}] P${h.priority} ${h.id}: ${h.description}${conclusion}${
        evLines.length > 0 ? '\n' + evLines.join('\n') : ''
      }`
    })
    .join('\n')
}

async function buildPostmortem(
  cwd: string,
  cp: IncidentCheckpoint,
  input: Input,
): Promise<string> {
  const hypoList = await readHypotheses(cwd)
  const hypotheses = hypoList.hypotheses
  const timeline = buildTimeline(hypotheses)
  const generatedAt = new Date().toISOString()

  const sections = [
    `# Postmortem: ${cp.incident_title}`,
    '',
    `| 字段 | 值 |`,
    `|---|---|`,
    `| 事故 | ${cp.incident_title} |`,
    `| 严重级别 | ${cp.severity} |`,
    `| 检查点 | ${cp.id} (${cp.name}) |`,
    `| 检查点创建时间 | ${formatTimestamp(cp.created_at)} |`,
    `| 报告生成时间 | ${generatedAt} |`,
    '',
    '## 1. 概述',
    cp.incident_title,
    '',
    '## 2. 影响范围',
    input.impact ?? '(待补充)',
    '',
    '## 3. 时间线（按证据时间戳排序）',
    formatTimeline(timeline),
    '',
    '## 4. 根因分析（confirmed 假设）',
    formatConfirmedRootCause(hypotheses),
    '',
    '## 5. 已排除的假设',
    formatRefutedHypotheses(hypotheses),
    '',
    '## 6. 处置记录',
    formatActions(input.remediation_actions, '(未记录)'),
    '',
    '## 7. 经验教训与改进项',
    formatActions(input.lessons_learned, '(待补充)'),
    '',
    '## 附录：完整假设链',
    formatFullHypothesisChain(hypotheses),
    '',
  ]
  return sections.join('\n')
}

export const generatePostmortemTool: ToolDefinition<Input> = {
  name: 'generate_postmortem',
  description:
    'Generate a Markdown postmortem report for a resolved incident. Aggregates data from the incident checkpoint (title, severity) and the hypothesis-evidence chain (timeline, root cause, refuted hypotheses). Optional inputs: impact (affected scope), remediation_actions (recovery steps taken), lessons_learned (improvement items). The report is written to disk under LITE_AI_HOME/postmortems/ for archival. Call this after the incident is resolved and the root cause is confirmed.',

  inputSchema: {
    type: 'object',
    properties: {
      checkpoint_id: {
        type: 'string',
        description:
          'Checkpoint id to anchor the report to. If omitted, uses the active checkpoint, or the latest one if none is active.',
      },
      impact: {
        type: 'string',
        description: 'Affected scope (services, users, business impact).',
      },
      remediation_actions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recovery/mitigation actions taken.',
      },
      lessons_learned: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lessons learned and follow-up improvement items.',
      },
    },
  },

  schema: InputSchema,
  isReadOnly: false, // writes report file to disk

  async run(input, context) {
    const list = await readCheckpoints(context.cwd)
    if (list.checkpoints.length === 0) {
      return {
        ok: false,
        output:
          'No checkpoint found. Create one with incident_checkpoint (action=create) before generating a postmortem.',
      }
    }

    const cp = input.checkpoint_id
      ? list.checkpoints.find(c => c.id === input.checkpoint_id)
      : list.checkpoints.find(c => c.active) ??
        [...list.checkpoints].sort((a, b) => b.created_at - a.created_at)[0]

    if (!cp) {
      return {
        ok: false,
        output: `Unknown checkpoint id "${input.checkpoint_id}". Known:\n${list.checkpoints.map(c => `- ${c.id}: ${c.name}`).join('\n')}`,
      }
    }

    const report = await buildPostmortem(context.cwd, cp, input)
    const filePath = postmortemFilePath(context.cwd, cp.id)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, report, 'utf8')

    return {
      ok: true,
      output: `Postmortem generated for "${cp.name}" (checkpoint ${cp.id}).\n\nSaved to: ${filePath}\n\n---\n\n${report}`,
    }
  },
}
