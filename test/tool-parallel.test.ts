import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '../src/types.js'
import {
  partitionToolCalls,
  mapWithConcurrency,
  toolConcurrencyLimit,
  DEFAULT_TOOL_CONCURRENCY_LIMIT,
} from '../src/utils/tool-parallel.js'
import { isReadOnlyCommandCall } from '../src/tools/command-guard.js'
import {
  parseBashSegments,
  __setBashSegmentParserForTests,
} from '../src/tools/bash-parser.js'

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

test('isReadOnlyCommandCall: 白名单命令 safe', async () => {
  await ensureBashParserReady()
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

test('isReadOnlyCommandCall: 管道各段都在白名单 → safe', async () => {
  await ensureBashParserReady()
  assert.equal(isReadOnlyCommandCall({ command: 'ls | grep x' }), true)
})

test('isReadOnlyCommandCall: 重定向 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'cat a > b.txt' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'ls >> out.log' }), false)
})

test('isReadOnlyCommandCall: 后台符 unsafe（AST 之前单独扫描引号外裸 &）', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'ls &' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'tail -f log &' }), false)
})

test('isReadOnlyCommandCall: git 只读子命令 safe，写子命令 unsafe', async () => {
  await ensureBashParserReady()
  assert.equal(isReadOnlyCommandCall({ command: 'git status' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'git diff' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'git push' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'git checkout main' }), false)
})

test('isReadOnlyCommandCall: 空命令 unsafe', () => {
  assert.equal(isReadOnlyCommandCall({ command: '   ' }), false)
})

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms) })

test('mapWithConcurrency: 输出按输入下标保序', async () => {
  const order = [30, 10, 20]
  const out = await mapWithConcurrency(order, 3, async ms => {
    await sleep(ms)
    return ms
  })
  assert.deepEqual(out, [30, 10, 20])
})

test('mapWithConcurrency: 同时在飞数不超过 limit', async () => {
  let running = 0
  let maxRunning = 0
  const items = Array.from({ length: 9 }, (_, i) => i)
  const out = await mapWithConcurrency(items, 3, async i => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    await sleep(5)
    running -= 1
    return i * 2
  })
  assert.equal(maxRunning, 3)
  assert.deepEqual(out, items.map(i => i * 2))
})

test('mapWithConcurrency: 空数组直接 resolve', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), [])
})

test('mapWithConcurrency: 首个 reject 立刻外抛', async () => {
  await assert.rejects(
    () =>
      mapWithConcurrency([1, 2, 3], 2, async i => {
        await sleep(i === 2 ? 1 : 20)
        if (i === 2) throw new Error('boom')
        return i
      }),
    /boom/,
  )
})

test('toolConcurrencyLimit: 非法值回退默认', () => {
  const saved = process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT
  try {
    delete process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT
    assert.equal(toolConcurrencyLimit(), DEFAULT_TOOL_CONCURRENCY_LIMIT)
    process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT = '0'
    assert.equal(toolConcurrencyLimit(), DEFAULT_TOOL_CONCURRENCY_LIMIT)
    process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT = 'abc'
    assert.equal(toolConcurrencyLimit(), DEFAULT_TOOL_CONCURRENCY_LIMIT)
    process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT = '4'
    assert.equal(toolConcurrencyLimit(), 4)
  } finally {
    if (saved === undefined) delete process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT
    else process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT = saved
  }
})

// ---------------------------------------------------------------------------
// isReadOnlyCommandCall AST 判定：tree-sitter 段提取，$(...) 内嵌各成段后
// 逐段判定（白名单 + 重定向扫描 + 危险原语），替代「见危险符整体拒」。
// ---------------------------------------------------------------------------

/** 确保 tree-sitter 解析器就绪，使同步快照路径（parseBashSegmentsSync）生效。 */
async function ensureBashParserReady(): Promise<void> {
  await parseBashSegments('true')
}

test('isReadOnlyCommandCall: AST——命令替换内嵌各成段，白名单内嵌放行', async () => {
  await ensureBashParserReady()
  // 升级核心收益：内嵌 pwd 是白名单只读段 → 整体放行（原正则路径见 $( 一律拒）
  assert.equal(isReadOnlyCommandCall({ command: 'echo $(pwd)' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'cat $(ls /etc) | grep x' }), true)
})

