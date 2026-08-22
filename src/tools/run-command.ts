import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'
import { SRE_READONLY_COMMANDS, isSreReadOnlyCommand } from './sre-whitelist.js'

const execFileAsync = promisify(execFile)

/** 前台命令执行超时，防止命令卡死阻塞整个 agent turn。 */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

// lite-ai 作为 SRE 事故诊断助手，run_command 只保留只读诊断命令（SRE 通道）。
// 值班机默认无源码，不暴露开发类命令与本地文件读取，避免 agent 越权访问测试数据/任意文件。
// 本地日志读取统一走 tail_logs，不依赖 run_command 读文件。
//
// 注：以下常量已不含 dev 命令（git/npm/node/python/bash 等）以及任意读文件命令（cat/tail/head/wc
// 读取本地文件需审批）。但管道的过滤段（grep/tr/sort/head 等）仍保留在
// CONCURRENT_READONLY_COMMANDS 中，因为 `kubectl ... | grep` 这类过滤是 SRE 诊断的合法用法，
// 且过滤工具不直接读取本地文件（fail-closed：文件读取需经过审批）。
const READONLY_COMMANDS = new Set([
  'pwd',
  'ls',
  'df',
  'du',
  'free',
  'uname',
  'uptime',
  'whoami',
])

function isAllowedCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command) || SRE_READONLY_COMMANDS.has(command)
}

function isReadOnlyCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command)
}

// 并发安全只读命令白名单（保守集）。
// 不含 sed/vim 等可写工具，也不含 cat/tail/head/wc（它们可读任意本地文件，需审批，不可并发放行）；
// 仅含纯系统状态查询 + 不落盘的外部命令 + 过滤管道段。
const CONCURRENT_READONLY_COMMANDS = new Set([
  'ls',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'echo',
  'pwd',
  'which',
  'date',
  'whoami',
  'uname',
  'df',
  'du',
  'free',
  'uptime',
  // 只读过滤管道工具（不写盘、不执行外部程序，可与 curl/kubectl 安全管道联用）
  // 注意：head/tail/cat/wc 因可直接读本地文件，未纳入并发放行。
  'tr',
  'sort',
  'uniq',
  'cut',
  'awk',
  'basename',
  'dirname',
])

const CONCURRENT_READONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
])

