import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'

const execFileAsync = promisify(execFile)

// --- Sources ---

const FileSourceSchema = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
})

const KubectlSourceSchema = z.object({
  type: z.literal('kubectl'),
  namespace: z.string().min(1),
  pod: z.string().min(1),
  container: z.string().optional(),
  previous: z.boolean().optional(),
})

const SourceSchema = z.discriminatedUnion('type', [
  FileSourceSchema,
  KubectlSourceSchema,
])

type LogSource = z.infer<typeof SourceSchema>

const DEFAULT_LINES = 100
const MAX_LINES = 10_000
/** 文件源单次读取的最大字节数，防止对超大日志文件 OOM。 */
const MAX_FILE_TAIL_BYTES = 10 * 1024 * 1024
/** kubectl logs stdout 缓冲上限。 */
const KUBECTL_MAX_BUFFER = 5 * 1024 * 1024

// --- Helpers ---

/** 将字符串按 \n 切成行数组，去掉单个尾随换行产生的空末行。 */
function splitLines(s: string): string[] {
  if (s.length === 0) return []
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s
  if (trimmed.length === 0) return []
  return trimmed.split('\n')
}

/** 从数据源拉取最后 N 行。 */
async function fetchTail(source: LogSource, lines: number): Promise<string[]> {
  if (source.type === 'file') {
    let content: string
    try {
      content = await readFile(source.path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(`Log file not found: ${source.path}`)
      }
      throw err
    }
    if (content.length > MAX_FILE_TAIL_BYTES) {
      // 仅查看尾部，避免对超大日志文件整体加载
      const tail = content.slice(-MAX_FILE_TAIL_BYTES)
      const tailLines = splitLines(tail)
      // 第一行可能被截断，丢弃
      return tailLines.slice(tailLines.length > 1 ? 1 : 0).slice(-lines)
    }
    return splitLines(content).slice(-lines)
  }

  // kubectl logs
  const args = [
    'logs',
    source.pod,
    '-n',
    source.namespace,
    '--tail',
    String(lines),
  ]
  if (source.container) args.push('-c', source.container)
  if (source.previous) args.push('--previous')

  try {
    const { stdout } = await __hooks.kubectlExec(args)
    return splitLines(stdout)
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') {
      throw new Error(
        'kubectl not found on PATH. Install kubectl or use a file source.',
      )
    }
    const stderr = (e.stderr ?? '').trim()
    throw new Error(
      `kubectl logs failed${stderr ? `: ${stderr}` : ` (exit code ${e.code ?? 'unknown'})`}`,
    )
  }
}

/**
 * 可测试性钩子：测试时可替换 kubectlExec 为 mock，避免依赖真实 kubectl 二进制。
 * 生产代码用真实 execFile。沿用 resetFollowSessions 的测试导出模式。
 */
