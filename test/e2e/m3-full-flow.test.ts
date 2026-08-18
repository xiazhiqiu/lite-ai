/**
 * M3 端到端场景验证：诊断 → 处置 → 复盘全链路。
 *
 * 区别于 re2-ss-agent-e2e.test.ts（只验证到交接简报 step 7），
 * 本测试验证 PRD 7.1 全流程：
 *   1-3. agent 经 mock 数据源（Prometheus/ES/kubectl）诊断
 *   4.   hypothesis_tracker 注册假设 + 证据 + 状态
 *   5-7. incident_checkpoint 创建 + 切换 + 交接简报
 *   8.   generate_postmortem 生成复盘报告并落盘
 *   9.   验证落盘文件存在且含假设链/时间线/根因
 *
 * 场景：payment_mem/1（payment 内存压力，最贴近 PRD 7.1 的 OOM 语义）
 * 跳过 orders_delay（用户要求；agent 探索路径过多易超时）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockSources, cleanupKubeconfigDir } from './mock/harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const datasetRoot = path.resolve(__dirname, '..', '..', 'dataset', 'RE2-SS')

const SCENARIO = {
  dir: path.join('RE2-SS', 'payment_mem', '1'),
  name: 'payment_mem',
  incidentTitle: 'payment 容器内存压力导致支付请求 OOM',
  severity: 'SEV1',
  expectedService: 'payment',
  keyMetrics: [
    'payment_container-memory-failures-total',
    'payment_container-memory-working-set-bytes',
    'payment_istio-latency-99',
  ],
} as const

let tempRoot: string
let originalLiteAiHome: string | undefined

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-m3-'))
  originalLiteAiHome = process.env.LITE_AI_HOME
  process.env.LITE_AI_HOME = tempRoot

  const realSettings = path.join(os.homedir(), '.lite-ai', 'settings.json')
  try {
    const content = await readFile(realSettings, 'utf8')
    await mkdir(tempRoot, { recursive: true })
    await writeFile(path.join(tempRoot, 'settings.json'), content, 'utf8')
  } catch {
    // settings.json 不存在时靠 env vars 兜底
  }
})

after(async () => {
  if (originalLiteAiHome === undefined) {
    delete process.env.LITE_AI_HOME
  } else {
    process.env.LITE_AI_HOME = originalLiteAiHome
  }
  await cleanupKubeconfigDir()
  await rm(tempRoot, { recursive: true, force: true })
})

test(
  'M3 e2e: payment_mem/1 — 诊断→处置→复盘全链路（含 postmortem 落盘）',
  { timeout: 420_000 },
  async () => {
    const cwd = path.join(datasetRoot, SCENARIO.dir)
    const sources = await startMockSources(cwd)

    try {
      const { OpenAIModelAdapter } = await import('../../src/openai-adapter.js')
      const { createDefaultToolRegistry, hydrateMcpTools } = await import(
        '../../src/tools/index.js'
      )
      const { loadRuntimeConfig } = await import('../../src/config.js')
      const { buildSystemPrompt } = await import('../../src/prompt.js')
      const { PermissionManager } = await import('../../src/permissions.js')
      const { runAgentTurn } = await import('../../src/agent-loop.js')
      const { createContentReplacementState } = await import(
        '../../src/utils/tool-result-storage.js'
      )
      const { createContextCollapseState } = await import(
        '../../src/compact/context-collapse.js'
      )
      const { postmortemFilePath } = await import(
        '../../src/tools/generate-postmortem.js'
      )

      const runtime = await loadRuntimeConfig()
      const fullTools = await createDefaultToolRegistry({ cwd, runtime })
      await hydrateMcpTools({ cwd, runtime, fullTools }).catch(() => {})

      // 过滤掉 read_file，强制 agent 只能通过 mock 数据源查询
      const allowedNames = fullTools
        .list()
        .map(t => t.name)
        .filter(n => n !== 'read_file')
      const tools = fullTools.subset(allowedNames)

      const permissions = new PermissionManager(cwd, async () => ({
        decision: 'allow_once' as const,
      }))
      await permissions.whenReady()

      const model = new OpenAIModelAdapter(tools, () => loadRuntimeConfig())

      const systemPrompt = await buildSystemPrompt(
        cwd,
        permissions.getSummary(),
        {
          skills: tools.getSkills(),
          mcpServers: tools.getMcpServers(),
          subAgents: { maxConcurrent: 2 },
        },
      )

      const start = Math.max(0, sources.injectTime - 300)
      const end = sources.injectTime + 300

      const userMessage = [
        `I'm investigating an incident in the Sock Shop microservice demo (namespace: sock-shop).`,
        `An alert fired at unix epoch second ${sources.injectTime}; use it as the fault-time reference (window ${start}..${end}).`,
        '',
        'Live data sources (read-only):',
        `- Prometheus metrics: ${sources.prometheusUrl}  (query via curl, GET)`,
        `- Elasticsearch logs: ${sources.elasticsearchUrl}  (index "sock-shop-logs"; query via curl GET ?q= or POST /_search)`,
        '- Kubernetes cluster: kubectl (already configured; namespace sock-shop)',
        '',
        'Follow this exact protocol. Use ONLY run_command (with curl / kubectl), hypothesis_tracker, incident_checkpoint, generate_postmortem. DO NOT read the csv files directly with read_file — fetch data through the real interfaces above.',
        '',
        'Step 1 — Metrics (Prometheus): use run_command + curl to:',
        `  - curl -s "${sources.prometheusUrl}/api/v1/label/__name__/values"  (list metric names)`,
        `  - curl -s "${sources.prometheusUrl}/api/v1/query?query=<metric_name>"  (instant value)`,
        `  - curl -s "${sources.prometheusUrl}/api/v1/query_range?query=<metric_name>&start=${start}&end=${end}&step=30"  (time window)`,
        '  Identify which service shows anomalous metrics around the fault time.',
        `  High-signal metric names to query first (exact names exist in Prometheus): ${SCENARIO.keyMetrics.join(', ')}.`,
        '',
        'Step 2 — Logs (Elasticsearch): use run_command + curl to:',
        `  - curl -s "${sources.elasticsearchUrl}/sock-shop-logs/_search?q=container_name:payment&size=20"`,
        `  - curl -s "${sources.elasticsearchUrl}/sock-shop-logs/_search?q=severity:ERROR&size=20"`,
        '  Find ERROR / exception messages from the affected service around the fault time.',
        '',
        'Step 3 — Cluster (kubectl): use run_command to:',
        '  - kubectl get pods -n sock-shop',
        '  - kubectl logs -n sock-shop <payment-pod> --tail=50',
        '  Confirm which workload is affected.',
        '',
        'Step 4 — Hypothesis chain: use hypothesis_tracker to add at least 2 hypotheses (one most-likely root cause with priority 1, one alternative to rule out). Attach evidence (add_evidence) quoting actual command output (command, output_summary, data_source, timestamp, supports). Then update_status: confirmed for the root cause, refuted for the ruled-out one.',
        '',
        `Step 5 — Create a checkpoint: incident_checkpoint action=create, name="${SCENARIO.incidentTitle}", incident_title="${SCENARIO.incidentTitle}", severity="${SCENARIO.severity}".`,
        'Step 6 — incident_checkpoint action=switch_to the checkpoint created in step 5.',
        'Step 7 — incident_checkpoint action=generate_handover for that checkpoint.',
        '',
        'Step 8 — Postmortem: call generate_postmortem with:',
        `  - checkpoint_id: the id from step 5`,
        '  - impact: brief description of affected scope',
        '  - remediation_actions: array of recovery actions taken',
        '  - lessons_learned: array of improvement items',
        '',
        'Step 9 — Print the postmortem report content to the user.',
        '',
        'Rules:',
        '- Do NOT use shell pipes, command substitution, or jq.',
        '- Always quote URLs with double quotes.',
        '- Never run write operations (no -X POST except ES _search; no kubectl apply/delete/exec).',
        '- Only tools: run_command, hypothesis_tracker, incident_checkpoint, generate_postmortem.',
      ].join('\n')

      type ChatMessage = import('../../src/types.js').ChatMessage
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ]

      const contentReplacementState = createContentReplacementState()
      const contextCollapseState = createContextCollapseState()
      const toolCalls: string[] = []
      let handoverOutput = ''
      let postmortemOutput = ''
      let postmortemCpId = ''

      const result = await runAgentTurn({
        model,
        tools,
        messages,
        cwd,
        permissions,
        maxSteps: 80,
        modelName: runtime.model,
        contentReplacementState,
        contextCollapseState,
        onToolResult: (_toolUseId, toolName, output, isError) => {
          const label = isError
            ? `ERROR(${output.slice(0, 80).replace(/\n/g, ' ')}…)`
            : 'OK'
          toolCalls.push(`${toolName}: ${label}`)

          if (
            toolName === 'incident_checkpoint' &&
            !isError &&
            output.includes('事故简报')
          ) {
            handoverOutput = output
          }

          if (toolName === 'incident_checkpoint' && !isError) {
            const cpMatch = /Checkpoint created: (cp_[a-z0-9]+)/.exec(output)
            if (cpMatch) postmortemCpId = cpMatch[1]!
          }

          if (
            toolName === 'generate_postmortem' &&
            !isError &&
            output.includes('Postmortem generated')
          ) {
            postmortemOutput = output
          }
        },
      })

      // 如果 tool result 中没捕获到 postmortem，从 final assistant message 查找
      if (!postmortemOutput) {
        const lastAssistant = [...result].reverse().find(m => m.role === 'assistant')
        if (lastAssistant?.content) {
          const pmMatch = /# Postmortem:[\s\S]+/.exec(lastAssistant.content)
          if (pmMatch) postmortemOutput = pmMatch[0]
        }
      }

      // ── 断言：全链路工具调用 ──
      const usedToolNames = [
        ...new Set(toolCalls.map(t => t.split(':')[0].trim())),
      ]
      assert.ok(
        usedToolNames.includes('run_command'),
        `agent should query data via run_command, got: ${usedToolNames.join(', ')}`,
      )
      assert.ok(
        !usedToolNames.includes('read_file'),
        `agent should NOT use read_file, got: ${usedToolNames.join(', ')}`,
      )
      assert.ok(
        usedToolNames.includes('hypothesis_tracker'),
        `agent should use hypothesis_tracker, got: ${usedToolNames.join(', ')}`,
      )
      assert.ok(
        usedToolNames.includes('incident_checkpoint'),
        `agent should use incident_checkpoint, got: ${usedToolNames.join(', ')}`,
      )
      assert.ok(
        usedToolNames.includes('generate_postmortem'),
        `agent should use generate_postmortem, got: ${usedToolNames.join(', ')}`,
      )

      // 没有工具调用错误
      const errors = toolCalls.filter(t => t.includes('ERROR'))
      assert.equal(errors.length, 0, `tool errors: ${errors.join(', ')}`)

      // ── 断言：交接简报 ──
      assert.ok(handoverOutput.length > 0, 'handover should be captured')
      assert.match(handoverOutput, new RegExp(SCENARIO.severity))
      assert.match(handoverOutput, /已排除|refuted/i)
      assert.match(handoverOutput, /待验证|pending/i)
      assert.match(handoverOutput, new RegExp(SCENARIO.expectedService, 'i'))

      // ── 断言：postmortem 报告生成 ──
      assert.ok(
        postmortemOutput.length > 0,
        'postmortem output should be captured from tool result or assistant message',
      )
      assert.match(postmortemOutput, /# Postmortem:/)
      assert.match(postmortemOutput, new RegExp(SCENARIO.incidentTitle))
      assert.match(postmortemOutput, new RegExp(SCENARIO.severity))
      assert.match(postmortemOutput, /## 1\. 概述/)
      assert.match(postmortemOutput, /## 2\. 影响范围/)
      assert.match(postmortemOutput, /## 3\. 时间线/)
      assert.match(postmortemOutput, /## 4\. 根因分析/)
      assert.match(postmortemOutput, /## 5\. 已排除的假设/)
      assert.match(postmortemOutput, /## 6\. 处置记录/)
      assert.match(postmortemOutput, /## 7\. 经验教训与改进项/)
      // 根因分析应含 confirmed 假设（有内容，不是占位符）
      assert.doesNotMatch(postmortemOutput, /无 confirmed 假设——根因未定位或未确认/)
      // 时间线应有证据条目（不是占位符）
      assert.doesNotMatch(postmortemOutput, /\(暂无证据记录\)/)

      // ── 断言：postmortem 文件落盘 ──
      // 从 postmortem 输出中提取 checkpoint_id（如果 tool result 捕获到）
      let cpId = postmortemCpId
      if (!cpId) {
        // 从 generate_postmortem 输出中提取
        const cpMatch = /checkpoint (cp_[a-z0-9]+)/.exec(postmortemOutput)
        assert.ok(cpMatch, `expected checkpoint id in postmortem output`)
        cpId = cpMatch[1]!
      }
      const filePath = postmortemFilePath(cwd, cpId)
      const fileStats = await stat(filePath)
      assert.ok(fileStats.isFile(), `postmortem file should exist at ${filePath}`)
      const fileContent = await readFile(filePath, 'utf8')
      assert.match(fileContent, /# Postmortem:/)
      assert.match(fileContent, new RegExp(SCENARIO.incidentTitle))
      // 落盘文件内容应与工具输出中的报告部分一致
      assert.match(fileContent, /## 4\. 根因分析/)
    } finally {
      await sources.stop()
    }
  },
)
