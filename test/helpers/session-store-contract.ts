/**
 * SessionStore 契约断言集（T8）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `job-store-contract.ts` 同一理由：契约要被**两个**测试文件复用 ——
 * - `session-store-contract.test.ts` → 文件实现（**无 PG 也必须真跑**）
 * - `session-store-pg.test.ts`       → PG 实现（无 PG 时整组 skip）
 *
 * 若把断言写在其中一个测试文件里再 import，ESM import 即执行，会让
 * 另一份重复跑一遍。所以这里只导出纯函数形式的 `runSessionStoreContract`。
 *
 * ## 这组断言盯的是什么
 *
 * 不是"能不能存下来"那种happy path —— 而是**最容易在两个后端之间悄悄漂移**的
 * 语义细节。PG 后端是把 JSONL 的行搬进表里，凡搬运都可能漏：
 *
 * - system 消息不入磁盘（两条删除线：`messages.slice(1)`）
 * - 重复 save 幂等（靠 message.id 去重）
 * - 最后一个 compact_boundary 之后才有效（历史截断）
 * - snip 标记要**插回原位**（`reconstructSnippedEvents`）
 * - collapse span 只在 committed 且 boundary 之后才计入
 * - title 取 rename 事件优先于首条 user 消息
 *
 * 任何一条漏掉，症状都是"看起来存进去了，读回来少几段" —— 而且**只在 PG
 * 形态复现**，是最难查的一类 bug。所以两边必须跑同一份断言。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../../src/types.js'
import type { CollapseSpan } from '../../src/compact/context-collapse.js'
import type { SessionStore } from '../../src/session/store.js'

/** 契约用例里每个 store 工厂需要支持的形态（PG 版额外挂 `reset` 清表）。 */
export type ContractStoreFactory = () => SessionStore & {
  reset?: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** system 消息 + N 轮 user/assistant。 */
export function makeConversation(rounds: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'You are helpful.' }]
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'user', content: `U${i}` })
    messages.push({ role: 'assistant', content: `A${i}` })
  }
  return messages
}

function span(id: string, status: 'staged' | 'committed'): CollapseSpan {
  return {
    id,
    startMessageId: 'm1',
    endMessageId: 'm2',
    messageIds: ['m1', 'm2'],
    summary: `summary-${id}`,
    tokensBefore: 100,
    tokensAfter: 40,
    status,
    createdAt: 1000,
    reason: 'manual',
  }
}

