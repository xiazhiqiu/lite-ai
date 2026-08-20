import { z } from 'zod'
import { loadDataSources } from '../../config.js'
import type { ToolDefinition } from '../../tool.js'
import {
  KUBECTL_DEFAULT_NAMESPACE,
  KUBECTL_DEFAULT_TAIL,
  KUBECTL_MAX_TAIL,
  __hooks,
  matchByDataSource,
  resolveDataSource,
  type DataSourceToolset,
} from './types.js'

const KUBECTL_SUBCOMMANDS = [
  'get',
  'describe',
  'logs',
  'top',
  'version',
  'explain',
] as const

const KubectlQueryInputSchema = z.object({
  /** 数据源 name；缺省取该类型第一个命中实例（多实例消歧）。 */
  source: z.string().optional(),
  /** 仅白名单只读子命令，其余拒绝。 */
  subcommand: z.enum(KUBECTL_SUBCOMMANDS),
  /** 资源类型，如 pods / deployments / services。 */
  resource: z.string().optional(),
  /** 资源名；logs 必填（pod 名）。 */
  name: z.string().optional(),
  /** namespace，缺省 "sock-shop"。 */
  namespace: z.string().optional(),
  /** -o 输出格式，如 wide / json / yaml。 */
  output: z.string().optional(),
  /** logs 的 --tail 行数（默认 50，上限 500）。 */
  tail: z.number().int().min(1).optional(),
})

type KubectlQueryInput = z.infer<typeof KubectlQueryInputSchema>

function buildKubectlArgs(input: KubectlQueryInput): string[] {
  const namespace = input.namespace ?? KUBECTL_DEFAULT_NAMESPACE
  const args: string[] = []

  switch (input.subcommand) {
    case 'get':
    case 'describe':
    case 'top':
      args.push(input.subcommand)
      if (input.resource) args.push(input.resource)
      if (input.name) args.push(input.name)
      args.push('-n', namespace)
      if (input.output) args.push('-o', input.output)
      break
    case 'logs': {
      const tail = Math.min(input.tail ?? KUBECTL_DEFAULT_TAIL, KUBECTL_MAX_TAIL)
      args.push('logs', input.name ?? '', '-n', namespace, '--tail', String(tail))
      break
    }
    case 'version':
      args.push('version')
      break
    case 'explain':
      args.push('explain', input.resource ?? '')
      break
  }

  return args.filter(arg => arg !== '')
}

export const kubectlQueryTool: ToolDefinition<KubectlQueryInput> = {
  name: 'kubectl_query',
  description:
    'Query Kubernetes (read-only) via kubectl CLI. Only whitelisted read-only subcommands are allowed: get/describe/logs/top/version/explain. Args are passed as an array (no shell, no injection). Use "source" to pick a specific data source when multiple are configured.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Data source name (from settings dataSources). Defaults to the first matching source.',
      },
      subcommand: {
        type: 'string',
        enum: KUBECTL_SUBCOMMANDS,
        description: 'Read-only subcommand: get/describe/logs/top/version/explain.',
      },
      resource: { type: 'string', description: 'Resource type, e.g. pods/deployments/services.' },
      name: { type: 'string', description: 'Resource or pod name (required for logs).' },
      namespace: { type: 'string', description: 'Namespace (default sock-shop).' },
      output: { type: 'string', description: 'Output format for get/describe/top: wide/json/yaml.' },
      tail: { type: 'number', description: 'Log line tail for logs (default 50, max 500).' },
    },
    required: ['subcommand'],
  },
  schema: KubectlQueryInputSchema,
  isReadOnly: true,
  isParallelSafe: () => true,

  async run(input) {
    try {
      const sources = await loadDataSources()
      const source = resolveDataSource(sources, 'kubernetes', input.source)
      if (!source) {
        return {
          ok: false,
          output:
            'No Kubernetes data source configured. Add a dataSource with type "kubernetes" (or name/hint containing "kubectl"/"k8s") in settings.json, then retry.',
        }
      }

      if (input.subcommand === 'logs' && !input.name) {
        return {
          ok: false,
          output: 'kubectl_query logs requires a pod name (name).',
        }
      }

      const args = buildKubectlArgs(input)
      try {
        const { stdout, stderr } = await __hooks.kubectlExec(args)
        const output = [stdout, stderr].filter(Boolean).join('\n').trim()
        return { ok: true, output: output || '(empty output)' }
      } catch (error) {
        const e = error as NodeJS.ErrnoException & { stderr?: string }
        if (e.code === 'ENOENT') {
          return {
            ok: false,
            output: 'kubectl not found on PATH. Install kubectl to use kubectl_query.',
          }
        }
        const stderr = (e.stderr ?? '').trim()
        return {
          ok: false,
          output: `kubectl ${input.subcommand} failed${stderr ? `: ${stderr}` : ` (exit code ${e.code ?? 'unknown'})`}`,
        }
      }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}

export const kubernetesToolset: DataSourceToolset = {
  type: 'kubernetes',
  match: sources => sources.filter(s => matchByDataSource(s, 'kubernetes')),
  tools: [kubectlQueryTool],
}