// 若命令含这些字符，判定为可能写盘/副作用，不得并行。
const DANGEROUS_PATTERN = /[><&$`|;]/

function hasDangerousToken(token: string): boolean {
  return DANGEROUS_PATTERN.test(token)
}

/**
 * 判定一次 run_command 调用实例是否可并发执行（只读）。
 * fail-closed：任何无法 100% 确认只读的情况都返回 false。
 * - 带 args 数组：command 为 argv0，args 为 argv1..；仅白名单命令 + git 只读子命令通过。
 * - 单字符串 command：按 shell 分隔符拆段，逐段校验 argv0 与危险符号。
 * 绝不复用 isReadOnlyCommand（其白名单含 sed）。
 */
export function isReadOnlyCommandCall(
  input: {
    command: string
    args?: string[]
  },
  allowedUrlPrefixes?: Iterable<string>,
): boolean {
  const trimmed = input.command.trim()
  if (!trimmed) return false

  if ((input.args?.length ?? 0) > 0) {
    return isReadOnlyArgv(trimmed, input.args!, allowedUrlPrefixes)
  }

  return isReadOnlySnippet(trimmed, allowedUrlPrefixes)
}

function isReadOnlyArgv(
  argv0: string,
  args: string[],
  allowedUrlPrefixes?: Iterable<string>,
): boolean {
  if (args.some(hasDangerousToken)) return false

  if (argv0 === 'git') {
    const sub = args[0]
    return sub !== undefined && CONCURRENT_READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  // SRE 只读诊断命令（kubectl get/logs、docker ps/logs、curl GET 等）
  if (isSreReadOnlyCommand(argv0, args, allowedUrlPrefixes)) return true

  return CONCURRENT_READONLY_COMMANDS.has(argv0)
}

/**
 * 引号感知地按 shell 管道/分隔符拆分命令串。
 * 与 splitCommandLine 保持同样的引号转义规则，避免引号内的 `|`（如 grep 正则）被误拆。
 */
function splitShellSegments(commandLine: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i]

    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      current += char
      escaping = true
      continue
    }

    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    // 引号外的分隔符：| ; && ||。裸 &（后台符）直接判为不安全，不得静默放行。
    // 换行 \n / 回车 \r 也视为分隔符，防止 "grep x\nrm -rf /" 这类多行片段被判定为单一只读段后经
    // bash -lc 把换行后的写命令静默执行（判定器与执行器语义不一致）。
    if (char === '|' || char === ';' || char === '\n' || char === '\r') {
      segments.push(current.trim())
      current = ''
      continue
    }
    if (char === '&') {
      if (commandLine[i + 1] === '&') {
        segments.push(current.trim())
        current = ''
        i++
        continue
      }
      // 裸 &（后台执行）：追加哨兵段，使整条命令不可放行
      segments.push(current.trim(), '\u0000background')
      current = ''
      return segments.filter(s => s !== '')
    }

    current += char
  }

  if (escaping) current += '\\'
  segments.push(current.trim())
  return segments.filter(Boolean)
}

function isReadOnlySnippet(command: string, allowedUrlPrefixes?: Iterable<string>): boolean {
  // 引号感知地拆成 shell 段，逐段校验；命令替换/重定向等危险符号直接拒。
  const segments = splitShellSegments(command)

  for (const segment of segments) {
    if (!isReadOnlySegment(segment, allowedUrlPrefixes)) {
      return false
    }
  }
  return true
}

/**
 * 剥离前导的 shell 包装（bash -lc / bash -c），返回真正的可执行命令与参数。
 * 用于只读判定，避免模型偶发用 "bash -lc <cmd>" 包装时被误判为非只读。
 * 支持多层嵌套剥离；包装后若为单个引号串命令，则按引号串重新分词。
 */
function stripShellWrapper(argv0: string, args: string[]): { cmd: string; argv: string[] } {
  let cmd = argv0
  let argv = args
  for (;;) {
    if (cmd !== 'bash' && cmd !== 'sh') break
    const flag = argv[0]
    if (flag !== '-lc' && flag !== '-c' && flag !== '-c ') break
    if (argv[1] === undefined) break
    // 包装后的剩余部分可能是整体引号串命令，也可能是分开的 token
    const rest = argv.slice(1)
    if (rest.length === 1) {
      const sub = splitCommandLine(rest[0]!)
      cmd = sub[0] ?? ''
      argv = sub.slice(1)
    } else {
      cmd = rest[0]!
      argv = rest.slice(1)
    }
  }
  return { cmd, argv }
}

function isReadOnlySegment(
  segment: string,
  allowedUrlPrefixes?: Iterable<string>,
): boolean {
  const tokens = splitCommandLine(segment)
  if (tokens.length === 0) return false

  // 引号感知拆分后，逐 token 检查危险符号（重定向/命令替换/后台符等），
  // 引号内的 `|`、`&` 等已随引号剥离，不会误报。
  for (const token of tokens) {
    if (token.includes('>') || token.includes('<') || token.includes('$') || token.includes('`')) {
      return false
    }
  }

  const [argv0, ...argv] = tokens
  if (!argv0) return false

  // 剥离可能的 bash -c/-lc 前导包装，再判定真实命令是否只读
  const { cmd, argv: innerArgv } = stripShellWrapper(argv0, argv)

  if (cmd === 'git') {
    const sub = innerArgv[0]
    return sub !== undefined && CONCURRENT_READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  // SRE 只读诊断命令
  if (isSreReadOnlyCommand(cmd, innerArgv, allowedUrlPrefixes)) return true

  return CONCURRENT_READONLY_COMMANDS.has(cmd)
}

type Input = {
  command: string
  args?: string[]
  cwd?: string
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of commandLine) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (escaping) {
    current += '\\'
  }

  if (current.length > 0) {
    parts.push(current)
  }

  return parts
}

