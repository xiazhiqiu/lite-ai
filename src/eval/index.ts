#!/usr/bin/env tsx
/**
 * RE2-SS 评测框架入口。
 *
 * 用法：
 *   npm run eval:re2ss                          # 全量评测（所有实例）
 *   npm run eval:re2ss -- --filter=payment      # 只跑 payment 相关场景
 *   npm run eval:re2ss -- --filter=payment_mem --limit=1   # 只跑 1 个实例
 *   npm run eval:re2ss -- --repeat=2            # 每实例重复 2 次
 *   npm run eval:re2ss -- --skip-delay          # 跳过 delay 类型故障
 *   npm run eval:re2ss -- --help
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { runInstance } from './runner.js'
import {
  RE2SS_ROOT,
  discoverScenarios,
  filterScenarios,
} from './fixtures/re2ss.js'
import { aggregateResults, type InstanceResult } from './scorer.js'
import { writeReport, type EvalReport } from './report.js'

type CliArgs = {
  filter?: string
  limit?: number
  repeat: number
  skipDelay: boolean
  skipLoss?: boolean
  maxSteps?: number
  quiet: boolean
  outDir?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repeat: 3, skipDelay: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => argv[++i]
    switch (a) {
      case '--filter': args.filter = next(); break
      case '--limit': args.limit = Number(next() ?? 0); break
      case '--repeat': args.repeat = Number(next() ?? 3); break
      case '--max-steps': args.maxSteps = Number(next() ?? 60); break
      case '--out': args.outDir = next(); break
      case '--skip-delay': args.skipDelay = true; break
      case '--skip-loss': args.skipLoss = true; break
      case '--quiet': args.quiet = true; break
      case '--help':
      case '-h':
        console.log([
          'RE2-SS 评测框架',
          '',
          '选项:',
          '  --filter=<name>     过滤场景（服务或 service_fault 前缀匹配）',
          '  --limit=<N>         限制运行的最大实例数',
          '  --repeat=<R>        每实例重复次数（默认 3）',
          '  --max-steps=<N>     每实例最大代理步骤（默认 60）',
          '  --skip-delay        跳过 delay 故障类型',
          '  --skip-loss         跳过 loss 故障类型',
          '  --out=<dir>         报告输出目录',
          '  --quiet             静默模式',
        ].join('\n'))
        process.exit(0)
      default:
        if (a.startsWith('--') && a.includes('=')) {
          const [k, v] = a.split('=')
          if (k === '--filter') args.filter = v!
          else if (k === '--limit') args.limit = Number(v ?? 0)
          else if (k === '--repeat') args.repeat = Number(v ?? 3)
          else if (k === '--max-steps') args.maxSteps = Number(v ?? 60)
          else if (k === '--out') args.outDir = v
        }
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const scenarios = await discoverScenarios()
  const filtered = filterScenarios(scenarios, args.filter)
  const final = filtered.filter(
    s =>
      !(args.skipDelay && s.fault === 'delay') &&
      !(args.skipLoss && s.fault === 'loss'),
  )

  if (final.length === 0) {
    console.error(`No scenarios matched${args.filter ? ` filter "${args.filter}"` : ''}.`)
    process.exitCode = 1
    return
  }

  // 平铺所有 (场景, 实例) 对
  const pairs: { scenario: string; service: string; fault: string; instance: string }[] = []
  for (const s of final) {
    for (const inst of s.instances) {
      pairs.push({ scenario: s.name, service: s.service, fault: s.fault, instance: inst })
    }
  }
  const limited = args.limit && args.limit > 0 ? pairs.slice(0, args.limit) : pairs

  const totalRuns = limited.length * args.repeat
  if (!args.quiet) {
    console.log(`Scenarios: ${final.length} (${limited.length} instance) × ${args.repeat} repeat = ${totalRuns} runs`)
    console.log(`RE2-SS root: ${RE2SS_ROOT}`)
    console.log('')
  }

  const results: InstanceResult[] = []
  let done = 0
  for (const pair of limited) {
    for (let r = 0; r < args.repeat; r++) {
      if (!args.quiet) {
        console.log(`[${done + 1}/${totalRuns}] ${pair.scenario}/${pair.instance} (repeat ${r + 1}) ...`)
      }
      const cwd = path.join(RE2SS_ROOT, pair.scenario, pair.instance)
      const startMs = Date.now()
      const res = await runInstance(
        {
          service: pair.service,
          fault: pair.fault,
          scenario: pair.scenario,
          instance: pair.instance,
          repeat: r,
          cwd,
          maxSteps: args.maxSteps,
          quiet: args.quiet,
        },
        { quiet: args.quiet },
      )
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      if (!args.quiet) {
        console.log(
          `  done in ${elapsed}s | steps=${res.totalSteps} confirmed=${res.confirmedCount} ac1=${res.ac1} ac3=${res.ac3}${res.error ? ` ERROR: ${res.error}` : ''}`,
        )
      }
      results.push(res)
      done += 1
    }
  }

  const report: EvalReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      totalScenarios: final.length,
      totalInstances: limited.length,
    },
    aggregate: aggregateResults(results),
    instances: results,
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.resolve(process.cwd(), args.outDir ?? `eval/results/${ts}`)
  await mkdir(outDir, { recursive: true })
  const files = await writeReport(report, outDir)

  if (!args.quiet) {
    console.log('')
    console.log('==== 评测汇总 ====')
    const agg = report.aggregate
    console.log(`完成: ${agg.completed}/${agg.total}`)
    console.log(`AC@1: ${(agg.ac1 * 100).toFixed(1)}%`)
    console.log(`AC@3: ${(agg.ac3 * 100).toFixed(1)}%`)
    console.log(`平均 Steps: ${agg.avgSteps.toFixed(1)}`)
    console.log(`平均 Evidence Rate: ${(agg.avgEvidenceRate * 100).toFixed(1)}%`)
    console.log(`False Positive 总数: ${agg.totalFalsePositive}`)
    console.log('')
    console.log(`报告已写入:`)
    console.log(`  CSV: ${files.csv}`)
    console.log(`  JSON: ${files.json}`)
    console.log(`  MD: ${files.md}`)
  }
}

main().catch((error: unknown) => {
  console.error('Evaluation failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})