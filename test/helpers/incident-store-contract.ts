/**
 * IncidentStore / DedupeStore 契约断言集（T12，plan G9）。
 *
 * 与 `job-store-contract.ts` 同构：契约需被两个测试文件复用——
 * - `incident-store.test.ts`     → 内存实现（无 PG 也必须真跑）
 * - `incident-store-pg.test.ts`  → PG 实现（无 PG 时整组 skip）
 *
 * 纯函数形式，避免 import 时触发对方顶层 describe（ESM import 即执行）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { DedupeStore, IncidentStore } from '../../src/incident/store.js'
import { createMemoryIncidentStore, createMemoryDedupeStore } from '../../src/incident/memory-store.js'
import type { IncidentRecord } from '../../src/incident/types.js'
import type { Alert } from '../../src/webhook/types.js'

/** 造一条最小合规的 Alert。 */
export function contractAlert(id: string, groupValue: string): Alert {
  return {
    id,
    title: `alert-${id}`,
    severity: 'SEV2',
    summary: 'summary',
    description: 'description',
    labels: { service: groupValue },
    startsAt: '2026-09-20T10:00:00Z',
    status: 'firing',
  }
}

/** 造一条最小合规的 IncidentRecord（key_name 非空，可被唯一索引约束）。 */
export function contractRecord(
  incidentId: string,
  groupKey: string,
  alertIds: string[],
): IncidentRecord {
  const alerts = alertIds.map(id => contractAlert(id, groupKey.replace('service=', '')))
  const seen = new Map(alertIds.map(id => [id, 1]))
  return {
    incidentId,
    type: 'rule',
    keyStrength: 'primary',
    keyName: 'service',
    groupKey,
    dimensions: { service: groupKey.replace('service=', '') },
    alerts,
    seen,
    primaryAlert: alerts[0]!,
    severity: 'SEV2',
    startedAt: '2026-09-20T10:00:00Z',
    lastAlertAt: 1000,
    createdAt: 1000,
    status: 'open',
    diagnosed: false,
    resolvedIds: new Set(),
    resolvedAt: null,
    reasons: new Set(['primaryMatch']),
  }
}

/**
 * @param name     suite 名（'memory' / 'pg'）
 * @param make    工厂：返回一对**干净**的 store（每用例前调用）
 * @param reset   可选：清库钩子（PG 用；内存不需）
 */