export const __hooks = {
  kubectlExec: (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('kubectl', args, { maxBuffer: KUBECTL_MAX_BUFFER }),
}

// --- Follow sessions (in-memory, ephemeral) ---

interface FollowSession {
  source: LogSource
  lines: number
  lastSeenLines: string[]
  createdAt: number
}

const followSessions = new Map<string, FollowSession>()

/** 清空所有 follow 会话。仅供测试使用。 */
export function resetFollowSessions(): void {
  followSessions.clear()
}

function newSessionId(): string {
  return `fl_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

/**
 * 计算自上次以来的新行：在 current 中找到 prev 最后一行出现的位置，
 * 返回其后的所有行。若未找到（日志轮转/重置），返回整个 current。
 */
function diffNewLines(prev: string[], current: string[]): string[] {
  if (prev.length === 0) return current
  if (current.length === 0) return []
  const lastPrev = prev[prev.length - 1]!
  for (let i = 0; i < current.length; i++) {
    if (current[i] === lastPrev) {
      return current.slice(i + 1)
    }
  }
  return current
}

// --- Tool 1: tail_logs (stateless one-shot) ---

const TailLogsInputSchema = z.object({
  source: SourceSchema,
  lines: z.number().int().min(1).max(MAX_LINES).optional(),
})

type TailLogsInput = z.infer<typeof TailLogsInputSchema>

export const tailLogsTool: ToolDefinition<TailLogsInput> = {
  name: 'tail_logs',
  description:
    'Read the last N lines of a log source (one-shot). Source can be a file path or kubectl logs (namespace + pod). Returns the trailing lines verbatim. For ongoing monitoring, use follow_logs instead.',

  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'object',
        description:
          'Log source. Use {"type":"file","path":"/var/log/app.log"} for a file, or {"type":"kubectl","namespace":"sock-shop","pod":"payment-abc123","container":"payment","previous":false} for kubectl logs.',
        properties: {
          type: { type: 'string', enum: ['file', 'kubectl'] },
          path: { type: 'string', description: 'File path (type=file)' },
          namespace: { type: 'string', description: 'K8s namespace (type=kubectl)' },
          pod: { type: 'string', description: 'Pod name (type=kubectl)' },
          container: { type: 'string', description: 'Container name (type=kubectl, optional)' },
          previous: {
            type: 'boolean',
            description: 'Read previous container instance logs (type=kubectl, optional)',
          },
        },
        required: ['type'],
      },
      lines: {
        type: 'number',
        description: `Number of trailing lines to return (default ${DEFAULT_LINES}, max ${MAX_LINES})`,
      },
    },
    required: ['source'],
  },

  schema: TailLogsInputSchema,
  isReadOnly: true,

  async run(input) {
    const n = input.lines ?? DEFAULT_LINES
    try {
      const lines = await fetchTail(input.source, n)
      if (lines.length === 0) {
        return { ok: true, output: '(empty log)' }
      }
      return { ok: true, output: lines.join('\n') }
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  },
}

// --- Tool 2: follow_logs (create session OR poll existing) ---

const FollowLogsInputSchema = z
  .object({
    source: SourceSchema.optional(),
    session_id: z.string().min(1).optional(),
    lines: z.number().int().min(1).max(MAX_LINES).optional(),
  })
  .refine(
    (v) => (v.source !== undefined) !== (v.session_id !== undefined),
    'Provide exactly one of "source" (to create a new follow session) or "session_id" (to poll an existing session).',
  )

type FollowLogsInput = z.infer<typeof FollowLogsInputSchema>

export const followLogsTool: ToolDefinition<FollowLogsInput> = {
  name: 'follow_logs',
  description:
    'Follow a log source for new lines. First call with a "source" creates a follow session and returns the initial tail plus a session_id. Subsequent calls with a "session_id" return only the lines appended since the last poll (empty output if nothing new). Use stop_follow to tear down the session when done.',

  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'object',
        description:
          'Log source (only for creating a new session). See tail_logs for shape.',
        properties: {
          type: { type: 'string', enum: ['file', 'kubectl'] },
          path: { type: 'string' },
          namespace: { type: 'string' },
          pod: { type: 'string' },
          container: { type: 'string' },
          previous: { type: 'boolean' },
        },
        required: ['type'],
      },
      session_id: {
        type: 'string',
        description: 'Existing follow session id (only for polling).',
      },
      lines: {
        type: 'number',
        description: `Initial tail line count when creating (default ${DEFAULT_LINES}, max ${MAX_LINES}). Ignored when polling.`,
      },
    },
    description:
      'Provide "source" to create, or "session_id" to poll. Not both, not neither.',
  },

  schema: FollowLogsInputSchema,
  isReadOnly: false, // mutates session state

  async run(input) {
    // Poll existing session
    if (input.session_id !== undefined) {
      const session = followSessions.get(input.session_id)
      if (!session) {
        return {
          ok: false,
          output: `Unknown follow session: ${input.session_id}. Create one with a "source" first, or check the id.`,
        }
      }
      try {
        const current = await fetchTail(session.source, session.lines)
        const newLines = diffNewLines(session.lastSeenLines, current)
        session.lastSeenLines = current
        if (newLines.length === 0) {
          return { ok: true, output: '(no new lines since last poll)' }
        }
        return { ok: true, output: newLines.join('\n') }
      } catch (err) {
        return {
          ok: false,
          output: err instanceof Error ? err.message : String(err),
        }
      }
    }

    // Create new session
    const n = input.lines ?? DEFAULT_LINES
    try {
      const initial = await fetchTail(input.source!, n)
      const id = newSessionId()
      followSessions.set(id, {
        source: input.source!,
        lines: n,
        lastSeenLines: initial,
        createdAt: Date.now(),
      })
      const header = `Follow session created: ${id}\nSource: ${input.source!.type}\nInitial tail (${initial.length} lines):`
      const body = initial.length === 0 ? '(empty log)' : initial.join('\n')
      return { ok: true, output: `${header}\n${body}` }
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  },
}

// --- Tool 3: stop_follow ---

const StopFollowInputSchema = z.object({
  session_id: z.string().min(1),
})

type StopFollowInput = z.infer<typeof StopFollowInputSchema>

export const stopFollowTool: ToolDefinition<StopFollowInput> = {
  name: 'stop_follow',
  description:
    'Stop and remove a follow_logs session. Call this when you are done monitoring a log source, to free the session.',

  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Follow session id to tear down.',
      },
    },
    required: ['session_id'],
  },

  schema: StopFollowInputSchema,
  isReadOnly: false, // mutates session state

  async run(input) {
    if (!followSessions.has(input.session_id)) {
      return {
        ok: false,
        output: `Unknown follow session: ${input.session_id}. Nothing to stop.`,
      }
    }
    followSessions.delete(input.session_id)
    return { ok: true, output: `Follow session stopped: ${input.session_id}` }
  },
}
