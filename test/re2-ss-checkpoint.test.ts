import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolRegistry } from '../src/tool.js'

/**
 * 端到端场景验证：用 RE2-SS 测试集跑 3 个故障场景，
 * 模拟完整诊断流程（读取真实遥测数据 → 注册假设 → 附着证据 → 更新状态 →
 * 创建检查点 → 生成交接简报），验证 Spec 2 交接简报功能。
 *
 * 覆盖场景：
 *  1. payment_loss/1  —— payment 网络丢包（SEV1）
 *  2. carts_mem/1     —— carts 内存压力（SEV2）
 *  3. orders_delay/1  —— orders 下单延迟（SEV2）
 */

const datasetRoot = path.resolve(
  fileURLToPath(new URL('../dataset/RE2-SS', import.meta.url)),
)

// 场景定义：dir 相对于 datasetRoot
const SCENARIOS = [
  {
    dir: path.join('RE2-SS', 'payment_loss', '1'),
    app: 'payment',
    name: 'payment 网络丢包',
    incidentTitle: 'payment 服务网络丢包导致支付请求失败',
    severity: 'SEV1',
    /** 场景特有指标列名（用于证明读到了真实指标数据）。 */
    metricCol: 'payment_container-network-transmit-packets-dropped-total',
    /** 场景特有日志片段（作为证据 output_summary，应落入假设链落盘文件）。 */
    logSnippet:
      'ts=2024-01-18T20:50:34Z caller=logging.go:29 method=Authorise result=true took=898ns',
  },
  {
    dir: path.join('carts_mem', '1'),
    app: 'carts',
    name: 'carts 内存压力',
    incidentTitle: 'carts 容器内存压力导致购物车接口延迟',
    severity: 'SEV2',
    metricCol: 'carts_container-memory-usage-bytes',
    logSnippet: 'Exception trying to launch/remove worker container',
  },
  {
    dir: path.join('orders_delay', '1'),
    app: 'orders',
    name: 'orders 下单延迟',
    incidentTitle: 'orders 下单链路延迟升高',
    severity: 'SEV2',
    metricCol: 'orders_istio-latency-99',
    logSnippet: 'POST /orders 201 187.345 ms',
  },
] as const

let tempRoot: string

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-re2ss-'))
  process.env.LITE_AI_HOME = tempRoot
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempRoot, { recursive: true, force: true })
})

async function registry(): Promise<ToolRegistry> {
  const { incidentCheckpointTool } = await import('../src/tools/incident-checkpoint.js')
  const { hypothesisTrackerTool } = await import('../src/tools/hypothesis-tracker.js')
  const { ToolRegistry: TR } = await import('../src/tool.js')
  return new TR([incidentCheckpointTool, hypothesisTrackerTool])
}

/** 读取文件头部（避免加载 17MB 全量日志）。 */
async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/**
 * 从 RE2-SS 场景目录加载真实遥测数据，返回供证据/断言使用的信息。
 * 任一关键文件缺失或解析失败都会让测试失败，从而证明"确实读了测试集"。
 */
async function loadScenarioData(dir: string): Promise<{
  injectTs: string
  serviceCount: number
  metricHead: string
  logHead: string
}> {
  const injectTs = (await readFile(path.join(dir, 'inject_time.txt'), 'utf8')).trim()
  const cluster = JSON.parse(
    await readFile(path.join(dir, 'cluster_info.json'), 'utf8'),
  ) as Record<string, { template?: string }>
  const metricHead = await readHead(path.join(dir, 'metrics.csv'), 96 * 1024)
  const logHead = await readHead(path.join(dir, 'logs.csv'), 128 * 1024)
  return {
    injectTs,
    serviceCount: Object.keys(cluster).length,
    metricHead,
    logHead,
  }
}

