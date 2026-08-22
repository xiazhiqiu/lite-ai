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

test('tail_logs: 相对文件路径被拒绝（只允许绝对路径）', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: 'logs/app.log' } },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /must be absolute/)
})

test('tail_logs: kubectl pod/namespace 以 - 开头被拒绝（防 kubectl 标志注入）', async () => {
  const tools = await registry()
  for (const bad of ['--all-namespaces', '-o']) {
    const r = await tools.execute(
      'tail_logs',
      { source: { type: 'kubectl', namespace: 'sock-shop', pod: bad } },
      { cwd: tempRoot },
    )
    assert.equal(r.ok, false, `pod=${bad} 应被拒绝`)
    assert.match(r.output, /must not start with '-'/)
  }
  const r2 = await tools.execute(
    'tail_logs',
    { source: { type: 'kubectl', namespace: '-n', pod: 'payment' } },
    { cwd: tempRoot },
  )
  assert.equal(r2.ok, false)
  assert.match(r2.output, /must not start with '-'/)
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

// --- 边界场景补充 ---

test('tail_logs: 文件超过 MAX_FILE_TAIL_BYTES (10MB) 时只读尾部', async () => {
  const tools = await registry()
  // 构造一个 > 10MB 的文件：11MB 内容，每行约 100 字节
  // 末尾 5 行用唯一标记，验证截断后只返回尾部
  const marker = 'TAIL_MARKER_LINE_'
  const bigLine = 'x'.repeat(99) + '\n' // 100 字节/行
  const linesBeforeMarker = Math.floor((11 * 1024 * 1024) / 100) // ~11MB 行数
  const content =
    bigLine.repeat(linesBeforeMarker) +
    `${marker}1\n${marker}2\n${marker}3\n${marker}4\n${marker}5\n`
  const file = await writeLogFile('big.log', content)

  const result = await tools.execute(
    'tail_logs',
    { source: { type: 'file', path: file }, lines: 5 },
    { cwd: tempRoot },
  )
  assert.equal(result.ok, true)
  // 截断后第一行可能是被切断的 bigLine，但末尾 5 行标记必须在
  assert.match(result.output, new RegExp(`${marker}1.*${marker}5`, 's'))
  // 不应包含文件开头的 bigLine（被截断丢弃）
  const outLines = result.output.split('\n')
  assert.equal(outLines[outLines.length - 1], `${marker}5`)
  assert.equal(outLines[outLines.length - 5], `${marker}1`)
})

test('follow_logs poll: 日志轮转后 prev 末行不存在于 current，返回全部当前行', async () => {
  const tools = await registry()
  // 初始日志
  const file = await writeLogFile('rotate.log', 'old1\nold2\nold3\n')
  const create = await tools.execute(
    'follow_logs',
    { source: { type: 'file', path: file }, lines: 3 },
    { cwd: tempRoot },
  )
  const sid = extractSessionId(create.output)
  // 初始尾部是 old3，session 记住 old3

  // 日志轮转：完全覆盖为新内容，old3 不再存在
  await writeFile(file, 'new1\nnew2\nnew3\n', 'utf8')

  const poll = await tools.execute(
    'follow_logs',
    { session_id: sid },
    { cwd: tempRoot },
  )
  assert.equal(poll.ok, true)
  // diffNewLines 找不到 old3，返回全部当前行
  assert.equal(poll.output, 'new1\nnew2\nnew3')
})

// --- kubectl 数据源（通过 __hooks.kubectlExec mock） ---

test('tail_logs: kubectl source 拼接基础 args 并返回 stdout 行', async () => {
  const tools = await registry()
  const mod = await import('../src/tools/tail-logs.js')
  const original = mod.__hooks.kubectlExec
  let capturedArgs: string[] | null = null
  mod.__hooks.kubectlExec = async (args) => {
    capturedArgs = args
    return { stdout: 'log-line-1\nlog-line-2\nlog-line-3\n', stderr: '' }
  }
  try {
    const result = await tools.execute(
      'tail_logs',
      {
        source: {
          type: 'kubectl',
          namespace: 'sock-shop',
          pod: 'payment-abc123',
        },
        lines: 50,
      },
      { cwd: tempRoot },
    )
    assert.equal(result.ok, true)
    assert.equal(result.output, 'log-line-1\nlog-line-2\nlog-line-3')
    // 验证 args 拼接：无 container/previous
    assert.deepEqual(capturedArgs, [
      'logs',
      'payment-abc123',
      '-n',
      'sock-shop',
      '--tail',
      '50',
    ])
  } finally {
    mod.__hooks.kubectlExec = original
  }
})

test('tail_logs: kubectl source 含 container/previous 时拼接 -c 和 --previous', async () => {
  const tools = await registry()
  const mod = await import('../src/tools/tail-logs.js')
  const original = mod.__hooks.kubectlExec
  let capturedArgs: string[] | null = null
  mod.__hooks.kubectlExec = async (args) => {
    capturedArgs = args
    return { stdout: 'prev-log\n', stderr: '' }
  }
  try {
    const result = await tools.execute(
      'tail_logs',
      {
        source: {
          type: 'kubectl',
          namespace: 'sock-shop',
          pod: 'carts-xyz',
          container: 'carts',
          previous: true,
        },
      },
      { cwd: tempRoot },
    )
    assert.equal(result.ok, true)
    assert.equal(result.output, 'prev-log')
    // 验证 container/previous 选项
    assert.deepEqual(capturedArgs, [
      'logs',
      'carts-xyz',
      '-n',
      'sock-shop',
      '--tail',
      '100', // 默认值
      '-c',
      'carts',
      '--previous',
    ])
  } finally {
    mod.__hooks.kubectlExec = original
  }
})

test('tail_logs: kubectl ENOENT 时返回友好错误', async () => {
  const tools = await registry()
  const mod = await import('../src/tools/tail-logs.js')
  const original = mod.__hooks.kubectlExec
  mod.__hooks.kubectlExec = async () => {
    const err = new Error('spawn kubectl ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  try {
    const result = await tools.execute(
      'tail_logs',
      {
        source: {
          type: 'kubectl',
          namespace: 'sock-shop',
          pod: 'payment-abc',
        },
      },
      { cwd: tempRoot },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /kubectl not found on PATH/)
  } finally {
    mod.__hooks.kubectlExec = original
  }
})

test('tail_logs: kubectl 非零退出时返回 stderr 内容', async () => {
  const tools = await registry()
  const mod = await import('../src/tools/tail-logs.js')
  const original = mod.__hooks.kubectlExec
  mod.__hooks.kubectlExec = async () => {
    const err = new Error('kubectl exited 1') as NodeJS.ErrnoException & {
      stderr?: string
    }
    err.code = 1
    err.stderr = 'Error from server (NotFound): pods "ghost" not found'
    throw err
  }
  try {
    const result = await tools.execute(
      'tail_logs',
      {
        source: {
          type: 'kubectl',
          namespace: 'sock-shop',
          pod: 'ghost',
        },
      },
      { cwd: tempRoot },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /kubectl logs failed/)
    assert.match(result.output, /pods "ghost" not found/)
  } finally {
    mod.__hooks.kubectlExec = original
  }
})
