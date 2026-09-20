/**
 * SessionStore 契约测试（T1）。
 *
 * 目的：验证存储抽象层的**契约**与现有 `session.ts` 自由函数行为一致。
 * 这层测试是 T8（PG 实现）的验收基准——任何实现都必须通过同一组契约。
 *
 * ⚠️ **隔离要求（重要）**：`config.ts:180` 的 `LITE_AI_DIR` / `LITE_AI_PROJECTS_DIR`
 * 是**模块加载时**从 `LITE_AI_HOME` 环境变量派生的常量。若本文件不设 `LITE_AI_HOME`，
 * 就会与 `session.test.ts` 共用同一个 `~/.lite-ai/projects/`，而两者都在 afterEach
 * 里 `rm -rf` 它 —— node:test 并行跑文件时**互相删对方的数据**，表现为
 * `session persistence > clears an existing session` 之类随机失败。
 *
 * 因此本文件在 import `src/**` **之前**先把 `LITE_AI_HOME` 指向专属临时目录。
 * ESM 的 import 会被提升，所以这里用**动态 import**（`await import(...)`）达成
 * "先设环境变量、再加载模块"的顺序。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ChatMessage } from '../src/types.js'

/** 专属 HOME：与 `session.test.ts` 的共享目录彻底隔开。 */
const ISOLATED_HOME = path.join(os.tmpdir(), 'lite-ai-session-store-home')
process.env.LITE_AI_HOME = ISOLATED_HOME

// 环境变量设好之后再加载被测模块（动态 import 不会被提升）
const { createFileSessionStore } = await import('../src/session/file-store.js')
const { LITE_AI_PROJECTS_DIR } = await import('../src/config.js')

// 自检：确认隔离真的生效（若被改成静态 import，这里会指向 ~/.lite-ai 而失败）
if (!LITE_AI_PROJECTS_DIR.startsWith(ISOLATED_HOME)) {
  throw new Error(
    `测试隔离失效：LITE_AI_PROJECTS_DIR=${LITE_AI_PROJECTS_DIR} 不在 ${ISOLATED_HOME} 内`,
  )
}

const testDir = path.join(os.tmpdir(), 'lite-ai-session-store-test')

function makeMessages(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: `User message ${i}` })
    messages.push({ role: 'assistant', content: `Assistant response ${i}` })
  }
  return messages
}

