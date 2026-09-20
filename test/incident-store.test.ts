/**
 * T12：聚合 / 去重状态入库（plan G9）。
 *
 * 核心命题：**两个"实例"共享同一份 store 时**，跨批次关联与去重冷却必须成立——
 * 也就是"实例 A 收到的告警，实例 B 能看见并并入同一事件"。
 *
 * 测试手法：不真起两个进程，而是造**两个 `IncidentRegistry` 实例**（各自独立内存）
 * 但**注入同一个 store**。每一次 resolve/flush 都通过 store 交换状态——
 * 这精确模拟了"进程间只能通过库看见彼此"这一真实约束。
 * 若实现偷偷用进程内全局变量，这些测试会红（那正是要防的）。
 *
 * 纯内存 store 即可完成全部断言（PG 实现跑同一组契约，另在 pg 测试里）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { IncidentRegistry } from '../src/webhook/incident-registry.js'
import { AlertDedupe } from '../src/webhook/dedupe.js'
import { createMemoryIncidentStore } from '../src/incident/memory-store.js'
import { createMemoryDedupeStore } from '../src/incident/memory-store.js'
import type { Alert } from '../src/webhook/types.js'
import { runMemoryIncidentStoreContract } from './helpers/incident-store-contract.js'

// 契约组（内存实现）。PG 实现跑同一组断言，见 incident-store-pg.test.ts。
runMemoryIncidentStoreContract()

/** 造一条告警（labels 决定关联维度）。 */
function makeAlert(over: Partial<Alert> & { title: string }): Alert {
  const labels = over.labels ?? {}
  return {
    id: over.id ?? `aid-${over.title}`,
    title: over.title,
    severity: over.severity ?? 'SEV2',
    summary: over.summary ?? 'summary',
    description: over.description ?? 'desc',
    labels,
    startsAt: over.startsAt ?? '2026-09-20T10:00:00Z',
    status: over.status ?? 'firing',
  }
}

describe('T12 · IncidentStore：双实例共享一库时的跨批次关联', () => {
  it('实例 A 建的事件，实例 B 能看见并作为新成员并入（不重复建事件）', async () => {
    const store = createMemoryIncidentStore()

    // ── 实例 A：收到首批 2 条同服务告警（达阈值 → 建事件）──
    const a = new IncidentRegistry({ store, minAlerts: 2 })
    await a.hydrate()
    const r1 = a.resolve(
      [
        makeAlert({ title: 'DB timeout', id: 'a1', labels: { service: 'payment' } }),
        makeAlert({ title: 'DB conn refused', id: 'a2', labels: { service: 'payment' } }),
      ],
      {},
      1000,
    )
    assert.equal(r1.created, 1, '实例 A 应新建 1 个事件')
    await a.flush()

    // ── 实例 B：全新 registry（内存为空），注入同一 store ──
    const b = new IncidentRegistry({ store, minAlerts: 2 })
    await b.hydrate()
    const r2 = b.resolve(
      [makeAlert({ title: 'DB deadlock', id: 'a3', labels: { service: 'payment' } })],
      {},
      2000,
    )

    // 关键断言：B 没建新事件，而是把它并入了 A 建的那个事件
    assert.equal(r2.created, 0, '实例 B 不应新建事件——它应看见 A 的 open 事件')
    assert.equal(r2.decisions.length, 1)
    const d = r2.decisions[0]!
    const snapshot = await store.loadAll()
    const aCreated = [...snapshot.byId.values()].find(
      rec => rec.groupKey.includes('payment'),
    )
    assert.ok(aCreated, 'store 里应有 A 建的事件')
    assert.equal(
      d.incidentId,
      aCreated.incidentId,
      'B 的告警应并入 A 的事件（同一 incidentId）',
    )
    assert.equal(snapshot.byId.size, 1, '共享库里应只有 1 个事件（未碎片化）')
  })

  it('实例重启（新 registry + hydrate）后仍能续接未关闭事件', async () => {
    const store = createMemoryIncidentStore()

    const first = new IncidentRegistry({ store, minAlerts: 2 })
    await first.hydrate()
    first.resolve(
      [
        makeAlert({ title: 'Disk full', id: 'd1', labels: { app: 'billing' } }),
        makeAlert({ title: 'Disk io err', id: 'd2', labels: { app: 'billing' } }),
      ],
      {},
      1000,
    )
    await first.flush()

    // 模拟"进程重启"：旧实例丢弃，全新 registry 从库恢复
    const after = new IncidentRegistry({ store, minAlerts: 2 })
    await after.hydrate()
    // 用持久化版本（hydrate → resolve → flush）：断言 store 里最终状态
    const r = await after.resolvePersisted(
      [makeAlert({ title: 'Disk slow', id: 'd3', labels: { app: 'billing' } })],
      {},
      5000,
    )

    assert.equal(r.created, 0, '重启后应看见既有 open 事件，不新建')
    const snapshot = await store.loadAll()
    assert.equal(snapshot.byId.size, 1, '重启不得另起事件（跨实例连续性）')
    const rec = [...snapshot.byId.values()][0]!
    assert.equal(rec.alerts.length, 3, '重启后新成员应被加入同一事件（成员数 3）')
  })

  it('flush 的删除集合生效（容量淘汰写入库，不会"复活"）', async () => {
    const store = createMemoryIncidentStore()
    // maxIncidents=1：sweep 会淘汰超出的部分。
    // 注意 `sweep()` 在 `resolve()` **开头**执行、且只删 `size - maxIncidents` 条
    // （既有行为，内存实现同样如此）——故稳定态最多为 `maxIncidents + 1`。
    // 本用例要验证的不是"等于上限"，而是**淘汰被写进了库**（deleted 生效、不复活）。
    const reg = new IncidentRegistry({ store, minAlerts: 1, maxIncidents: 1 })
    await reg.hydrate()

    await reg.resolvePersisted(
      [makeAlert({ title: 'X', id: 'x1', labels: { service: 'svc-x' } })],
      {},
      1000,
    )
    await reg.resolvePersisted(
      [makeAlert({ title: 'Y', id: 'y1', labels: { service: 'svc-y' } })],
      {},
      2000,
    )
    assert.equal((await store.loadAll()).byId.size, 2, '此时库中 2 个（尚未触发淘汰）')

    // 第三批：sweep 在开头看到 byId=2 > 1 → 淘汰最旧的 X。
    await reg.resolvePersisted(
      [makeAlert({ title: 'Z', id: 'z1', labels: { service: 'svc-z' } })],
      {},
      3000,
    )

    const snapshot = await store.loadAll()
    const keys = [...snapshot.byId.values()].map(rec => rec.groupKey)
    assert.equal(snapshot.byId.size, 2, '淘汰 1 条后库中剩 2 条')
    assert.ok(
      !keys.some(k => k.includes('svc-x')),
      `被淘汰的 svc-x 必须从库中消失（deleted 生效），实际 keys=${keys.join(',')}`,
    )
    assert.ok(
      keys.some(k => k.includes('svc-z')),
      '新事件 svc-z 应已入库',
    )
  })

  it('markResolved 的关闭状态跨实例可见', async () => {
    const store = createMemoryIncidentStore()

    const a = new IncidentRegistry({ store, minAlerts: 2 })
    await a.hydrate()
    const alerts = [
      makeAlert({ title: 'A down', id: 'r1', labels: { service: 'auth' } }),
      makeAlert({ title: 'A err', id: 'r2', labels: { service: 'auth' } }),
    ]
    a.resolve(alerts, {}, 1000)
    await a.flush()

    // 另一实例收到全部成员的 resolved 通知 → 关闭事件
    const b = new IncidentRegistry({ store, minAlerts: 2 })
    await b.hydrate()
    const resolved = await b.markResolvedPersisted(
      alerts.map(al => ({ ...al, status: 'resolved' as const })),
      {},
      3000,
    )
    assert.equal(resolved.closed.length, 1, '全部成员恢复 → 关闭 1 个事件')
    await b.flush()

    // 回到实例 A：它应看见事件已关闭（不会再收新成员）
    const a2 = new IncidentRegistry({ store, minAlerts: 2 })
    await a2.hydrate()
    const snapshot = await store.loadAll()
    const rec = [...snapshot.byId.values()][0]!
    assert.equal(rec.status, 'resolved', '关闭状态应已入库')
  })

  it('无 store 时行为零变化（默认同步路径）', () => {
    // 不传 store：既有用法必须一模一样地工作
    const reg = new IncidentRegistry({ minAlerts: 2 })
    const r = reg.resolve(
      [
        makeAlert({ title: 'P', id: 'p1', labels: { service: 'pay' } }),
        makeAlert({ title: 'Q', id: 'p2', labels: { service: 'pay' } }),
      ],
      {},
      1000,
    )
    assert.equal(r.created, 1)
    assert.equal(reg.stats().open, 1)
  })
})