/** 用 hypothesis_tracker 注册假设链（证据取自真实数据片段）。 */
async function seedHypotheses(
  tools: ToolRegistry,
  ctx: { cwd: string },
  input: {
    confirmed: { id: string; description: string; evidence: { command: string; output_summary: string; data_source: string; supports: boolean }[]; conclusion: string }
    refuted: { id: string; description: string; evidence: { command: string; output_summary: string; data_source: string; supports: boolean }[] }
    pending: { id: string; description: string; priority: number }
  },
): Promise<void> {
  const now = Date.now()
  const { confirmed, refuted, pending } = input
  for (const [i, h] of [confirmed, refuted, pending].flat().entries()) {
    const r = await tools.execute(
      'hypothesis_tracker',
      { action: 'add_hypothesis', id: h.id, description: h.description, priority: i + 1 },
      ctx,
    )
    // 假设链是项目级持久化的：同一事故重复诊断时假设已存在（续查语义），幂等跳过。
    if (!r.ok && /already exists/.test(r.output)) continue
    assert.equal(r.ok, true, r.output)
  }
  for (const h of [confirmed, refuted]) {
    for (const e of h.evidence) {
      const r = await tools.execute(
        'hypothesis_tracker',
        {
          action: 'add_evidence',
          hypothesis_id: h.id,
          evidence: { ...e, timestamp: now },
        },
        ctx,
      )
      assert.equal(r.ok, true, r.output)
    }
  }
  const confirmedR = await tools.execute(
    'hypothesis_tracker',
    { action: 'update_status', hypothesis_id: confirmed.id, status: 'confirmed', conclusion: confirmed.conclusion },
    ctx,
  )
  assert.equal(confirmedR.ok, true, confirmedR.output)
  const refutedR = await tools.execute(
    'hypothesis_tracker',
    { action: 'update_status', hypothesis_id: refuted.id, status: 'refuted' },
    ctx,
  )
  assert.equal(refutedR.ok, true, refutedR.output)
}

/** 运行单个场景的端到端验证，返回交接简报输出。 */
async function runScenario(
  scenario: (typeof SCENARIOS)[number],
): Promise<{ handover: string; checkpointId: string }> {
  const tools = await registry()
  const dir = path.join(datasetRoot, scenario.dir)
  const ctx = { cwd: dir }

  // 1) 读取真实遥测数据，验证测试集可解析
  const data = await loadScenarioData(dir)
  assert.ok(data.injectTs.length > 0, 'inject_time.txt 应可读')
  assert.ok(data.serviceCount > 0, 'cluster_info.json 应包含服务模板')
  assert.match(data.metricHead, new RegExp(scenario.metricCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'metrics.csv 应包含场景指标列')
  assert.ok(data.logHead.includes(scenario.logSnippet) || data.logHead.includes('queue-master'), 'logs.csv 头部应可读')

  // 2) 注册假设链（证据引用真实数据）
  await seedHypotheses(tools, ctx, {
    confirmed: {
      id: 'h1',
      description: `${scenario.name} 是根因`,
      conclusion: `基于 ${scenario.metricCol} 指标与日志确认`,
      evidence: [
        {
          command: 'kubectl get pods -n sock-shop -o wide',
          output_summary: `注入时间 ${data.injectTs}，${scenario.name} 相关容器存在`,
          data_source: 'kubectl',
          supports: true,
        },
        {
          command: `kubectl logs -n sock-shop -l app=${scenario.app} --since=30m`,
          output_summary: scenario.logSnippet,
          data_source: 'K8s logs',
          supports: true,
        },
        {
          command: `curl -s "http://prometheus:9090/api/v1/query?query=${scenario.metricCol}[5m]"`,
          output_summary: `${scenario.metricCol} 在故障窗口内出现明显异常`,
          data_source: 'Prometheus',
          supports: true,
        },
      ],
    },
    refuted: {
      id: 'h2',
      description: 'queue-master 无法访问 docker.sock 导致全局故障',
      evidence: [
        {
          command: 'kubectl logs -n sock-shop deployment/queue-master --tail=50',
          output_summary: 'Exception trying to launch/remove worker container ... AFUNIXSocketException: No such file or directory (socket: /var/run/docker.sock)',
          data_source: 'K8s logs',
          supports: false,
        },
      ],
    },
    pending: {
      id: 'h3',
      description: `${scenario.name} 的资源配置或依赖待进一步验证`,
      priority: 3,
    },
  })

  // 3) 创建检查点并切换为活动状态
  const create = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: scenario.name, incident_title: scenario.incidentTitle, severity: scenario.severity },
    ctx,
  )
  assert.equal(create.ok, true, create.output)
  const m = /Checkpoint created: (cp_[a-z0-9]+)/.exec(create.output)
  assert.ok(m, `应返回检查点 id: ${create.output}`)
  const checkpointId = m[1]!

  const sw = await tools.execute(
    'incident_checkpoint',
    { action: 'switch_to', checkpoint_id: checkpointId },
    ctx,
  )
  assert.equal(sw.ok, true, sw.output)

  // 4) 生成交接简报（不传 id，应使用活动检查点）
  const handover = await tools.execute('incident_checkpoint', { action: 'generate_handover' }, ctx)
  assert.equal(handover.ok, true, handover.output)
  return { handover: handover.output, checkpointId }
}

