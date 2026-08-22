/**
 * ITBench 场景清单：schema 定义 + 读取。
 *
 * 方案 A（真实集群）：清单里的场景除了元数据与真值，还可携带 setup/teardown
 * 注入命令（kubectl 等），供 runner 在做 agent 诊断前注入故障、诊断后恢复。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export const ITBENCH_MANIFEST_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'dataset',
  'itbench',
  'manifest.jsonl',
)

/** 故障注入定义：setup 注入、teardown 恢复。 */
export type FaultInjection = {
  /** 注入故障前执行的命令（通常无，用于创建临时资源/记录基线）。 */
  pre?: string[]
  /** 注入故障的命令（需在 agent 诊断前生效）。 */
  setup: string[]
  /** 等待故障生效的秒数（默认 0）。runner 会在 setup 后 sleep。 */
  setupWaitSeconds?: number
  /** 恢复故障的命令（agent 诊断完成后执行）。 */
  teardown: string[]
  /** 等待指标回稳的秒数（默认 0）。 */
  teardownWaitSeconds?: number
  /** 可选：故障生效判定——轮询数据源查询成功即视为已生效。 */
  readinessQuery?: string
}

/** 真值实体的信息。 */
export type ItbenchGroundTruth = {
  /** 根因实体列表（precision@full-recall 的召回目标）。 */
  entities: string[]
  /** 故障描述（提示词给 agent 用）。 */
  fault?: string
  /** 可选：推荐修复动作。 */
  remediation?: string[]
}

export const groundTruthSchema = z.object({
  entities: z.array(z.string()).min(1, '至少需要一个根因实体'),
  fault: z.string().optional(),
  remediation: z.array(z.string()).optional(),
})

/** 单个场景的最小 schema（读取时校验）。 */
const scenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  namespace: z.string().optional().default('otel-demo'),
  /** 告警里常见的、agent 优先查的高信号指标名。 */
  keyMetrics: z.array(z.string()).optional(),
  groundTruth: groundTruthSchema,
  /** 故障注入（方案 A 用）。 */
  faultInjection: z.any().optional(),
})

export type ItbenchScenario = z.infer<typeof scenarioSchema>

/**
 * 读取场景清单，自动区分 JSONL（每行一个 JSON）与 JSON 数组两种格式。
 * 文件使用 zod schema 校验；按 id 去重（后者覆盖前者）。
 */
export async function loadManifest(
  manifestPath: string = ITBENCH_MANIFEST_PATH,
): Promise<ItbenchScenario[]> {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(
      `无法读取场景清单: ${manifestPath}\n` +
        '请先导出 ITBench-AA 场景到 dataset/itbench/manifest.jsonl ' +
        '（参见 dataset/itbench/ITBench-AA-guide.md）。',
    )
  }

  const parsed: unknown[] = raw.trim().startsWith('{')
    ? raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : JSON.parse(raw)

  if (!Array.isArray(parsed)) {
    throw new Error(`场景清单必须是 JSON 数组或 JSONL：${manifestPath}`)
  }

  const seen = new Set<string>()
  const scenarios: ItbenchScenario[] = []
  for (const item of parsed) {
    const result = scenarioSchema.safeParse(item)
    if (!result.success) {
      throw new Error(
        `场景清单第 ${parsed.indexOf(item)} 行校验失败: ${result.error.message}`,
      )
    }
    if (seen.has(result.data.id)) continue
    seen.add(result.data.id)
    scenarios.push(result.data)
  }
  return scenarios
}

/** 按 id 或 name 前缀过滤场景（用于 --filter）。 */
export function filterScenarios(
  scenarios: ItbenchScenario[],
  filter?: string,
): ItbenchScenario[] {
  if (!filter || filter.length === 0) return scenarios
  const f = filter.toLowerCase()
  return scenarios.filter(
    s => s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f),
  )
}