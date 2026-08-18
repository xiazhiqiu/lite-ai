import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import {
  type IncidentCheckpoint,
  SEVERITIES,
  checkpointsFilePath,
  emptyCheckpointList,
  enforceCheckpointLimit,
  readCheckpoints,
  saveCheckpoints,
  validateCheckpointList,
} from '../utils/checkpoint-store.js'
import { readHypotheses } from '../utils/hypothesis-store.js'

const ACTIONS = [
  'create',
  'list',
  'switch_to',
  'generate_handover',
] as const

const InputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().min(1),
    incident_title: z.string().min(1),
    severity: z.enum(SEVERITIES),
  }),
  z.object({
    action: z.literal('list'),
  }),
  z.object({
    action: z.literal('switch_to'),
    checkpoint_id: z.string().min(1),
  }),
  z.object({
    action: z.literal('generate_handover'),
    checkpoint_id: z.string().min(1).optional(),
  }),
])

type Input = z.infer<typeof InputSchema>

function newCheckpointId(): string {
  return `cp_${Date.now().toString(36)}`
}

/** 从假设链提取交接简报所需的状态（已排除/待验证假设 + 关键命令）。 */
async function extractIncidentFacts(
  cwd: string,
): Promise<{ refuted: string[]; pending: string[]; commands: string[] }> {
  const list = await readHypotheses(cwd)
  const refuted: string[] = []
  const pending: string[] = []
  const commands: string[] = []
  for (const h of list.hypotheses) {
    if (h.status === 'refuted') {
      refuted.push(`- ${h.description}`)
    } else if (h.status !== 'confirmed') {
      pending.push(`- [P${h.priority}] ${h.description} (${h.status})`)
    }
    for (const e of h.evidence) {
      if (!commands.includes(e.command)) {
        commands.push(e.command)
      }
    }
  }
  return { refuted, pending, commands: commands.slice(0, 10) }
}

function formatCheckpoint(cp: IncidentCheckpoint): string {
  const active = cp.active ? ' [ACTIVE]' : ''
  return `- ${cp.id}: ${cp.name} (${cp.severity}) "${cp.incident_title}" @ ${new Date(cp.created_at).toISOString()}${active}`
}

async function buildHandover(cwd: string, cp: IncidentCheckpoint): Promise<string> {
  const facts = await extractIncidentFacts(cwd)
  const timeline = facts.commands
    .map((cmd, i) => `| ${i + 1} | \`${cmd}\` |`)
    .join('\n')

  const sections = [
    `## 事故简报：${cp.incident_title}`,
    '',
    '### 严重级别',
    cp.severity,
    '',
    '### 现象',
    cp.incident_title,
    '',
    '### 时间线（关键事件）',
    facts.commands.length > 0
      ? '| # | 命令 |\n|---|---|\n' + timeline
      : '(暂无命令记录)',
    '',
    '### 已排除的假设',
    facts.refuted.length > 0 ? facts.refuted.join('\n') : '(无)',
    '',
    '### 待验证的假设',
    facts.pending.length > 0 ? facts.pending.join('\n') : '(无)',
    '',
    '### 推荐的下一步',
    '（需值班人员或 agent 基于上述状态继续排查）',
  ]
  return sections.join('\n')
}

export const incidentCheckpointTool: ToolDefinition<Input> = {
  name: 'incident_checkpoint',
  description:
    'Manage incident checkpoints for cross-shift handover. Use create to save the current incident state (name, title, severity) as a named checkpoint. Use list to see all checkpoints. Use switch_to to mark a checkpoint as the active current one (e.g. when resuming). Use generate_handover to produce a Markdown handover brief (severity, timeline, refuted/pending hypotheses, key commands) for the next on-call engineer.',

  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      name: { type: 'string', description: 'Checkpoint name (create)' },
      incident_title: {
        type: 'string',
        description: 'Incident title/symptom (create)',
      },
      severity: {
        type: 'string',
        enum: [...SEVERITIES],
        description: 'Incident severity (create)',
      },
      checkpoint_id: {
        type: 'string',
        description: 'Checkpoint id (switch_to, generate_handover)',
      },
    },
    required: ['action'],
  },

  schema: InputSchema,

  async run(input, context) {
    const list = await readCheckpoints(context.cwd)

    switch (input.action) {
      case 'create': {
        const cp: IncidentCheckpoint = {
          id: newCheckpointId(),
          name: input.name,
          incident_title: input.incident_title,
          severity: input.severity,
          created_at: Date.now(),
          hypothesis_summary: '',
          key_commands: [],
          active: false,
        }
        list.checkpoints.push(cp)
        const error = validateCheckpointList(list)
        if (error) {
          return { ok: false, output: error }
        }
        const limitNotice = enforceCheckpointLimit(list)
        await saveCheckpoints(context.cwd, list)
        const lines = [
          `Checkpoint created: ${cp.id} (${cp.name}, ${cp.severity})`,
          '',
          'Current checkpoints:',
          ...list.checkpoints.map(formatCheckpoint),
        ]
        if (limitNotice) lines.push('', limitNotice)
        return { ok: true, output: lines.join('\n') }
      }

      case 'list': {
        if (list.checkpoints.length === 0) {
          return { ok: true, output: 'No checkpoints yet. Use create to save one.' }
        }
        return {
          ok: true,
          output: [
            'Checkpoints:',
            ...list.checkpoints
              .slice()
              .sort((a, b) => b.created_at - a.created_at)
              .map(formatCheckpoint),
          ].join('\n'),
        }
      }

      case 'switch_to': {
        const cp = list.checkpoints.find(c => c.id === input.checkpoint_id)
        if (!cp) {
          return {
            ok: false,
            output: `Unknown checkpoint id "${input.checkpoint_id}". Known:\n${list.checkpoints.map(formatCheckpoint).join('\n')}`,
          }
        }
        for (const c of list.checkpoints) {
          c.active = c.id === cp.id
        }
        await saveCheckpoints(context.cwd, list)
        return {
          ok: true,
          output: `Now active: ${cp.id} (${cp.name}, ${cp.severity}) "${cp.incident_title}"`,
        }
      }

      case 'generate_handover': {
        const cp = input.checkpoint_id
          ? list.checkpoints.find(c => c.id === input.checkpoint_id)
          : list.checkpoints.find(c => c.active) ?? list.checkpoints[list.checkpoints.length - 1]
        if (!cp) {
          return {
            ok: false,
            output:
              'No checkpoint found. Create one first with action=create, or pass a checkpoint_id.',
          }
        }
        const handover = await buildHandover(context.cwd, cp)
        return {
          ok: true,
          output: `Handover brief for "${cp.name}" (id ${cp.id}):\n\n${handover}\n\n(File location: ${checkpointsFilePath(context.cwd)})`,
        }
      }
    }
  },
}
