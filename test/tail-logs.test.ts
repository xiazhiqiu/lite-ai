import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'

let tempRoot: string

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-tail-'))
})

after(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  // follow 会话状态是模块级的，每个用例前清空，避免相互干扰
  const { resetFollowSessions } = await import('../src/tools/tail-logs.js')
  resetFollowSessions()
})

async function registry() {
  const { tailLogsTool, followLogsTool, stopFollowTool } = await import(
    '../src/tools/tail-logs.js'
  )
  return new ToolRegistry([tailLogsTool, followLogsTool, stopFollowTool])
}

async function writeLogFile(name: string, content: string): Promise<string> {
  const p = path.join(tempRoot, name)
  await writeFile(p, content, 'utf8')
  return p
}

function extractSessionId(output: string): string {
  const m = /Follow session created: (fl_[a-z0-9_]+)/.exec(output)
  assert.ok(m, `expected session id in output: ${output}`)
  return m[1]!
}

// --- tail_logs ---

test('tail_logs: 返回文件末尾 N 行', async () => {
  const tools = await registry()
  const file = await writeLogFile(
    'tail-1.log',
    Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n',
  )
  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: file }, lines: 5 },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, true)
  assert.equal(
    result.output,
    'line-45\nline-46\nline-47\nline-48\nline-49',
  )
})

test('tail_logs: 文件行数少于 N 时返回全部', async () => {
  const tools = await registry()
  const file = await writeLogFile('tail-2.log', 'a\nb\n')
  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: file }, lines: 100 },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, true)
  assert.equal(result.output, 'a\nb')
})

test('tail_logs: 空文件返回 (empty log)', async () => {
  const tools = await registry()
  const file = await writeLogFile('tail-empty.log', '')
  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: file } },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, true)
  assert.equal(result.output, '(empty log)')
})

test('tail_logs: 文件不存在返回错误', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'tail_logs',
    {
      source: { type: 'file', path: path.join(tempRoot, 'no-such.log') },
    },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /not found/i)
})

test('tail_logs: 不指定 lines 用默认值 100', async () => {
  const tools = await registry()
  const file = await writeLogFile(
    'tail-default.log',
    Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n') + '\n',
  )
  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: file } },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, true)
  const lines = result.output.split('\n')
  assert.equal(lines.length, 100)
  assert.equal(lines[0], 'l50')
  assert.equal(lines[99], 'l149')
})

test('tail_logs: 非法 source 被 schema 拒绝', async () => {
  const tools = await registry()
  // 缺 type
  const r1 = await tools.execute(
    'tail_logs',
    { source: { path: '/tmp/x' } },
    { cwd: tempRoot },
  )
  assert.equal(r1.ok, false)
  // 未知 type
  const r2 = await tools.execute(
    'tail_logs',
    { source: { type: 'syslog', path: '/tmp/x' } },
    { cwd: tempRoot },
  )
  assert.equal(r2.ok, false)
})

test('tail_logs: lines 超过上限被 schema 拒绝', async () => {
  const tools = await registry()
  const file = await writeLogFile('tail-max.log', 'x\n')
  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: file }, lines: 100_000 },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, false)
})

// --- follow_logs ---

test('follow_logs create: 创建会话并返回初始尾部 + session_id', async () => {
  const tools = await registry()
  const file = await writeLogFile(
    'follow-create.log',
    'a\nb\nc\nd\ne\n',
  )
  const result = await tools.execute(
    'follow_logs',
    { source: { type: 'file', path: file }, lines: 3 },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /Follow session created: fl_/)
  assert.match(result.output, /Initial tail \(3 lines\):/)
  assert.match(result.output, /c\nd\ne$/)
})

test('follow_logs poll: 文件增长后返回新行', async () => {
  const tools = await registry()
  const file = await writeLogFile('follow-grow.log', 'a\nb\nc\n')
  const create = await tools.execute(
    'follow_logs',
    { source: { type: 'file', path: file }, lines: 3 },
    { cwd: tempRoot },
  )
  const sid = extractSessionId(create.output)

  // 文件追加新行
  await writeFile(file, 'a\nb\nc\nd\ne\nf\n', 'utf8')

  const poll = await tools.execute(
    'follow_logs',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(poll.ok, true)
  assert.equal(poll.output, 'd\ne\nf')
})

test('follow_logs poll: 无新行返回提示', async () => {
  const tools = await registry()
  const file = await writeLogFile('follow-noop.log', 'a\nb\nc\n')
  const create = await tools.execute(
    'follow_logs',
    { source: { type: 'file', path: file }, lines: 3 },
    { cwd: tempRoot },
  )
  const sid = extractSessionId(create.output)

  const poll = await tools.execute(
    'follow_logs',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(poll.ok, true)
  assert.equal(poll.output, '(no new lines since last poll)')
})

test('follow_logs poll: 未知 session_id 报错', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'follow_logs',
    { session_id: 'fl_nonexistent' },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown follow session/)
})

test('follow_logs: 同时传 source 和 session_id 被 schema 拒绝', async () => {
  const tools = await registry()
  const file = await writeLogFile('follow-both.log', 'a\n')
  const result = await tools.execute(
    'follow_logs',
    {
      source: { type: 'file', path: file },
      session_id: 'fl_xxx',
    },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, false)
})

test('follow_logs: 都不传被 schema 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute('follow_logs', {}, { cwd: tempRoot })
  assert.equal(result.ok, false)
})

test('follow_logs poll: 多次轮询累计返回新行', async () => {
  const tools = await registry()
  const file = await writeLogFile('follow-multi.log', 'l1\nl2\n')
  const create = await tools.execute(
    'follow_logs',
    { source: { type: 'file', path: file }, lines: 2 },
    { cwd: tempRoot },
  )
  const sid = extractSessionId(create.output)

  await writeFile(file, 'l1\nl2\nl3\n', 'utf8')
  const p1 = await tools.execute(
    'follow_logs',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(p1.output, 'l3')

  await writeFile(file, 'l1\nl2\nl3\nl4\nl5\n', 'utf8')
  const p2 = await tools.execute(
    'follow_logs',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(p2.output, 'l4\nl5')
})

// --- stop_follow ---

test('stop_follow: 停止会话后 poll 失败', async () => {
  const tools = await registry()
  const file = await writeLogFile('stop.log', 'a\nb\n')
  const create = await tools.execute(
    'follow_logs',
    { source: { type: 'file', path: file }, lines: 2 },
    { cwd: tempRoot },
  )
  const sid = extractSessionId(create.output)

  const stop = await tools.execute(
    'stop_follow',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(stop.ok, true)
  assert.match(stop.output, /Follow session stopped/)

  const poll = await tools.execute(
    'follow_logs',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(poll.ok, false)
  assert.match(poll.output, /Unknown follow session/)
})

test('stop_follow: 未知 session_id 报错', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'stop_follow',
    { session_id: 'fl_ghost' },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown follow session/)
})
