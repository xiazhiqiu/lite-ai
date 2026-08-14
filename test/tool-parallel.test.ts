import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '../src/types.js'
import { partitionToolCalls } from '../src/utils/tool-parallel.js'
import { isReadOnlyCommandCall } from '../src/tools/run-command.js'

function call(input: unknown, id = 'c'): ToolCall {
  return { id, toolName: 'x', input }
}

test('partitionToolCalls: 空数组返回空', () => {
  assert.deepEqual(partitionToolCalls([], () => true), [])
})

test('partitionToolCalls: 全读合成一个并行批', () => {
  const calls = [call({}, 'a'), call({}, 'b'), call({}, 'c')]
  const groups = partitionToolCalls(calls, () => true)
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.parallel, true)
  assert.equal(groups[0]!.calls.length, 3)
})

test('partitionToolCalls: 全写各成串行组', () => {
  const calls = [call({}, 'a'), call({}, 'b')]
  const groups = partitionToolCalls(calls, () => false)
  assert.equal(groups.length, 2)
  assert.ok(groups.every(g => g.parallel === false))
})

test('partitionToolCalls: 读写交错批序正确', () => {
  const calls = [
    call({ kind: 'read' }, 'r1'),
    call({ kind: 'read' }, 'r2'),
    call({ kind: 'write' }, 'e'),
    call({ kind: 'read' }, 'r3'),
  ]
  const groups = partitionToolCalls(
    calls,
    call => (call.input as { kind: string }).kind === 'read',
  )
  assert.deepEqual(
    groups.map(g => ({ parallel: g.parallel, ids: g.calls.map(c => c.id) })),
    [
      { parallel: true, ids: ['r1', 'r2'] },
      { parallel: false, ids: ['e'] },
      { parallel: true, ids: ['r3'] },
    ],
  )
})

test('partitionToolCalls: isSafe 抛异常 → 该调用串行（fail-closed）', () => {
  const calls = [call({}), call({}), call({})]
  const groups = partitionToolCalls(calls, () => {
    throw new Error('boom')
  })
  assert.equal(groups.length, 3)
  assert.ok(groups.every(g => g.parallel === false))
})

test('isReadOnlyCommandCall: 白名单命令 safe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'ls -la' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'cat a.txt' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'grep foo' }), true)
})

test('isReadOnlyCommandCall: 写命令 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'rm -rf build' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'python x.py' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'sed -i x file.txt' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'mkdir newdir' }), false)
})

test('isReadOnlyCommandCall: 管道各段都在白名单 → safe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'ls | grep x' }), true)
})

test('isReadOnlyCommandCall: 重定向 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'cat a > b.txt' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'ls >> out.log' }), false)
})

test('isReadOnlyCommandCall: 命令替换/后台 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'echo $(pwd)' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'ls &' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'tail -f log &' }), false)
})

test('isReadOnlyCommandCall: git 只读子命令 safe，写子命令 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'git status' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'git diff' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'git push' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'git checkout main' }), false)
})

test('isReadOnlyCommandCall: 带 args 数组', () => {
  assert.equal(
    isReadOnlyCommandCall({ command: 'git', args: ['status'] }),
    true,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'git', args: ['push'] }),
    false,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'ls', args: ['-la'] }),
    true,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'ls', args: ['-la', '>', 'out'] }),
    false,
  )
})

test('isReadOnlyCommandCall: 空命令 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: '   ' }), false)
})