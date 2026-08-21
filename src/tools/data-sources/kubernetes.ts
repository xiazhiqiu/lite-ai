import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { clampToolOutput, type ToolsetStatus } from './base.js'
import type { ResolvedToolsetConfig } from '../../config.js'

/**
 * Kubernetes 只读查询工具集。
 * 路由对齐 HolmesGPT 的 kubernetes（默认启用、继承 kubeconfig、仅读）。
 * 通过 kubectl 原生读取；isReadOnly:true 使工具自动进入子 agent 白名单。
 */

const execFileAsync = promisify(execFile)
const KUBECTL_MAX_BUFFER = 10 * 1024 * 1024

export function checkKubernetesConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  // kubectl 无需连接参数：继承当前用户 kubeconfig。
  return { name: toolset.name, type: 'kubernetes', enabled: true }
}

/** 可测试性钩子：测试可替换为 mock；生产走 kubectl 二进制。 */
export const __hooks = {
  kubectlExec: (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('kubectl', args, { maxBuffer: KUBECTL_MAX_BUFFER }),
}

async function runKubectl(args: string[]): Promise<string> {
  const { stdout, stderr } = await __hooks.kubectlExec(args)
  const err = stderr.trim()
  if (err) throw new Error(`kubectl: ${err}`)
  return stdout
}

const resourceType = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z]+$/i, '非法资源类型')

interface KubectlArgs {
  kind?: string
  namespace?: string
  name?: string
  labelSelector?: string
  fieldSelector?: string
}

/** 构建 kubectl get 参数；outputFormat 控制 -o 输出。 */
function buildArgs(
  input: KubectlArgs,
  outputFormat: 'json' | 'wide' = 'json',
): string[] {
  const args = ['get', input.kind ?? 'pods']
  if (input.namespace !== undefined && input.namespace !== '') {
    args.push('-n', input.namespace)
  }
  if (input.name !== undefined && input.name !== '') {
    args.push(input.name)
  }
  if (input.labelSelector !== undefined && input.labelSelector !== '') {
    args.push('--selector', input.labelSelector)
  }
  if (input.fieldSelector !== undefined && input.fieldSelector !== '') {
    args.push('--field-selector', input.fieldSelector)
  }
  args.push('-o', outputFormat === 'json' ? 'json' : 'wide')
  return args
}

function tool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (input: T) => Promise<{ ok: boolean; output: string }>,
): ToolDefinition<T> {
  return {
    name: `kubernetes_${name}`,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(input)
    },
  }
}

export function buildKubernetesTools(
  _toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  return [
    tool(
      'jq_query',
      'Query Kubernetes resources as raw JSON with an optional field selector.',
      z.object({
        resource_type: resourceType,
        namespace: z.string().optional(),
        name: z.string().optional(),
        label_selector: z.string().optional(),
        field_selector: z.string().optional(),
      }),
      async (input) => {
        const args = buildArgs(
          {
            kind: input.resource_type,
            namespace: input.namespace,
            name: input.name,
            labelSelector: input.label_selector,
            fieldSelector: input.field_selector,
          },
          'json',
        )
        const output = await runKubectl(args)
        return {
          ok: true,
          output: clampToolOutput(output, 30_000),
        }
      },
    ),
    tool(
      'tabular_query',
      'List Kubernetes resources in a concise tabular view.',
      z.object({
        resource_type: resourceType,
        namespace: z.string().optional(),
        name: z.string().optional(),
        label_selector: z.string().optional(),
      }),
      async (input) => {
        const args = buildArgs(
          {
            kind: input.resource_type,
            namespace: input.namespace,
            name: input.name,
            labelSelector: input.label_selector,
          },
          'wide',
        )
        const output = await runKubectl(args)
        return {
          ok: true,
          output: clampToolOutput(output, 30_000),
        }
      },
    ),
    tool(
      'count',
      'Count Kubernetes resources matching an optional selector.',
      z.object({
        resource_type: resourceType,
        namespace: z.string().optional(),
        label_selector: z.string().optional(),
      }),
      async (input) => {
        const args = buildArgs(
          {
            kind: input.resource_type,
            namespace: input.namespace,
            labelSelector: input.label_selector,
          },
        )
        const output = await runKubectl(args)
        try {
          const parsed = JSON.parse(output) as { items?: unknown[] }
          const count = (parsed.items ?? []).length
          return { ok: true, output: `count=${count}` }
        } catch {
          return { ok: false, output: `无法解析 kubectl 输出: ${output.slice(0, 200)}` }
        }
      },
    ),
  ]
}