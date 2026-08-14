import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

// Claude Code separates "read-only shell commands" from mutating/runtime commands.
// We keep the same shape here so safe observability commands are easy to extend.
const READONLY_COMMANDS = new Set([
  'pwd',
  'ls',
  'find',
  'rg',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'sed',
  'echo',
  'df',
  'du',
  'free',
  'uname',
  'uptime',
  'whoami',
])

const DEVELOPMENT_COMMANDS = new Set([
  'git',
  'npm',
  'node',
  'python3',
  'pytest',
  'bash',
  'sh',
  'bun',
])

// SRE 只读诊断命令集（子命令级白名单，防止 kubectl delete 等写操作误入）
const SRE_READONLY_COMMANDS = new Set([
  'kubectl',
  'docker',
  'curl',
  'wget',
  'jq',
  'column',
])

const KUBECTL_READONLY_SUBCOMMANDS = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'diff',
  'version',
])

const DOCKER_READONLY_SUBCOMMANDS = new Set([
  'ps',
  'logs',
  'stats',
  'inspect',
  'version',
  'images',
])

// curl/wget 危险 HTTP 方法（写操作）
const DANGEROUS_HTTP_METHODS = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

function isAllowedCommand(command: string): boolean {
  return (
    READONLY_COMMANDS.has(command) ||
    DEVELOPMENT_COMMANDS.has(command) ||
    SRE_READONLY_COMMANDS.has(command)
  )
}

function isReadOnlyCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command)
}

/**
 * 判定 SRE 命令是否为只读诊断命令（子命令级白名单）。
 * kubectl/docker 需校验子命令；curl/wget 需校验无写方法；jq/column 纯只读。
 */
export function isSreReadOnlyCommand(command: string, args?: string[]): boolean {
  if (!SRE_READONLY_COMMANDS.has(command)) return false

  if (command === 'kubectl') {
    const sub = args?.[0]
    return sub !== undefined && KUBECTL_READONLY_SUBCOMMANDS.has(sub)
  }

  if (command === 'docker') {
    const sub = args?.[0]
    return sub !== undefined && DOCKER_READONLY_SUBCOMMANDS.has(sub)
  }

  if (command === 'curl' || command === 'wget') {
    // 检查是否含写方法标志（-X POST / --method PUT 等）
    const hasWriteMethod = args?.some((arg, idx) => {
      if (arg === '-X' || arg === '--request') {
        const method = args[idx + 1]?.toUpperCase()
        return method !== undefined && DANGEROUS_HTTP_METHODS.has(method)
      }
      // -XPOST 紧凑形式
      const compact = arg.match(/^-[Xx](\w+)$/)
      if (compact) {
        return DANGEROUS_HTTP_METHODS.has(compact[1].toUpperCase())
      }
      return false
    })
    return !hasWriteMethod
  }

  // jq / column 纯只读
  return true
}

// 并发安全只读命令白名单（保守集，不含 sed/vim 等可写工具）。
// 与上层 READONLY_COMMANDS 解耦：该集合仅供 run_command 执行路径的权限判断，
// 而并发的只读判定必须排除一切可能写盘的命令。
const CONCURRENT_READONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'echo',
  'pwd',
  'which',
  'date',
  'env',
  'whoami',
  'uname',
  'df',
  'du',
  'free',
  'uptime',
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
export function isReadOnlyCommandCall(input: {
  command: string
  args?: string[]
}): boolean {
  const trimmed = input.command.trim()
  if (!trimmed) return false

  if ((input.args?.length ?? 0) > 0) {
    return isReadOnlyArgv(trimmed, input.args!)
  }

  return isReadOnlySnippet(trimmed)
}

function isReadOnlyArgv(argv0: string, args: string[]): boolean {
  if (args.some(hasDangerousToken)) return false

  if (argv0 === 'git') {
    const sub = args[0]
    return sub !== undefined && CONCURRENT_READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  // SRE 只读诊断命令（kubectl get/logs、docker ps/logs、curl GET 等）
  if (isSreReadOnlyCommand(argv0, args)) return true

  return CONCURRENT_READONLY_COMMANDS.has(argv0)
}

function isReadOnlySnippet(command: string): boolean {
  // 拆成 shell 段（| & && || ; 各自成段），但若是命令替换/重定向等，直接拒。
  const segments = command
    .split(/(&&|\|\||[|;])/g)
    .map(segment => segment.trim())
    .filter(Boolean)

  for (const segment of segments) {
    if (segment === '&&' || segment === '||' || segment === '|' || segment === ';') {
      continue
    }
    if (!isReadOnlySegment(segment)) {
      return false
    }
  }
  return true
}

function isReadOnlySegment(segment: string): boolean {
  // 重定向 / 命令替换 / 后台符 / 子 shell —— 一律非只读
  if (hasDangerousToken(segment)) return false

  const [argv0, ...argv] = splitCommandLine(segment)
  if (!argv0) return false

  if (argv0 === 'git') {
    const sub = argv[0]
    return sub !== undefined && CONCURRENT_READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  // SRE 只读诊断命令
  if (isSreReadOnlyCommand(argv0, argv)) return true

  return CONCURRENT_READONLY_COMMANDS.has(argv0)
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

  return /[|&;<>()$`]/.test(command)
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
      if (
        !isReadOnlyCommandCall({
          command: normalized.command,
          args: normalized.args,
        })
      ) {
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

    if (forcePromptReason) {
      await context.permissions?.ensureCommand(command, args, effectiveCwd, {
        forcePromptReason,
      })
    } else if (useShell || !isReadOnlyCommand(normalized.command)) {
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
    })

    return {
      ok: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  },
}