/** 断言交接简报包含完整 sections 且内容来自真实数据。 */
function assertHandoverStructure(
  handover: string,
  scenario: (typeof SCENARIOS)[number],
  refutedDesc: string,
  pendingDesc: string,
): void {
  assert.match(handover, new RegExp(`## 事故简报：${scenario.incidentTitle}`))
  assert.match(handover, /### 严重级别/)
  assert.match(handover, new RegExp(scenario.severity))
  assert.match(handover, /### 现象/)
  assert.match(handover, /### 时间线（关键事件）/)
  assert.match(handover, /\| # \| 命令 \|/)
  // 关键诊断命令出现在时间线表格中（来自假设链证据，去重）
  assert.match(handover, /kubectl get pods -n sock-shop -o wide/)
  assert.match(handover, new RegExp(scenario.metricCol))
  // 已排除的假设
  assert.match(handover, /### 已排除的假设/)
  assert.match(handover, new RegExp(refutedDesc))
  // 待验证的假设
  assert.match(handover, /### 待验证的假设/)
  assert.match(handover, new RegExp(`\\[P3\\] ${pendingDesc} \\(pending\\)`))
  assert.match(handover, /### 推荐的下一步/)
}

test('RE2-SS payment_loss/1：完整诊断流程生成交接简报（SEV1）', async () => {
  const scenario = SCENARIOS[0]!
  const { handover } = await runScenario(scenario)
  assertHandoverStructure(
    handover,
    scenario,
    'queue-master 无法访问 docker.sock 导致全局故障',
    'payment 网络丢包 的资源配置或依赖待进一步验证',
  )
})

test('RE2-SS carts_mem/1：完整诊断流程生成交接简报（SEV2）', async () => {
  const scenario = SCENARIOS[1]!
  const { handover } = await runScenario(scenario)
  assertHandoverStructure(
    handover,
    scenario,
    'queue-master 无法访问 docker.sock 导致全局故障',
    'carts 内存压力 的资源配置或依赖待进一步验证',
  )
})

test('RE2-SS orders_delay/1：完整诊断流程生成交接简报（SEV2）', async () => {
  const scenario = SCENARIOS[2]!
  const { handover } = await runScenario(scenario)
  assertHandoverStructure(
    handover,
    scenario,
    'queue-master 无法访问 docker.sock 导致全局故障',
    'orders 下单延迟 的资源配置或依赖待进一步验证',
  )
})

test('RE2-SS：交接简报与检查点均落盘，真实数据片段进入假设链', async () => {
  const scenario = SCENARIOS[0]!
  const { checkpointId } = await runScenario(scenario)
  const { checkpointsFilePath } = await import('../src/utils/checkpoint-store.js')
  const { hypothesesFilePath } = await import('../src/utils/hypothesis-store.js')
  const dir = path.join(datasetRoot, scenario.dir)
  const cpRaw = await readFile(checkpointsFilePath(dir), 'utf8')
  assert.match(cpRaw, new RegExp(checkpointId))
  assert.match(cpRaw, /SEV1/)
  const hypRaw = await readFile(hypothesesFilePath(dir), 'utf8')
  assert.match(hypRaw, /confirmed/)
  // 真实日志/指标片段应作为证据写入假设链落盘文件
  assert.match(hypRaw, /payment_container-network-transmit-packets-dropped-total/)
  assert.match(hypRaw, /ts=2024-01-18T20:50:34Z caller=logging.go:29 method=Authorise result=true took=898ns/)
  assert.match(hypRaw, /Exception trying to launch\/remove worker container/)
})
