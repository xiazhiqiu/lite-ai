import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { IngestPipeline, type IngestConfig } from '../src/ingest/pipeline.js'
import type { Alert, Incident } from '../src/webhook/types.js'

let tempHome: string

test.before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-ingest-'))
  process.env.LITE_AI_HOME = tempHome
})

test.after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempHome, { recursive: true, force: true })
})

const CWD = `D:/dev/ingest-${Date.now()}`

function makeAlert(over: Partial<Alert> & { id: string }): Alert {
  return {
    title: over.title ?? over.id,
    severity: over.severity ?? 'warning',
    summary: over.summary ?? '',
    description: over.description ?? '',
    labels: over.labels ?? {},
    startsAt: over.startsAt ?? new Date('2026-09-18T00:00:00Z').toISOString(),
    status: over.status ?? 'firing',
    ...over,
  } as Alert
}

function makeConfig(over: Partial<IngestConfig> = {}): IngestConfig {
  return {
    autoDiagnose: true,
    maxConcurrentDiagnoses: 2,
    ...over,
  }
}

/** 静音日志，避免测试输出噪音。 */
const silent = () => {
  /* no-op */
}

// ---------- 与传输方式无关：不经 HTTP 直接摄入 ----------

test('IngestPipeline: 同服务两条告警折叠为一次事件级 RCA', async () => {
  const calls: Array<{ alert: Alert; incident?: Incident }> = []
  const pipeline = new IngestPipeline(CWD, makeConfig(), {
    log: silent,
    diagnose: async (alert, incident) => {
      calls.push({ alert, incident })
      return { sessionId: incident?.incidentId ?? alert.id, diagnosisSummary: 'ok' }
    },
  })

  const result = pipeline.ingest([
    makeAlert({ id: 'a1', title: 'MySQLDown', labels: { service: 'payments' } }),
    makeAlert({ id: 'a2', title: 'ESConnRefused', labels: { service: 'payments' } }),
  ])

  // 关键：accepted = 1（一个事件 = 一次 RCA），而非 2（每条告警各烧一次）
  assert.equal(result.accepted, 1)
  assert.equal(result.deduplicated, 0)
  assert.equal(result.truncated, 0)

  await pipeline.drained()
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.incident, '事件级诊断必须带 incident（sessionId 取 incidentId）')
  assert.equal(calls[0]!.incident!.alerts.length, 2)
  pipeline.close()
})

test('IngestPipeline: 同批重复到达只记时间线，不重复触发诊断', async () => {
  let count = 0
  const pipeline = new IngestPipeline(CWD, makeConfig(), {
    log: silent,
    diagnose: async alert => {
      count += 1
      return { sessionId: alert.id, diagnosisSummary: 'ok' }
    },
  })

  const batch = () => [
    makeAlert({ id: 'r1', title: 'MySQLDown', labels: { service: 'payments' } }),
    makeAlert({ id: 'r2', title: 'ESConnRefused', labels: { service: 'payments' } }),
  ]

  assert.equal(pipeline.ingest(batch()).accepted, 1)
  const second = pipeline.ingest(batch())
  assert.equal(second.accepted, 0)
  assert.equal(second.deduplicated, 2, '重复到达应计入 deduplicated 而非静默丢弃')

  await pipeline.drained()
  assert.equal(count, 1, '同一事件不应重复烧 token')
  pipeline.close()
})

test('IngestPipeline: 跨批次累积 —— 两条分批到达也能升级为事件级', async () => {
  const seen: Array<Incident | undefined> = []
  const pipeline = new IngestPipeline(CWD, makeConfig(), {
    log: silent,
    diagnose: async (_alert, incident) => {
      seen.push(incident)
      return { sessionId: incident?.incidentId ?? 'x', diagnosisSummary: 'ok' }
    },
  })

  // 第一批只有 1 条：未达 minAlerts → 先建"弱事件"并按单条诊断
  const first = pipeline.ingest([
    makeAlert({ id: 'b1', title: 'MySQLDown', labels: { service: 'payments' } }),
  ])
  assert.equal(first.accepted, 1)

  // 第二批（另一条告警、同一服务）到达 → 并入已有事件并升级为事件级重分析
  const second = pipeline.ingest([
    makeAlert({ id: 'b2', title: 'ESConnRefused', labels: { service: 'payments' } }),
  ])
  assert.equal(second.accepted, 1)

  await pipeline.drained()
  assert.equal(seen.length, 2)
  assert.equal(seen[0], undefined, '第一批只有 1 条 → 单条诊断（无 incident）')
  assert.equal(seen[1]!.alerts.length, 2, '第二批并入后事件含 2 名成员')
  pipeline.close()
})

test('IngestPipeline: autoDiagnose=false 时不诊断，但截断护栏仍生效', async () => {
  const pipeline = new IngestPipeline(
    CWD,
    makeConfig({ autoDiagnose: false, maxBatchPerRequest: 2 }),
    { log: silent, diagnose: async alert => ({ sessionId: alert.id, diagnosisSummary: 'ok' }) },
  )
  const result = pipeline.ingest([
    makeAlert({ id: 'c1', labels: { service: 's' } }),
    makeAlert({ id: 'c2', labels: { service: 's' } }),
    makeAlert({ id: 'c3', labels: { service: 's' } }),
  ])
  assert.equal(result.accepted, 0)
  assert.equal(result.truncated, 1, '护栏是内存/安全边界，不受 autoDiagnose 影响')
  pipeline.close()
})

test('IngestPipeline: 批处理护栏按 maxBatchPerRequest 截断', async () => {
  const pipeline = new IngestPipeline(
    CWD,
    makeConfig({ maxBatchPerRequest: 3 }),
    { log: silent, diagnose: async alert => ({ sessionId: alert.id, diagnosisSummary: 'ok' }) },
  )
  const result = pipeline.ingest(
    Array.from({ length: 10 }, (_, i) =>
      makeAlert({ id: `d${i}`, severity: 'warning', labels: {} }),
    ),
  )
  assert.equal(result.truncated, 7)
  pipeline.close()
})

test('IngestPipeline: close 幂等；未 start 也不留后台句柄', async () => {
  const pipeline = new IngestPipeline(
    CWD,
    makeConfig({ topology: { enabled: false } }),
    { log: silent, diagnose: async alert => ({ sessionId: alert.id, diagnosisSummary: 'ok' }) },
  )
  // 拓扑默认关闭：start 不产生定时器；close 重复调用安全
  pipeline.start()
  pipeline.close()
  pipeline.close()
  await pipeline.drained()
  assert.equal(pipeline.incidents.stats().total, 0)
})