describe('T12 · DedupeStore：双实例共享一库时的去重冷却', () => {
  it('实例 A 记录过的告警，实例 B 在静默期内重复到达 → 抑制', async () => {
    const store = createMemoryDedupeStore()

    const a = new AlertDedupe(60_000, { store })
    const alert = makeAlert({ title: 'Dup', id: 'dup-1' })
    assert.equal(await a.shouldDiagnosePersisted(alert, 1000), 'new', '首次 → new')
    await a.flush()

    // 另一实例（内存为空）+ 同一 store → 应看见冷却态
    const b = new AlertDedupe(60_000, { store })
    await b.hydrate()
    assert.equal(
      await b.shouldDiagnosePersisted(alert, 2000),
      'suppressed',
      '静默期内内容未变 → 跨实例抑制',
    )
  })

  it('内容变化跨实例可见 → updated（重诊断）', async () => {
    const store = createMemoryDedupeStore()
    const a = new AlertDedupe(60_000, { store })
    const base = makeAlert({ title: 'Chg', id: 'chg-1', summary: 'v1' })
    await a.shouldDiagnosePersisted(base, 1000)
    await a.flush()

    const b = new AlertDedupe(60_000, { store })
    await b.hydrate()
    const changed = { ...base, summary: 'v2' }
    assert.equal(
      await b.shouldDiagnosePersisted(changed, 2000),
      'updated',
      '内容哈希变化 → updated',
    )
  })

  it('静默期已过 → new（窗口跨实例正确重开）', async () => {
    const store = createMemoryDedupeStore()
    const a = new AlertDedupe(1000, { store })
    const alert = makeAlert({ title: 'Exp', id: 'exp-1' })
    await a.shouldDiagnosePersisted(alert, 1000)
    await a.flush()

    const b = new AlertDedupe(1000, { store })
    await b.hydrate()
    assert.equal(
      await b.shouldDiagnosePersisted(alert, 5000),
      'new',
      '超过静默期 → 视为新发作',
    )
  })

  it('无 store 时行为零变化（既有同步语义）', () => {
    const d = new AlertDedupe(60_000)
    const alert = makeAlert({ title: 'Sync', id: 'sync-1' })
    assert.equal(d.shouldDiagnose(alert), 'new')
    assert.equal(d.shouldDiagnose(alert), 'suppressed')
  })
})