export function runSessionStoreContract(
  name: string,
  makeStore: ContractStoreFactory,
): void {
  describe(`SessionStore contract (${name})`, () => {
    let store: ReturnType<ContractStoreFactory>
    /** 让每个用例落在独立的 cwd 下，避免互相污染（文件实现按 cwd 分目录）。 */
    let scope = 0
    const nextCwd = (): string =>
      `/contract/${name}/${process.pid}-${Date.now()}-${(scope += 1)}`

    beforeEach(async () => {
      store = makeStore()
      const maybeReset = store.reset
      if (typeof maybeReset === 'function') await maybeReset()
    })

    // ─────────── 基本往返 ───────────

    it('round-trips messages，且排除 system prompt', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(3))
      const loaded = await store.load(cwd, 's1')

      assert.ok(loaded)
      // 3 轮 × 2 条 = 6；system 被 `slice(1)` 跳过
      assert.equal(loaded.length, 6)
      assert.equal(loaded[0].role, 'user')
      assert.equal(loaded[0].content, 'U0')
      assert.equal(loaded[5].role, 'assistant')
      assert.equal(loaded[5].content, 'A2')
    })

    it('不存在的会话 → load 返回 null（不抛）', async () => {
      assert.equal(await store.load(nextCwd(), 'nope'), null)
    })

    it('【关键】重复 save 同一批消息幂等 —— 不产生重复行', async () => {
      const cwd = nextCwd()
      const messages = makeConversation(2)
      await store.save(cwd, 's1', messages)
      await store.save(cwd, 's1', messages)
      await store.save(cwd, 's1', messages)

      const loaded = await store.load(cwd, 's1')
      assert.equal(loaded?.length, 4, '重复保存必须靠 message.id 去重')
    })

    it('追加新消息：只落增量，总数为累计值', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(2))
      await store.save(cwd, 's1', [
        { role: 'system', content: 'x' },
        { role: 'user', content: 'U2' },
        { role: 'assistant', content: 'A2' },
      ])
      const loaded = await store.load(cwd, 's1')
      assert.equal(loaded?.length, 6)
      assert.equal(loaded?.[5].content, 'A2')
    })

    // ─────────── 删除 ───────────

    it('clear 删除已有会话；对不存在的会话不抛', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      assert.ok(await store.load(cwd, 's1'))

      await store.clear(cwd, 's1')
      assert.equal(await store.load(cwd, 's1'), null)

      // 幂等：清一个没有的会话不该炸
      await store.clear(cwd, 'never-existed')
    })

    it('clear 只删指定会话，不影响同 cwd 下的其他会话', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 'keep', makeConversation(1))
      await store.save(cwd, 'drop', makeConversation(1))
      await store.clear(cwd, 'drop')

      assert.ok(await store.load(cwd, 'keep'), 'keep 必须还在')
      assert.equal(await store.load(cwd, 'drop'), null)
    })

    // ─────────── 标题与列举 ───────────

    it('list：标题默认取首条 user 消息（截断）', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      const sessions = await store.list(cwd)

      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].id, 's1')
      assert.equal(sessions[0].title, 'U0')
      assert.ok(sessions[0].updatedAt > 0)
    })

    it('rename：改会话标题，list 立即反映', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      assert.equal(await store.rename(cwd, 's1', '订单故障复盘'), true)

      const sessions = await store.list(cwd)
      assert.equal(sessions.find(s => s.id === 's1')?.title, '订单故障复盘')
    })

    it('rename 不存在的会话 → false', async () => {
      assert.equal(await store.rename(nextCwd(), 'nope', 'x'), false)
    })

    it('list 空目录 → 空数组（不抛）', async () => {
      assert.deepEqual(await store.list(nextCwd()), [])
    })

    it('list 只返回该 cwd 下的会话（sessionId 相同但 cwd 不同互不干扰）', async () => {
      const a = nextCwd()
      const b = nextCwd()
      await store.save(a, 'same-id', makeConversation(1))
      await store.save(b, 'same-id', makeConversation(2))

      const listA = await store.list(a)
      const listB = await store.list(b)
      assert.equal(listA.length, 1, 'A 只有自己的')
      assert.equal(listB.length, 1, 'B 只有自己的')
      // 同 id 不同 cwd 的内容必须各自独立
      assert.equal((await store.load(a, 'same-id'))?.length, 2)
      assert.equal((await store.load(b, 'same-id'))?.length, 4)
    })

    it('fork：派生出独立副本，标题带 _forkN', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 'src', makeConversation(2))
      const newId = await store.fork(cwd, 'src')

      assert.ok(newId, '必须返回新 sessionId')
      assert.notEqual(newId, 'src')
      // 副本内容与原会话一致（3 条非 system 消息里的？这里 2 轮 = 4 条）
      assert.equal((await store.load(cwd, newId!))?.length, 4)

      const sessions = await store.list(cwd)
      const forked = sessions.find(s => s.id === newId)
      assert.equal(forked?.title, 'U0_fork1', '首个 fork 编号从 1 开始')
    })

    it('fork 不存在的会话 → null', async () => {
      assert.equal(await store.fork(nextCwd(), 'nope'), null)
    })

    // ─────────── compact boundary（历史截断） ───────────

    it('【关键】load 只返回最后一个 compact_boundary 之后的消息', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(3)) // U0 A0 U1 A1 U2 A2

      await store.appendCompactBoundary(cwd, 's1', '前情摘要', 'manual', 900, 300, [
        { role: 'user', content: 'AFTER1' } as ChatMessage,
        { role: 'assistant', content: 'AFTER2' } as ChatMessage,
      ])

      const loaded = await store.load(cwd, 's1')
      const contents = loaded?.map(m => m.content) ?? []
      // boundary 之前的 U0..A2 全部被截掉，只剩摘要 + 保留消息
      assert.ok(!contents.includes('U0'), '旧历史必须被 compact boundary 截断')
      assert.ok(!contents.includes('A2'))
      assert.equal(contents[0], '前情摘要', '摘要作为第一条 user 出现')
      assert.deepEqual(contents.slice(1), ['AFTER1', 'AFTER2'])
    })

    // ─────────── snip 边界（插回原位） ───────────

    it('【关键】snip_boundary 按被删消息原位插回', async () => {
      const cwd = nextCwd()
      // 先存三条并拿到它们的 id（save 会就地补 id）
      const msgs: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'keep-first' },
        { role: 'user', content: 'to-be-removed' },
        { role: 'assistant', content: 'keep-last' },
      ]
      await store.save(cwd, 's1', msgs)
      const loadedBefore = await store.load(cwd, 's1')
      const removedId = loadedBefore![1].id! // 'to-be-removed'

      await store.appendSnipBoundary(cwd, 's1', {
        role: 'snip_boundary',
        content: '',
        removedMessageIds: [removedId],
        removedCount: 1,
        tokensFreed: 42,
      } as ChatMessage)

      const after = await store.load(cwd, 's1')
      const contents = after?.map(m => m.content) ?? []
      assert.ok(!contents.includes('to-be-removed'), '被删消息不再出现')
      // 关键：snip 标记要出现在「被删消息的原始位置」（第 2 位），而不是末尾
      assert.equal(contents.indexOf('keep-first'), 0)
      assert.equal(contents.indexOf('keep-last'), 2)
    })

    // ─────────── context collapse ───────────

    it('loadContextCollapseState：只计 committed span', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      await store.appendContextCollapseSpan(cwd, 's1', span('c1', 'committed'))
      await store.appendContextCollapseSpan(cwd, 's1', span('c2', 'staged'))
      await store.appendContextCollapseSpan(cwd, 's1', span('c3', 'committed'))

      const state = await store.loadContextCollapseState(cwd, 's1')
      assert.ok(state)
      assert.deepEqual(state.spans.map(s => s.id), ['c1', 'c3'], 'staged 不计入')
    })

    it('loadContextCollapseState：compact 后旧 span 被清零', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      await store.appendContextCollapseSpan(cwd, 's1', span('old', 'committed'))

      await store.appendCompactBoundary(cwd, 's1', '摘要', 'manual', 10, 5, [])
      // boundary 之前的 old span 不再有效
      assert.equal(await store.loadContextCollapseState(cwd, 's1'), null)
    })

    it('loadContextCollapseState：无 span 的会话 → null', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      assert.equal(await store.loadContextCollapseState(cwd, 's1'), null)
    })

    // ─────────── transcript ───────────

    it('loadTranscript：按事件类型还原成可回显条目', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      const entries = await store.loadTranscript(cwd, 's1')

      assert.ok(entries)
      assert.equal(entries.length, 2)
      assert.deepEqual(
        entries.map(e => e.kind),
        ['user', 'assistant'],
      )
      assert.equal(entries[0].body, 'U0')
    })

    it('loadTranscript：不存在的会话 → null', async () => {
      assert.equal(await store.loadTranscript(nextCwd(), 'nope'), null)
    })

    // ─────────── 过期清理 ───────────

    it('cleanupExpired：删掉过期会话并计数', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 'old', makeConversation(1))
      await store.save(cwd, 'new', makeConversation(1))

      // 必须等真实时间往前走一点：两实现的判定都是**严格小于**
      //（file: `now - mtime > maxAgeMs`；pg: `MAX(created_at) < cutoff`），
      // 若会话与判定发生在同一毫秒，`maxAgeMs=0` 时 `0 > 0` 为假 → 不被删。
      // 这是**被测实现的既有语义**，不是 bug —— 但测试必须避开这个退化边界，
      // 否则结果取决于机器调度快慢，变成 flaky。
      await sleep(15)

      const removed = await store.cleanupExpired(cwd, 0)
      assert.equal(removed, 2, '两条都过期')
      assert.deepEqual(await store.list(cwd), [])
    })

    it('cleanupExpired：无会话 → 0', async () => {
      assert.equal(await store.cleanupExpired(nextCwd(), 0), 0)
    })

    // ─────────── 项目列举 ───────────

    it('listProjects：列出所有含会话的项目', async () => {
      const cwd = nextCwd()
      await store.save(cwd, 's1', makeConversation(1))
      const projects = await store.listProjects()

      assert.ok(projects.length > 0)
      const found = projects.find(p => p.dir === cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, ''))
      assert.ok(found, '本 cwd 对应的项目必须出现')
      assert.ok(found.sessionCount >= 1)
    })
  })
}
