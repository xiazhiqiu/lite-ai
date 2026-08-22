#!/usr/bin/env tsx
/**
 * ITBench 评测框架入口（方案 A：真实 Kind 集群 + 故障注入）。
 *
 * 用法：
 *   npm run eval:itbench                            # 全量评测 manifest 中的场景
 *   npm run eval:itbench -- --filter=payment        # 只跑 payment 相关场景
 *   npm run eval:itbench -- --limit=3               # 只跑前 3 个场景
 *   npm run eval:itbench -- --repeat=2              # 每场景重复 2 次
 *   npm run eval:itbench -- --max-steps=40          # 每场景最大 agent 步骤
 *   npm run eval:itbench -- --live                  # 执行 setup/teardown 故障注入
 *   npm run eval:itbench -- --manifest=<path>
 *   npm run eval:itbench -- --help
 */

import path from 'node:path'
import { runScenario, listDataSources } from './runner.js'
import {
  loadManifest,
  filterScenarios,
  ITBENCH_MANIFEST_PATH,
  type ItbenchScenario,
} from './manifest.js'
import { aggregateResults, type ItbenchInstanceResult } from './scorer.js'
import { writeReport } from './report.js'

type CliArgs = {
  manifest?: string
  filter?: string
  limit?: number
  repeat: number
  maxSteps?: number
  live: boolean
  quiet: boolean
  outDir?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repeat: 1, live: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => argv[++i]
    switch (a) {
      case '--manifest': args.manifest = next(); break
      case '--filter': args.filter = next(); break
      case '--limit': args.limit = Number(next() ?? 0); break
      case '--repeat': args.repeat = Number(next() ?? 1); break
      case '--max-steps': args.maxSteps = Number(next() ?? 60); break
      case '--out': args.outDir = next(); break
      case '--live': args.live = true; break
      case '--quiet': args.quiet = true; break
      case '--help':
      case '-h':
        console.log([
          'ITBench 评测框架（方案 A：真实集群 + 故障注入）',
          '',
          '选项:',
          '  --manifest=<path>   场景清单文件（默认 dataset/itbench/manifest.jsonl）',
          '  --filter=<name>     过滤场景（id 或 name 前缀匹配）',
          '  --limit=<N>         限制运行的最大场景数',
          '  --repeat=<R>        每场景重复次数（默认 1）',
          '  --max-steps=<N>     每场景最大代理步骤（默认 60）',
          '  --live              执行每个场景的 setup/teardown 故障注入',
          '  --out=<dir>         报告输出目录',
          '  --quiet             静默模式',
        ].join('\n'))
        process.exit(0)
        break
      default:
        if (a.startsWith('--') && a.includes('=')) {
          const [k, v] = a.split('=')
          if (k === '--manifest') args.manifest = v!
          else if (k === '--filter') args.filter = v!
          else if (k === '--limit') args.limit = Number(v ?? 0)
          else if (k === '--repeat') args.repeat = Number(v ?? 1)
          else if (k === '--max-steps') args.maxSteps = Number(v ?? 60)
          else if (k === '--out') args.outDir = v
          else if (k === '--live') args.live = true
        }
        break
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const scenarios: ItbenchScenario[] = await loadManifest(args.manifest)
  const filtered = filterScenarios(scenarios, args.filter)
  const limited = args.limit && args.limit > 0
    ? filtered.slice(0, args.limit)
    : filtered

  if (limited.length === 0) {
    console.error(
      `No scenarios matched${args.filter ? ` filter "${args.filter}"` : ''}.`,
    )
    process.exitCode = 1
    return
  }

  const dataSources = await listDataSources()
  // 故障注入命令以操作者完整权限执行：内置清单默认信任，自定义/外部清单需显式
  // 用 LITE_AI_EVAL_FAULT_INJECTION=1 授权，防止误对非测试集群执行任意 shell 命令。
  const isBundledManifest =
    args.manifest === undefined ||
    path.resolve(args.manifest) === ITBENCH_MANIFEST_PATH
  const trustFaultInjection =
    args.live && (isBundledManifest || process.env.LITE_AI_EVAL_FAULT_INJECTION === '1')
  if (!args.quiet) {
    console.log(`Manifest: ${args.manifest ?? '(default dataset/itbench/manifest.jsonl)'}`)
    console.log(`Scenarios: ${limited.length} × ${args.repeat} repeat = ${limited.length * args.repeat} runs`)
    console.log(`Fault injection: ${args.live ? (trustFaultInjection ? 'ENABLED (trusted)' : 'BLOCKED (untrusted, set LITE_AI_EVAL_FAULT_INJECTION=1)') : 'SKIPPED (use --live)'}`)
    console.log('Enabled data sources (from ~/.lite-ai/settings.json toolsets):')
    for (const s of dataSources) console.log(`  - ${s}`)
    console.log('')
  }

  const results: ItbenchInstanceResult[] = []
  for (const scenario of limited) {
    for (let r = 1; r <= args.repeat; r++) {
      const start = Date.now()
      if (!args.quiet) {
        console.log(`[${scenario.id}] repeat=${r} running...`)
      }
      const result = await runScenario(scenario, r, {
        maxSteps: args.maxSteps,
        skipFaultInjection: !args.live,
        trustFaultInjection,
        quiet: args.quiet,
      })
      results.push(result)
      if (!args.quiet) {
        const secs = ((Date.now() - start) / 1000).toFixed(1)
        console.log(
          `[${scenario.id}] repeat=${r} done in ${secs}s | ` +
            `score=${result.score.toFixed(3)} recall=${result.fullRecall} ` +
            `submitted=[${result.submitted.join(', ')}] error=${result.error ?? 'none'}`,
        )
      }
    }
  }

  const aggregate = aggregateResults(results)
  const outDir = args.outDir ?? 'eval/results'
  const files = await writeReport(outDir, results)

  console.log('')
  console.log('=== 汇总 ===')
  console.log(`完成实例: ${aggregate.completed}/${aggregate.instances.length}`)
  console.log(`Full-recall 率: ${(aggregate.fullRecallRate * 100).toFixed(1)}%`)
  console.log(`平均 precision: ${aggregate.avgPrecision.toFixed(3)}`)
  console.log(`平均 score (precision@full-recall): ${aggregate.avgScore.toFixed(3)}`)
  console.log('')
  console.log('报告已写入:')
  for (const f of files) console.log(`  - ${path.resolve(f)}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})