function projectDirName(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

describe('SessionStore contract (file implementation)', () => {
  const store = createFileSessionStore()

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    // afterEach 会把隔离 HOME 整个删掉，这里每次重建
    await mkdir(path.join(ISOLATED_HOME, 'projects'), { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
    // 只清自己的隔离 HOME —— 绝不碰 ~/.lite-ai（那是 session.test.ts 的地盘）
    try { await rm(ISOLATED_HOME, { recursive: true, force: true }) } catch {}
  })

  it('save then load round-trips messages and drops the system prompt', async () => {
    const cwd = path.join(testDir, 'store-a')
    await store.save(cwd, 'store001', makeMessages(2))

    const loaded = await store.load(cwd, 'store001')
    assert.notEqual(loaded, null)
    assert.equal(loaded!.length, 4)
    assert.equal(loaded![0].role, 'user')
    assert.equal(loaded![0].content, 'User message 0')
  })

  it('load returns null for a nonexistent session', async () => {
    const cwd = path.join(testDir, 'store-missing')
    assert.equal(await store.load(cwd, 'nonexistent'), null)
  })

  it('save rejects path-traversal session ids', async () => {
    const cwd = path.join(testDir, 'store-traversal')
    const messages = makeMessages(1)
    for (const badId of ['../../evil', 'a/b', '..', '.', 'a\\b']) {
      await assert.rejects(() => store.save(cwd, badId, messages), /invalid session id/)
      assert.equal(await store.load(cwd, badId), null)
    }
  })

  it('save is append-only: re-saving the same messages does not duplicate lines', async () => {
    const cwd = path.join(testDir, 'store-append')
    const messages = makeMessages(1)
    await store.save(cwd, 'append001', messages)
    await store.save(cwd, 'append001', messages)

    const filePath = path.join(LITE_AI_PROJECTS_DIR, projectDirName(cwd), 'append001.jsonl')
    const content = await readFile(filePath, 'utf8')
    assert.equal(content.trim().split('\n').filter(Boolean).length, 2)
  })

  it('clear removes a session and is a no-op for missing ones', async () => {
    const cwd = path.join(testDir, 'store-clear')
    await store.save(cwd, 'clear001', makeMessages(1))
    await store.clear(cwd, 'clear001')
    assert.equal(await store.load(cwd, 'clear001'), null)
    await assert.doesNotReject(() => store.clear(cwd, 'never-existed'))
  })

  it('list returns sessions sorted by updatedAt descending', async () => {
    const cwd = path.join(testDir, 'store-list')
    await store.save(cwd, 'old00001', makeMessages(1))
    await new Promise(r => setTimeout(r, 5))
    await store.save(cwd, 'new00001', makeMessages(2))

    const sessions = await store.list(cwd)
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0]!.id, 'new00001')
    assert.equal(sessions[1]!.id, 'old00001')
  })

  it('list is scoped to the given cwd and returns [] when empty', async () => {
    const cwdA = path.join(testDir, 'store-scope-a')
    const cwdB = path.join(testDir, 'store-scope-b')
    await store.save(cwdA, 'onlyA001', makeMessages(1))

    assert.equal((await store.list(cwdB)).length, 0)
    const listA = await store.list(cwdA)
    assert.equal(listA.length, 1)
    assert.equal(listA[0]!.id, 'onlyA001')
  })

  it('rename updates the title and returns false when the session is missing', async () => {
    const cwd = path.join(testDir, 'store-rename')
    await store.save(cwd, 'rename001', makeMessages(1))

    assert.equal(await store.rename(cwd, 'rename001', 'Custom Title'), true)
    const sessions = await store.list(cwd)
    assert.equal(sessions[0]!.title, 'Custom Title')

    assert.equal(await store.rename(cwd, 'missing001', 'Nope'), false)
  })

  it('fork produces an independent session and returns null for a missing source', async () => {
    const cwd = path.join(testDir, 'store-fork')
    await store.save(cwd, 'orig0001', makeMessages(2))

    const forkId = await store.fork(cwd, 'orig0001')
    assert.notEqual(forkId, null)
    assert.notEqual(forkId, 'orig0001')

    const forked = await store.load(cwd, forkId!)
    const original = await store.load(cwd, 'orig0001')
    assert.equal(forked!.length, original!.length)

    assert.equal(await store.fork(cwd, 'missing001'), null)
  })

  it('loadTranscript rebuilds entries and returns null when missing', async () => {
    const cwd = path.join(testDir, 'store-transcript')
    await store.save(cwd, 'tx000001', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'assistant_tool_call', toolUseId: 't1', toolName: 'read_file', input: { path: '/a.ts' } },
      { role: 'tool_result', toolUseId: 't1', toolName: 'read_file', content: 'file', isError: false },
    ])

    const transcript = await store.loadTranscript(cwd, 'tx000001')
    assert.equal(transcript!.length, 3)
    assert.equal(transcript![0]!.kind, 'user')
    assert.equal(transcript![1]!.kind, 'assistant')
    assert.equal(transcript![2]!.kind, 'tool')

    assert.equal(await store.loadTranscript(cwd, 'missing001'), null)
  })

  it('cleanupExpired removes only sessions older than the cutoff', async () => {
    const cwd = path.join(testDir, 'store-expiry')
    await store.save(cwd, 'recent001', makeMessages(1))
    await store.save(cwd, 'old000001', makeMessages(1))

    const { utimes } = await import('node:fs/promises')
    const oldPath = path.join(LITE_AI_PROJECTS_DIR, projectDirName(cwd), 'old000001.jsonl')
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000
    await utimes(oldPath, new Date(oldTime), new Date(oldTime))

    const removed = await store.cleanupExpired(cwd, 30 * 24 * 60 * 60 * 1000)
    assert.equal(removed, 1)
    assert.notEqual(await store.load(cwd, 'recent001'), null)
    assert.equal(await store.load(cwd, 'old000001'), null)
  })

  it('listProjects reports only projects that contain sessions', async () => {
    const cwdA = path.join(testDir, 'store-proj-a')
    await store.save(cwdA, 'proj0001', makeMessages(1))

    const projects = await store.listProjects()
    assert.ok(projects.length >= 1)
    const projA = projects.find(p => p.dir.includes('store-proj-a'))
    assert.equal(projA!.sessionCount, 1)
    for (const p of projects) assert.ok(p.sessionCount > 0)
  })
})
