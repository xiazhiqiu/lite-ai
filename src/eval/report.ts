/**
 * RE2-SS 评测报告生成器：输出明细 CSV + 汇总 JSON + 控制台表格摘要。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstanceResult, AggregateMetrics } from './scorer.js'

export type EvalReport = {
  meta: {
    generatedAt: string
    totalScenarios: number
    totalInstances: number
  }
  aggregate: AggregateMetrics
  instances: InstanceResult[]
}

function csvEscape(value: string | number | boolean): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 生成 CSV 明细。 */
export function toCsv(instances: InstanceResult[]): string {
  const header = [
    'scenario', 'instance', 'repeat', 'truth_service', 'truth_fault',
    'completed', 'total_steps', 'first_confirmed_step', 'ac1', 'ac3',
    'confirmed_count', 'refuted_count', 'evidence_count', 'evidence_rate',
    'false_positive', 'error',
  ]
  const rows = instances.map(r =>
    [
      r.scenario, r.instance, r.repeat, r.truthService, r.truthFault,
      r.completed, r.totalSteps, r.firstConfirmedStep, r.ac1, r.ac3,
      r.confirmedCount, r.refutedCount, r.evidenceCount, r.evidenceRate.toFixed(2),
      r.falsePositive, r.error ?? '',
    ].map(csvEscape).join(','),
  )
  return [header.join(','), ...rows].join('\n')
}

/** 生成 markdown 汇总表（控制台 + 报告共用）。 */
export function toMarkdown(report: EvalReport): string {
  const agg = report.aggregate
  const lines: string[] = []
  lines.push('# RE2-SS 评测报告')
  lines.push('')
  lines.push(`生成时间: ${report.meta.generatedAt}`)
  lines.push(`场景数: ${report.meta.totalScenarios} | 实例数: ${report.meta.totalInstances}`)
  lines.push('')
  lines.push('## 汇总指标')
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 完成数 | ${agg.completed}/${agg.total} |`)
  lines.push(`| AC@1 | ${(agg.ac1 * 100).toFixed(1)}% |`)
  lines.push(`| AC@3 | ${(agg.ac3 * 100).toFixed(1)}% |`)
  lines.push(`| 平均 Steps | ${agg.avgSteps.toFixed(1)} |`)
  lines.push(`| 平均 Evidence Rate | ${(agg.avgEvidenceRate * 100).toFixed(1)}% |`)
  lines.push(`| False Positive 总数 | ${agg.totalFalsePositive} |`)
  lines.push('')
  lines.push('## 分场景')
  lines.push('')
  lines.push('| 场景 | 实例数 | AC@1 | AC@3 |')
  lines.push('|---|---|---|---|')
  for (const [name, s] of Object.entries(agg.byScenario)) {
    lines.push(
      `| ${name} | ${(s as { count: number }).count} | ${((s as { ac1: number }).ac1 * 100).toFixed(1)}% | ${((s as { ac3: number }).ac3 * 100).toFixed(1)}% |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** 落盘报告（CSV + JSON + md）到 eval/results/<ts>/. */
export async function writeReport(
  report: EvalReport,
  outDir: string,
): Promise<{ csv: string; json: string; md: string }> {
  await mkdir(outDir, { recursive: true })
  const csv = path.join(outDir, 'results.csv')
  const json = path.join(outDir, 'results.json')
  const md = path.join(outDir, 'report.md')

  await writeFile(csv, toCsv(report.instances), 'utf8')
  await writeFile(json, JSON.stringify(report, null, 2), 'utf8')
  await writeFile(md, toMarkdown(report), 'utf8')

  return { csv, json, md }
}