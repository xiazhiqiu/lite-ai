import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import {
  AbortMutationError,
  type Evidence,
  type Hypothesis,
  HYPOTHESIS_STATUSES,
  isHypothesisStatus,
  readHypotheses,
  updateHypotheses,
  validateHypothesisList,
  summarizeHypotheses,
} from '../utils/hypothesis-store.js'

const ACTIONS = [
  'add_hypothesis',
  'add_evidence',
  'update_status',
  'get_summary',
] as const

const EvidenceSchema = z.object({
  command: z.string().min(1),
  output_summary: z.string().min(1),
  data_source: z.string().min(1),
  timestamp: z.number(),
  supports: z.boolean(),
})

const InputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add_hypothesis'),
    id: z.string().min(1),
    description: z.string().min(1),
    priority: z.number().int().min(1).max(5),
  }),
  z.object({
    action: z.literal('add_evidence'),
    hypothesis_id: z.string().min(1),
    evidence: EvidenceSchema,
  }),
  z.object({
    action: z.literal('update_status'),
    hypothesis_id: z.string().min(1),
    status: z.enum(HYPOTHESIS_STATUSES),
    conclusion: z.string().optional(),
  }),
  z.object({
    action: z.literal('get_summary'),
  }),
])

type Input = z.infer<typeof InputSchema>

function formatHypothesisTree(hypotheses: Hypothesis[]): string {
  const sorted = [...hypotheses].sort(
    (a, b) => a.priority - b.priority || a.created_at - b.created_at,
  )
  const lines = sorted.map(h => {
    const evidenceLines = h.evidence.map(
      e =>
        `    - ${e.supports ? 'SUPPORTS' : 'REFUTES'} [${e.data_source}] \`${e.command}\`: ${e.output_summary}`,
    )
    const conclusion = h.conclusion ? `\n    Conclusion: ${h.conclusion}` : ''
    return [
      `[${h.status}] P${h.priority} ${h.id}: ${h.description}${conclusion}`,
      ...evidenceLines,
    ].join('\n')
  })
  return lines.join('\n\n')
}

function formatSummary(
  hypotheses: Hypothesis[],
  actionResult: string,
): string {
  const summary = summarizeHypotheses({
    incident: '',
    updatedAt: new Date().toISOString(),
    hypotheses,
  })
  const counts = [
    `Active: ${summary.active}`,
    `Confirmed: ${summary.confirmed}`,
    `Refuted: ${summary.refuted}`,
    `Inconclusive: ${hypotheses.filter(h => h.status === 'inconclusive').length}`,
  ].join(' | ')
  return `${actionResult}\n\nHypothesis count: ${hypotheses.length} (${counts})\n\nFull hypothesis tree:\n${formatHypothesisTree(hypotheses)}`
}

export const hypothesisTrackerTool: ToolDefinition<Input> = {
  name: 'hypothesis_tracker',
  description:
    'Manage the hypothesis-evidence chain during incident diagnosis. Use add_hypothesis to register a candidate root cause (sorted by priority 1-5). Use add_evidence to attach evidence from a diagnostic command. Use update_status to mark a hypothesis as confirmed/refuted/inconclusive. Use get_summary to retrieve the full hypothesis tree at any time. Refuted hypotheses are never deleted.',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'The operation to perform',
      },
      id: { type: 'string', description: 'Unique hypothesis id (add_hypothesis)' },
      description: {
        type: 'string',
        description: 'Hypothesis description (add_hypothesis)',
      },
      priority: {
        type: 'number',
        description: 'Priority 1-5, 1=most likely (add_hypothesis)',
      },
      hypothesis_id: {
        type: 'string',
        description: 'Hypothesis id to target (add_evidence, update_status)',
      },
      status: {
        type: 'string',
        enum: [...HYPOTHESIS_STATUSES],
        description: 'New status (update_status)',
      },
      conclusion: {
        type: 'string',
        description: 'Optional conclusion text (update_status)',
      },
      evidence: {
        type: 'object',
        description: 'Evidence object (add_evidence)',
        properties: {
          command: { type: 'string' },
          output_summary: { type: 'string' },
          data_source: { type: 'string' },
          timestamp: { type: 'number' },
          supports: { type: 'boolean' },
        },
        required: [
          'command',
          'output_summary',
          'data_source',
          'timestamp',
          'supports',
        ],
      },
    },
    required: ['action'],
  },

  schema: InputSchema,

  async run(input, context) {
    switch (input.action) {
      case 'add_hypothesis': {
        let failure: string | null = null
        const list = await updateHypotheses(context.cwd, cur => {
          if (cur.hypotheses.find(h => h.id === input.id)) {
            failure = `Hypothesis id "${input.id}" already exists. Use update_status to modify it.`
            throw new AbortMutationError()
          }
          cur.hypotheses.push({
            id: input.id,
            description: input.description,
            priority: input.priority,
            status: 'pending',
            created_at: Date.now(),
            evidence: [],
          })
          const error = validateHypothesisList(cur)
          if (error) {
            failure = error
            throw new AbortMutationError()
          }
        })
        if (failure) {
          return { ok: false, output: failure }
        }
        return {
          ok: true,
          output: formatSummary(
            list.hypotheses,
            `Hypothesis added: [P${input.priority}] ${input.description}`,
          ),
        }
      }

      case 'add_evidence': {
        let failure: string | null = null
        const list = await updateHypotheses(context.cwd, cur => {
          const hypothesis = cur.hypotheses.find(
            h => h.id === input.hypothesis_id,
          )
          if (!hypothesis) {
            failure = `Unknown hypothesis id "${input.hypothesis_id}". Registered hypotheses:\n${cur.hypotheses.map(h => `  - ${h.id}: ${h.description} [${h.status}]`).join('\n')}`
            throw new AbortMutationError()
          }
          hypothesis.evidence.push(input.evidence)
          const error = validateHypothesisList(cur)
          if (error) {
            failure = error
            throw new AbortMutationError()
          }
        })
        if (failure) {
          return { ok: false, output: failure }
        }
        return {
          ok: true,
          output: formatSummary(
            list.hypotheses,
            `Evidence added to "${input.hypothesis_id}": ${input.evidence.supports ? 'SUPPORTS' : 'REFUTES'} (${input.evidence.data_source})`,
          ),
        }
      }

      case 'update_status': {
        let failure: string | null = null
        const list = await updateHypotheses(context.cwd, cur => {
          const hypothesis = cur.hypotheses.find(
            h => h.id === input.hypothesis_id,
          )
          if (!hypothesis) {
            failure = `Unknown hypothesis id "${input.hypothesis_id}". Registered hypotheses:\n${cur.hypotheses.map(h => `  - ${h.id}: ${h.description} [${h.status}]`).join('\n')}`
            throw new AbortMutationError()
          }
          hypothesis.status = input.status
          if (input.conclusion !== undefined) {
            hypothesis.conclusion = input.conclusion
          }
          const error = validateHypothesisList(cur)
          if (error) {
            failure = error
            throw new AbortMutationError()
          }
        })
        if (failure) {
          return { ok: false, output: failure }
        }
        return {
          ok: true,
          output: formatSummary(
            list.hypotheses,
            `Hypothesis "${input.hypothesis_id}" status updated to ${input.status}.`,
          ),
        }
      }

      case 'get_summary': {
        const list = await readHypotheses(context.cwd)
        return {
          ok: true,
          output: formatSummary(
            list.hypotheses,
            'Current hypothesis-evidence chain:',
          ),
        }
      }
    }
  },
}