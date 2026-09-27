import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import {
  classifySecretAccess,
  isSreReadOnlyCommand,
  splitCommandLine,
} from './command-guard.js'

const execFileAsync = promisify(execFile)
const KUBECTL_MAX_BUFFER = 10 * 1024 * 1024

type Input = {
  /** kubectl 子命令字符串，不含 kubectl 前缀，如 "get pods -n prod"。 */
  command: string
}

/** 可测试性钩子：测试可替换为 mock；生产走 kubectl 二进制。 */
export const __hooks = {
  kubectlExec: (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('kubectl', args, { maxBuffer: KUBECTL_MAX_BUFFER }),
}

/**
 * 对齐 HolmesGPT 的 k8s 命令形态：kubectl 独立于 bash，作为专用工具暴露。
 * 只读子命令（get/describe/logs/top/explain/diff/version）免审批直行；
 * 写子命令（delete/scale/apply 等）转权限底座审批——对齐 HG「结构化写
 * 旁路 + 审批」的做法。secret 暴露（kubectl get secrets）硬拦无审批出口。
 * 全程 execFile 直跑 kubectl 二进制，不经 shell，无 shell 注入面。
 */
export const kubectlTool: ToolDefinition<Input> = {
  name: 'kubectl',
  description:
    'Run a kubectl subcommand, e.g. "get pods -n prod" or "logs deploy/api --tail=100". ' +
    'Read-only subcommands (get/describe/logs/top/explain/diff/version) run without approval; ' +
    'mutating subcommands require user approval. Do not include the leading "kubectl" keyword.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
  },
  schema: z.object({
    command: z.string(),
  }),
  async run(input, context) {
    const args = splitCommandLine(input.command.trim())
    if (args.length === 0) {
      return {
        ok: false,
        output: 'Command not allowed: empty command',
      }
    }

    // secret 暴露硬拦：deny 无审批出口（与 bash 管线同一判定单源）。
    const secret = classifySecretAccess('kubectl', args)
    if (secret) {
      return {
        ok: false,
        output: `Command denied by command guard: ${secret}`,
      }
    }

    const readOnly = isSreReadOnlyCommand('kubectl', args)

    // 写子命令需要审批通道；无 permissions（无人值守巡检）时 fail-closed 拒绝。
    if (!readOnly && !context.permissions) {
      return {
        ok: false,
        output: `Command not allowed without permission manager (read-only mode): kubectl ${args.join(' ')}`,
      }
    }

    if (!readOnly) {
      await context.permissions?.ensureCommand('kubectl', args, context.cwd, {
        forcePromptReason: `'kubectl ${args[0] ?? ''}' is not in the read-only subcommand set`,
      })
    }

    const { stdout, stderr } = await __hooks.kubectlExec(args)
    const err = stderr.trim()

    return {
      ok: true,
      output: err ? `${stdout}\n${err}`.trim() : stdout,
    }
  },
}