export function runIncidentStoreContract(
  name: string,
  make: () => { incident: IncidentStore; dedupe: DedupeStore },
  reset?: () => Promise<void>,
): void {
  describe(`IncidentStore contract (${name})`, () => {
    let incident: IncidentStore
    let dedupe: DedupeStore

    beforeEach(async () => {
      if (reset !== undefined) await reset()
      ;({ incident, dedupe } = make())
    })

    it('loadAll 空库返回空快照', async () => {
      const snap = await incident.loadAll()
      assert.equal(snap.byId.size, 0)
    })

    it('commit(created) 后 loadAll 能无损还原记录（含 seen / reasons）', async () => {
      const rec = contractRecord('inc-1', 'service=payment', ['a1', 'a2'])
      await incident.commit({ created: [rec], updated: [], deleted: [], memberUpserts: [] })

      const snap = await incident.loadAll()
      assert.equal(snap.byId.size, 1)
      const got = snap.byId.get('inc-1')!
      assert.equal(got.groupKey, 'service=payment')
      assert.equal(got.alerts.length, 2)
      assert.equal(got.seen.get('a1'), 1)
      assert.deepEqual([...got.reasons], ['primaryMatch'])
      assert.equal(got.keyName, 'service')
      assert.equal(got.keyStrength, 'primary')
      assert.equal(got.dimensions.service, 'payment')
    })

    it('commit(updated) 覆盖既有记录', async () => {
      const rec = contractRecord('inc-1', 'service=payment', ['a1'])
      await incident.commit({ created: [rec], updated: [], deleted: [], memberUpserts: [] })

      const updated: IncidentRecord = {
        ...rec,
        alerts: [...rec.alerts, contractAlert('a2', 'payment')],
        seen: new Map([['a1', 1], ['a2', 1]]),
        diagnosed: true,
        status: 'resolved',
        resolvedAt: 9999,
      }
      await incident.commit({ created: [], updated: [updated], deleted: [], memberUpserts: [] })

      const snap = await incident.loadAll()
      assert.equal(snap.byId.size, 1)
      const got = snap.byId.get('inc-1')!
      assert.equal(got.alerts.length, 2, '成员应增至 2')
      assert.equal(got.diagnosed, true)
      assert.equal(got.status, 'resolved')
      assert.equal(got.resolvedAt, 9999)
    })

    it('commit(deleted) 真正删除（不残留）', async () => {
      await incident.commit({
        created: [contractRecord('inc-1', 'service=payment', ['a1'])],
        updated: [],
        deleted: [],
        memberUpserts: [],
      })
      await incident.commit({ created: [], updated: [], deleted: ['inc-1'], memberUpserts: [] })

      const snap = await incident.loadAll()
      assert.equal(snap.byId.size, 0, '删除后不应残留')
    })

    it('loadAll 返回的是快照：修改它不影响 store（下次 load 仍是原值）', async () => {
      await incident.commit({
        created: [contractRecord('inc-1', 'service=payment', ['a1'])],
        updated: [],
        deleted: [],
        memberUpserts: [],
      })

      const first = await incident.loadAll()
      const got = first.byId.get('inc-1')!
      got.status = 'resolved'
      got.alerts.push(contractAlert('injected', 'payment'))
      got.seen.set('a1', 99)

      const second = await incident.loadAll()
      const again = second.byId.get('inc-1')!
      assert.equal(again.status, 'open', '快照修改不得写穿 store')
      assert.equal(again.alerts.length, 1, '快照 alerts 修改不得写穿 store')
      assert.equal(again.seen.get('a1'), 1, '快照 seen 修改不得写穿 store')
    })

    it('快照与库中的 Map / Set 是独立实例（引用隔离）', async () => {
      await incident.commit({
        created: [contractRecord('inc-1', 'service=payment', ['a1'])],
        updated: [],
        deleted: [],
        memberUpserts: [],
      })
      const a = await incident.loadAll()
      const b = await incident.loadAll()
      assert.notEqual(a.byId.get('inc-1')!.seen, b.byId.get('inc-1')!.seen, '两次快照不得共享 Map 实例')
    })

    it('DedupeStore：check 首次返回 null 并写入', async () => {
      const prev = await dedupe.check('fp-1', { hash: 'h1', firstSeen: 1000 })
      assert.equal(prev, null)
      const got = await dedupe.get('fp-1')
      assert.deepEqual(got, { hash: 'h1', firstSeen: 1000 })
    })

    it('DedupeStore：check 第二次返回既有值（旧值语义）', async () => {
      await dedupe.check('fp-1', { hash: 'h1', firstSeen: 1000 })
      const prev = await dedupe.check('fp-1', { hash: 'h2', firstSeen: 5000 })
      assert.deepEqual(prev, { hash: 'h1', firstSeen: 1000 }, '应返回写入前的旧值')

      const got = await dedupe.get('fp-1')
      assert.deepEqual(got, { hash: 'h2', firstSeen: 5000 }, '新值应已落库')
    })

    it('DedupeStore：purgeExpired 删除窗口外条目', async () => {
      await dedupe.check('old', { hash: 'h', firstSeen: 1000 })
      await dedupe.check('fresh', { hash: 'h', firstSeen: 10_000 })
      const removed = await dedupe.purgeExpired(5000, 11_000)
      assert.equal(removed, 1, '仅 old 超窗口')
      assert.equal(await dedupe.get('old'), null)
      assert.ok(await dedupe.get('fresh'), 'fresh 应保留')
    })

    it('DedupeStore：get 不存在返回 null', async () => {
      assert.equal(await dedupe.get('nope'), null)
    })
  })
}

/** 内存实现契约：恒可跑（无 PG 依赖）。 */
export function runMemoryIncidentStoreContract(): void {
  runIncidentStoreContract('memory', () => ({
    incident: createMemoryIncidentStore(),
    dedupe: createMemoryDedupeStore(),
  }))
}
