const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const BRIGHT_RED = '\u001b[91m'

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

const LOG_TOOLS = new Set(['tail_logs', 'follow_logs'])

export function isLogTool(toolName: string): boolean {
  return LOG_TOOLS.has(toolName)
}

const LEVEL_PATTERN =
  /\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\b/i

/** 识别一行的日志级别 token，常见形态如 `[ERROR]`、` ERROR `、`level=error`、`"level":"error"`。 */
export function detectLogLevel(line: string): LogLevel | null {
  const match = line.match(LEVEL_PATTERN)
  if (!match) return null
  const raw = match[1]!
  const upper = raw.toUpperCase()
  if (upper === 'WARNING') return 'WARN'
  return upper as LogLevel
}

function colorFor(level: LogLevel): string {
  switch (level) {
    case 'ERROR':
      return BRIGHT_RED
    case 'WARN':
      return YELLOW
    case 'INFO':
      return CYAN
    case 'DEBUG':
      return DIM
  }
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/

/** 识别并柔和着色行首的 ISO 时间戳，其余原样返回。 */
function colorTimestamp(line: string): string {
  const match = line.match(ISO_TIMESTAMP_PATTERN)
  if (!match) return line
  const ts = match[0]!
  return `${DIM}${ts}${RESET}${line.slice(ts.length)}`
}

export function renderLogBody(body: string): string {
  return body
    .split('\n')
    .map(line => {
      const level = detectLogLevel(line)
      const colored = level === null ? line : colorFor(level) + line + RESET
      return colorTimestamp(colored)
    })
    .join('\n')
}