test('isReadOnlyCommandCall: AST——内嵌非白名单命令仍拒（fail-closed）', async () => {
  await ensureBashParserReady()
  assert.equal(isReadOnlyCommandCall({ command: 'echo $(rm -rf /tmp/x)' }), false)
  // 内嵌段自身带写重定向 → 拒
  assert.equal(
    isReadOnlyCommandCall({ command: 'echo $(cat /etc/hostname > /tmp/out)' }),
    false,
  )
})

test('isReadOnlyCommandCall: AST——2>&1 fd 复制与良性目标放行', async () => {
  await ensureBashParserReady()
  assert.equal(isReadOnlyCommandCall({ command: 'kubectl get pods 2>&1' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'ls 2>/dev/null' }), true)
})

test('isReadOnlyCommandCall: AST——find 写原语堵漏（-delete 不可并行）', async () => {
  await ensureBashParserReady()
  // 现状漏洞：find 在白名单、无危险符号，`find . -delete` 会被判可并行；
  // AST 路径段级跑 findDangerousArgvPrimitive 堵上。
  assert.equal(isReadOnlyCommandCall({ command: 'find . -name x -delete' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'find . -name x' }), true)
})

test('isReadOnlyCommandCall: AST——rg --pre 执行原语不可并行，--pre-glob 不误伤', async () => {
  await ensureBashParserReady()
  // rg 在白名单，但 --pre 会对每个文件执行外部程序 → 不可并行；
  // --pre-glob 只是文件名过滤 glob，保持只读可并行。
  assert.equal(isReadOnlyCommandCall({ command: 'rg --pre gunzip pattern' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'rg --pre=gunzip pattern' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'rg --pre-glob "*.gz" pattern' }), true)
})

test('isReadOnlyCommandCall: AST——git/SRE/白名单语义不变', async () => {
  await ensureBashParserReady()
  assert.equal(isReadOnlyCommandCall({ command: 'git status' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'git push' }), false)
  assert.equal(isReadOnlyCommandCall({ command: 'kubectl get pods' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'python x.py' }), false)
})

test('isReadOnlyCommandCall: AST——env/date 参数级堵漏', async () => {
  await ensureBashParserReady()
  // env 可执行任意命令：仅全 NAME=value 赋值（含裸 env）只读
  assert.equal(isReadOnlyCommandCall({ command: 'env' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'env FOO=bar' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'env rm -rf /tmp/x' }), false)
  // GNU date -s 修改系统时钟
  assert.equal(isReadOnlyCommandCall({ command: 'date' }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'date -s "2026-01-01"' }), false)
})

test('isReadOnlyCommandCall: 解析器不可用 → 一律 fail-closed false（无手写回退）', () => {
  __setBashSegmentParserForTests(null)
  try {
    // AST 是唯一判定路径；解析器不可用（wasm 缺失 / 加载中）时不再回退手写拆段，
    // 而是直接 fail-closed：连 ls -la 这类简单只读命令也判不可并行 / 不可放行。
    assert.equal(isReadOnlyCommandCall({ command: 'echo $(pwd)' }), false)
    assert.equal(isReadOnlyCommandCall({ command: 'ls -la' }), false)
    assert.equal(isReadOnlyCommandCall({ command: 'cat a > b.txt' }), false)
    assert.equal(isReadOnlyCommandCall({ command: 'kubectl get pods' }), false)
  } finally {
    __setBashSegmentParserForTests(undefined)
  }
})

test('isReadOnlyCommandCall: 注入 AST 段——重定向/危险原语单元级验证', () => {
  __setBashSegmentParserForTests(() => [
    { text: 'cat a', argv0: 'cat', redirectText: 'cat a > /etc/passwd' },
  ])
  try {
    assert.equal(isReadOnlyCommandCall({ command: 'cat a > /etc/passwd' }), false)
  } finally {
    __setBashSegmentParserForTests(undefined)
  }

  __setBashSegmentParserForTests(() => [
    { text: 'find . -delete', argv0: 'find', redirectText: null },
  ])
  try {
    assert.equal(isReadOnlyCommandCall({ command: 'find . -delete' }), false)
  } finally {
    __setBashSegmentParserForTests(undefined)
  }

  __setBashSegmentParserForTests(() => [
    { text: 'echo hi', argv0: 'echo', redirectText: 'echo hi 2>&1' },
  ])
  try {
    assert.equal(isReadOnlyCommandCall({ command: 'echo hi 2>&1' }), true)
  } finally {
    __setBashSegmentParserForTests(undefined)
  }
})