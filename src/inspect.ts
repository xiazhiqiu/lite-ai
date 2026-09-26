/**
 * 定时巡检（单人本地 RCA，无 server / 无 webhook / 无多用户交接）
 *
 * 设计哲学：纯本地 CLI。复用现有 agent-loop + 工具集（含 hypothesis_tracker
 * 假设验证机制、incident_checkpoint 检查点），对当前工作目录跑一次例行 RCA
 * 健康检查，结论落本地报告（LITE_AI_DIR/inspections/）。
 *
 * 子命令：
 *   lite-ai inspect [--target "<巡检目标>"]      立即跑一次巡检
 *   lite-ai schedule --every <分钟> [--target]   进程内周期巡检 + 打印系统调度指引
 *
 * schedule 走进程内 setInterval；同时打印 cron / schtasks 示例，引导用户用系统
 * 调度器实现“无需常驻进程”的真正定时巡检。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadRuntimeConfig, LITE_AI_DIR } from './config.js'
import {
  createDefaultToolRegistry,
  hydrateMcpTools,
} from './tools/index.js'
import { PermissionManager } from './permissions.js'
import { buildSystemPrompt } from './prompt.js'
import { runAgentTurn } from './agent-loop.js'
import { MockModelAdapter } from './mock-model.js'
import { OpenAIModelAdapter } from './openai-adapter.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import type { ChatMessage, ModelAdapter } from './types.js'
import type { ToolRegistry } from './tool.js'
import { createContentReplacementState } from './utils/tool-result-storage.js'
import { createContextCollapseState } from './compact/context-collapse.js'

export type InspectionOptions = {
  cwd: string
  target?: string
  maxSteps?: number
}

const DEFAULT_TARGET =
  '执行一次针对当前环境的例行 RCA 健康检查：' +
  '(1) 检查关键服务/进程状态；' +
  '(2) 扫描近期错误日志与异常信号；' +
  '(3) 检查资源水位（CPU/内存/磁盘/连接数）；' +
  '(4) 使用 hypothesis_tracker 记录候选根因假设，并逐个给出证据与验证结论。' +
  '最终输出：当前是否存在活跃事故、最可能的根因假设（附证据）、建议的处置或持续观察项。' +
  '证据不足时明确说明“未定位”，不编造根因。'

function buildModel(
  tools: Parameters<typeof createDefaultToolRegistry> extends never ? never : import('./tool.js').ToolRegistry,
  runtime: Awaited<ReturnType<typeof loadRuntimeConfig>> | null,
): ModelAdapter {
  if (process.env.LITE_AI_MODEL_MODE === 'mock') return new MockModelAdapter()
  if (runtime?.provider === 'openai') {
    return new OpenAIModelAdapter(tools as never, loadRuntimeConfig as never)
  }
  return new AnthropicModelAdapter(tools as never, loadRuntimeConfig as never)
}

function lastAssistantMessage(messages: ChatMessage[]): string {
  const message = [...messages]
    .reverse()
    .find(candidate => candidate.role === 'assistant')
  return message?.role === 'assistant'
    ? message.content
    : '(无结论输出)'
}

async function writeInspectionReport(
  cwd: string,
  target: string,
  conclusion: string,
): Promise<string> {
  const dir = path.join(LITE_AI_DIR, 'inspections')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `inspection-${stamp}.md`)
  const body = [
    '# RCA 巡检报告',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 目标目录：${cwd}`,
    `- 巡检目标：${target}`,
    '',
    '## 结论',
    '',
    conclusion,
    '',
  ].join('\n')
  await writeFile(file, body, 'utf8')
  return file
}

/**
 * 跑一次巡检：构建工具集 + 模型，调用现有 agent-loop 完成 RCA，结论落本地报告。
 * 返回报告文件路径。
 */
