import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'
import {
  classifySecretAccess,
  evaluateCommandArgv,
  evaluateCommandSnippet,
  isReadOnlyCommandCall,
  splitCommandLine,
} from './command-guard.js'

// 白名单与命令判定已收敛到 command-guard.ts（免审批管线与并发判定共用一份名单，
// 避免两处漂移）；这里 re-export 维持既有公开面。
export { isReadOnlyCommandCall, isSreReadOnlyCommand } from './command-guard.js'

const execFileAsync = promisify(execFile)

type Input = {
  command: string
  args?: string[]
  cwd?: string
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
    const executableSnippet = backgroundShell
      ? stripTrailingBackgroundOperator(input.command)
      : input.command

    const command = useShell ? 'bash' : normalized.command
    const args = useShell ? ['-lc', executableSnippet] : normalized.args

    // 无 permissions 上下文时，强制只允许只读命令（fail-closed，沿用并发级严名单），
    // 并叠加 secret 硬拦——防止无审批通道的巡检实例静默读取集群密钥。
    if (!context.permissions) {
      const secret = classifySecretAccess(normalized.command, normalized.args)
      if (
        secret ||
        !isReadOnlyCommandCall({
          command: normalized.command,
          args: normalized.args,
        })
      ) {
        return {
          ok: false,
          output: `Command not allowed without permission manager (read-only mode): ${normalized.command}`,
        }
      }
    }

    // 五级判定管线：拆段 → secret 硬拦 → 参数原语 → 段级白名单 → 汇总。
    // deny：无审批出口直接拒（secret 暴露 / sudo 提权）；
    // allow：全段过白名单，免审批执行（消掉 snippet 一刀切）；
    // approval：转权限底座（三层名单 → 无回调硬拒 → 审批框）。
    const guard = useShell
      ? evaluateCommandSnippet(executableSnippet)
      : evaluateCommandArgv(normalized.command, normalized.args)

    if (guard.verdict === 'deny') {
      return {
        ok: false,
        output: `Command denied by command guard: ${guard.reason ?? 'policy violation'}`,
      }
    }

    if (guard.verdict === 'approval') {
      await context.permissions?.ensureCommand(command, args, effectiveCwd, {
        forcePromptReason: guard.reason,
      })
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
