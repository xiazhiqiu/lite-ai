import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'
import {
  classifySecretAccess,
  evaluateCommandSnippet,
  isReadOnlyCommandCall,
  splitCommandLine,
} from './command-guard.js'

const execFileAsync = promisify(execFile)

type Input = {
  command: string
  cwd?: string
}

/**
 * 对齐 HolmesGPT bash toolset 的纯 shell 形态：整条命令字符串一律经
 * bash -lc 执行，不再提供 argv 数组形态，也没有 argv/shell 自动分流。
 * 安全判定走 command-guard 五级管线（拆段 → secret 硬拦 → 参数原语 →
 * 段级白名单 → 三态汇总），无 permissions 上下文时强制只读白名单
 * （fail-closed，供无人值守巡检使用）。
 */
export const bashTool: ToolDefinition<Input> = {
  name: 'bash',
  description:
    'Execute a bash command and return its output. Supports single commands, pipes (|), &&, || and ;. ' +
    'Loops, conditionals and subshells require user approval. Read-only commands run without approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
    },
    required: ['command'],
  },
  schema: z.object({
    command: z.string(),
    cwd: z.string().optional(),
  }),
  async run(input, context) {
    const effectiveCwd = input.cwd
      ? await resolveToolPath(context, input.cwd, 'list')
      : context.cwd

    const command = input.command.trim()
    if (!command) {
      return {
        ok: false,
        output: 'Command not allowed: empty command',
      }
    }

    // 无 permissions 上下文时，强制只允许只读命令（fail-closed，沿用并发级严名单），
    // 并叠加 secret 硬拦——防止无审批通道的巡检实例静默读取集群密钥。
    if (!context.permissions) {
      const [argv0 = '', ...argv] = splitCommandLine(command)
      const secret = classifySecretAccess(argv0, argv)
      if (secret || !isReadOnlyCommandCall({ command })) {
        return {
          ok: false,
          output: `Command not allowed without permission manager (read-only mode): ${command}`,
        }
      }
    }

    // 五级判定管线（纯 shell 形态统一走 snippet 入口）：
    // deny：无审批出口直接拒（secret 暴露 / sudo 提权）；
    // approval：转权限底座（三层名单 → 无回调硬拒 → 审批框）；
    // allow：全段过白名单，免审批执行。
    const guard = evaluateCommandSnippet(command)

    if (guard.verdict === 'deny') {
      return {
        ok: false,
        output: `Command denied by command guard: ${guard.reason ?? 'policy violation'}`,
      }
    }

    if (guard.verdict === 'approval') {
      await context.permissions?.ensureCommand('bash', ['-lc', command], effectiveCwd, {
        forcePromptReason: guard.reason,
      })
    }

    // 独立后台符 &：剥离后 detached 执行并登记后台任务。
    const trimmedEnd = command
    if (trimmedEnd.endsWith('&') && !trimmedEnd.endsWith('&&')) {
      const executable = stripTrailingBackgroundOperator(command)
      const child = spawn('bash', ['-lc', executable], {
        cwd: effectiveCwd,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()

      const backgroundTask = registerBackgroundShellTask({
        command,
        pid: child.pid ?? -1,
        cwd: effectiveCwd,
      })

      return {
        ok: true,
        output: `Background command started.\nTASK: ${backgroundTask.taskId}\nPID: ${backgroundTask.pid}`,
        backgroundTask,
      }
    }

    const result = await execFileAsync('bash', ['-lc', command], {
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

function stripTrailingBackgroundOperator(command: string): string {
  return command.trim().replace(/&\s*$/, '').trim()
}