function normalizeCommandInput(input: Input): {
  command: string
  args: string[]
} {
  if ((input.args?.length ?? 0) > 0) {
    return {
      command: input.command.trim(),
      args: input.args ?? [],
    }
  }

  const trimmed = input.command.trim()
  if (!trimmed) {
    return { command: '', args: [] }
  }

  // Accept single-string invocations like "git status" from the model.
  const parsed = splitCommandLine(trimmed)
  const [command = '', ...args] = parsed
  return { command, args }
}

function looksLikeShellSnippet(command: string, args?: string[]): boolean {
  if ((args?.length ?? 0) > 0) {
    return false
  }

  // 引号感知：仅当 shell 操作符出现在引号之外时才视为 shell 片段。
  // URL 查询串（如 "http://host/path?a=1&b=2"）里的 & 位于引号内，不是 shell 操作符，
  // 不应把 curl 等简单命令路由到 bash（Windows 上 bash 不可用会直接失败）。
  let quote: '"' | "'" | null = null
  let escaping = false
  for (const char of command) {
    if (escaping) {
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/[|&;<>()$`]/.test(char)) {
      return true
    }
  }
  return false
}

function isBackgroundShellSnippet(command: string, args?: string[]): boolean {
  if ((args?.length ?? 0) > 0) {
    return false
  }

  const trimmed = command.trim()
  return trimmed.endsWith('&') && !trimmed.endsWith('&&')
}

function stripTrailingBackgroundOperator(command: string): string {
  return command.trim().replace(/&\s*$/, '').trim()
}

export const runCommandTool: ToolDefinition<Input> = {
  name: 'run_command',
  description:
    'Run a common development command from an allowlist. For shell pipelines or variable expansion, pass the full snippet in command and lite-ai will run it via bash -lc.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' },
      },
      cwd: { type: 'string' },
    },
    required: ['command'],
  },
  schema: z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  async run(input, context) {
    const effectiveCwd = input.cwd
      ? await resolveToolPath(context, input.cwd, 'list')
      : context.cwd

    const normalized = normalizeCommandInput(input)
    if (!normalized.command) {
      return {
        ok: false,
        output: 'Command not allowed: empty command',
      }
    }

    const useShell = looksLikeShellSnippet(input.command, input.args)
    const backgroundShell = isBackgroundShellSnippet(input.command, input.args)

    const knownCommand = isAllowedCommand(normalized.command)

    const command = useShell ? 'bash' : normalized.command
    const args = useShell
      ? ['-lc', backgroundShell ? stripTrailingBackgroundOperator(input.command) : input.command]
      : normalized.args

    // 子 agent 无 permissions 时，强制只允许只读命令（fail-closed）。
    // 防止子 agent 在无审批通道的情况下执行写操作。
    if (!context.permissions) {
      if (!isReadOnlyCommandCall({ command: normalized.command, args: normalized.args })) {
        return {
          ok: false,
          output: `Command not allowed without permission manager (sub-agent read-only mode): ${normalized.command}`,
        }
      }
    }

    const forcePromptReason =
      !useShell && !knownCommand
        ? `Unknown command '${normalized.command}' is not in the built-in read-only/development set`
        : undefined

    // 命中 SRE 只读白名单的管道/命令跳过审批弹窗；仅当显著非只读时才走 ensureCommand。
    const readonlyShellPipeline = isReadOnlyCommandCall({
      command: input.command,
      args: input.args,
    })

    if (forcePromptReason) {
      await context.permissions?.ensureCommand(command, args, effectiveCwd, {
        forcePromptReason,
      })
    } else if (!readonlyShellPipeline && (useShell || !isReadOnlyCommand(normalized.command))) {
      await context.permissions?.ensureCommand(command, args, effectiveCwd)
    }

    if (useShell && backgroundShell) {
      const child = spawn(command, args, {
        cwd: effectiveCwd,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()

      const backgroundTask = registerBackgroundShellTask({
        command: stripTrailingBackgroundOperator(input.command),
        pid: child.pid ?? -1,
        cwd: effectiveCwd,
      })

      return {
        ok: true,
        output: `Background command started.\nTASK: ${backgroundTask.taskId}\nPID: ${backgroundTask.pid}`,
        backgroundTask,
      }
    }

    const result = await execFileAsync(command, args, {
      cwd: effectiveCwd,
      maxBuffer: 1024 * 1024,
      env: process.env,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })

    return {
      ok: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  },
}