export async function runInspection(opts: InspectionOptions): Promise<string> {
  const { cwd, target = DEFAULT_TARGET, maxSteps = 24 } = opts

  const runtime = await loadRuntimeConfig().catch(() => null)
  const tools = await createDefaultToolRegistry({ cwd, runtime })
  await hydrateMcpTools({ cwd, runtime, tools }).catch(() => {
    // MCP 失败不阻断巡检
  })
  const permissions = new PermissionManager(cwd)
  await permissions.whenReady()
  const model = buildModel(tools, runtime)
  const contentReplacementState = createContentReplacementState()
  const contextCollapseState = createContextCollapseState()

  const systemPrompt = await buildSystemPrompt(cwd, permissions.getSummary(), {
    skills: tools.getSkills(),
    mcpServers: tools.getMcpServers(),
  })
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: target },
  ]

  const result = await runAgentTurn({
    model,
    tools,
    messages,
    cwd,
    permissions,
    maxSteps,
    modelName: runtime?.model ?? '',
    contentReplacementState,
    contextCollapseState,
  })

  const conclusion = lastAssistantMessage(result)
  const reportPath = await writeInspectionReport(cwd, target, conclusion)
  await tools.dispose()
  return reportPath
}

function parseTarget(argv: string[]): string | undefined {
  const i = argv.indexOf('--target')
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) {
    return argv[i + 1]
  }
  const eq = argv.find(a => a.startsWith('--target='))
  if (eq) return eq.slice('--target='.length)
  return undefined
}

function parseEveryMinutes(argv: string[]): number {
  const i = argv.indexOf('--every')
  if (i !== -1 && argv[i + 1]) {
    const n = Number(argv[i + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return 60
}

function printScheduleGuide(
  target: string | undefined,
  everyMinutes: number,
): void {
  const targetArg = target ? ` --target "${target}"` : ''
  console.log(
    [
      '提示：可用系统调度器替代常驻进程（无需 server）：',
      `  Linux/macOS (cron):  */${everyMinutes} * * * * lite-ai inspect${targetArg}`,
      `  Windows (schtasks):  schtasks /create /tn "lite-ai-inspect" /tr "lite-ai inspect${targetArg}" /sc minute /mo ${everyMinutes}`,
      '',
    ].join('\n'),
  )
}

/**
 * 进程内周期巡检：先立即跑一次，再按 --every 分钟间隔循环。
 * 打印系统调度指引，引导用户用 cron/schtasks 实现真正的无人值守定时巡检。
 */
export async function runSchedule(opts: {
  cwd: string
  target?: string
  everyMinutes: number
}): Promise<void> {
  const { cwd, target, everyMinutes } = opts
  printScheduleGuide(target, everyMinutes)

  const tick = async (): Promise<void> => {
    const reportPath = await runInspection({ cwd, target }).catch(error => {
      console.error(
        '巡检失败：',
        error instanceof Error ? error.message : String(error),
      )
      return null
    })
    if (reportPath) {
      console.log(`[${new Date().toISOString()}] 巡检完成 → ${reportPath}`)
    }
  }

  await tick()
  console.log(
    `\n已进入周期巡检模式，每 ${everyMinutes} 分钟执行一次。按 Ctrl+C 退出。`,
  )
  setInterval(tick, everyMinutes * 60 * 1000)
}

/** CLI 子命令分发入口（由 index.ts 调用）。 */
export async function runInspectionCommand(
  subcommand: string,
  cwd: string,
  argv: string[],
): Promise<void> {
  if (subcommand === 'schedule') {
    await runSchedule({
      cwd,
      target: parseTarget(argv),
      everyMinutes: parseEveryMinutes(argv),
    })
    return
  }

  // 默认：inspect 单次巡检
  try {
    const reportPath = await runInspection({
      cwd,
      target: parseTarget(argv),
    })
    console.log(`✅ 巡检完成，报告已写入：${reportPath}`)
  } catch (error) {
    console.error(
      '巡检执行失败：',
      error instanceof Error ? error.message : String(error),
    )
    process.exitCode = 1
  }
}
