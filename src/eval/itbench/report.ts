/**
 * ITBench 评测报告生成：CSV 明细 + JSON 结构化 + Markdown 汇总。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  aggregateResults,
  type ItbenchAggregated,
  type ItbenchInstanceResult,
} from './scorer.js'

export type ItbenchEvalReport = {
  generatedAt: string
  aggregate: ItbenchAggregated
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** 逐实例 CSV 明细。 */
export function toCsv(instances: ItbenchInstanceResult[]): string {
  const header = [
    'scenario',
    'repeat',
    'steps',
    'completed',
    'full_recall',
    'precision',
    'score',
    'submitted',
    'ground_truth',
    'error',
  ]
  const rows = instances.map(i => [
    i.scenario,
    String(i.repeat),
    String(i.steps),
    String(i.completed),
    String(i.fullRecall),
    i.precision.toFixed(3),
    i.score.toFixed(3),
    i.submitted.join('|'),
    i.groundTruth.join('|'),
    i.error ?? '',
  ])
  return [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n')
}

/** Markdown 汇总（总分 + 分场景）。 */
export function toMarkdown(aggregate: ItbenchAggregated): string {
  const lines = [
    '# ITBench 评测结果',
    '',
    `- 完成实例: ${aggregate.completed} / ${aggregate.instances.length}`,
    `- Full-recall 率: ${(aggregate.fullRecallRate * 100).toFixed(1)}%`,
    `- 平均 precision: ${aggregate.avgPrecision.toFixed(3)}`,
    `- 平均 score (precision@full-recall): ${aggregate.avgScore.toFixed(3)}`,
    '',
    '| scenario | 实例数 | full-recall 率 | avg precision | avg score |',
    '|---|---|---|---|---|',
  ]
  for (const [scenario, agg] of Object.entries(aggregate.byScenario)) {
    lines.push(
      `| ${scenario} | ${agg.completed} | ${(agg.fullRecallRate * 100).toFixed(1)}% | ${agg.avgPrecision.toFixed(3)} | ${agg.avgScore.toFixed(3)} |`,
    )
  }
  return lines.join('\n') + '\n'
}

/** 一次性写出 CSV/JSON/MD 到目录，返回各文件路径。 */
export async function writeReport(
  outDir: string,
  instances: ItbenchInstanceResult[],
): Promise<string[]> {
  await mkdir(outDir, { recursive: true })

  const aggregate = aggregateResults(instances)
  const report: ItbenchEvalReport = {
    generatedAt: new Date().toISOString(),
    aggregate,
  }

  const csvPath = path.join(outDir, 'report.csv')
  const jsonPath = path.join(outDir, 'report.json')
  const mdPath = path.join(outDir, 'report.md')

  await Promise.all([
    writeFile(csvPath, toCsv(instances), 'utf8'),
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(mdPath, toMarkdown(aggregate), 'utf8'),
  ])
  return [csvPath, jsonPath, mdPath]
}