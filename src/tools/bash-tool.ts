import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'
import {
  classifySecretAccess,
  evaluateBashCommand,
  isReadOnlyCommandCall,
  splitCommandLine,
} from './command-guard.js'

const execFileAsync = promisify(execFile)

type Input = {
  command: string
  suggested_prefixes: string[]
  cwd?: string
}

/**
 * 对齐 HolmesGPT bash toolset 的纯 shell 形态：整条命令字符串一律经
 * bash -lc 执行，不再提供 argv 数组形态，也没有 argv/shell 自动分流。
 * 安全判定走 command-guard 五级管线（拆段 → secret 硬拦 → 参数原语 →
 * 段级白名单 → 三态汇总），无 permissions 上下文时强制只读白名单
 * （fail-closed，供无人值守巡检使用）。
 *
 * suggested_prefixes（必填，对齐 HG bash_toolset.py:123）：模型为每个命令段
 * 声明一个前缀，用于 (1) 一致性校验——声明的前缀必须出现在命令里，否则
 * deny（HG validation.py:571）；(2) 审批框 p 档候选——用户"记住前缀"时
 * 只持久化模型声明过、人批过的前缀（HG tool_calling_llm.py:461-503）。
 */
export const bashTool: ToolDefinition<Input> = {
  name: 'bash',
  description:
    'Execute a bash command and return its output. Supports single commands, pipes (|), &&, || and ;. ' +
    'Loops, conditionals and subshells require user approval. Read-only commands run without approval. ' +
    'Provide suggested_prefixes: exactly one prefix per command segment ' +
    '(segments are separated by |, &&, ||, ;), e.g. command "kubectl get pods | grep app" ' +
    '-> suggested_prefixes ["kubectl get", "grep"]. Prefixes must appear in the command; ' +
    'inconsistent suggestions are denied.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      suggested_prefixes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'One prefix per command segment, e.g. ["kubectl get", "grep"].',
      },
      cwd: { type: 'string' },
    },
    required: ['command', 'suggested_prefixes'],
  },
  schema: z.object({
    command: z.string(),
    suggested_prefixes: z.array(z.string()),
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

    // bash 专用判定入口（AST 优先，回退手写拆段）：前缀一致性校验
    // （deny 优先）→ 五级管线。
    // deny：无审批出口直接拒（secret 暴露 / sudo 提权 / 前缀与命令不符）；
    // approval：转权限底座（三层名单 → 无回调硬拒 → 审批框）；
    // allow：全段过白名单，免审批执行。
    const guard = await evaluateBashCommand(command, input.suggested_prefixes)

    if (guard.verdict === 'deny') {
      return {
        ok: false,
        output: `Command denied by command guard: ${guard.reason ?? 'policy violation'}`,
      }
    }

    if (guard.verdict === 'approval') {
      await context.permissions?.ensureCommand('bash', ['-lc', command], effectiveCwd, {
        forcePromptReason: guard.reason,
        prefixCandidates: input.suggested_prefixes,
        prefixSignature: command,
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
