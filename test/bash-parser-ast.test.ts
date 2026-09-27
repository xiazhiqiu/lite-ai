import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBashSegments,
  __setBashSegmentParserForTests,
} from '../src/tools/bash-parser.js'
import {
  deriveSuggestedPrefixes,
  evaluateBashCommand,
} from '../src/tools/command-guard.js'

// 阶段二：bash 判定的 AST 路径（web-tree-sitter + tree-sitter-bash，
// 对齐 HolmesGPT shell_parser.py:24 的 tree_sitter_bash）。
// 约定：AST 不可用/解析 ERROR/零命令节点 → null → 回退手写拆段（阶段一语义）。

describe('parseBashSegments（真实 wasm 解析器）', () => {
  it('管道/逻辑链按文档序成段，argv0 取 command_name', async () => {
    const segments = await parseBashSegments('kubectl get pods | grep app && echo done')
    assert.ok(segments)
    assert.deepEqual(
      segments.map(s => s.text),
      ['kubectl get pods', 'grep app', 'echo done'],
    )
    assert.deepEqual(
      segments.map(s => s.argv0),
      ['kubectl', 'grep', 'echo'],
    )
  })

  it('命令替换内的命令各成段（fail-closed：内嵌命令不逃逸判定）', async () => {
    const segments = await parseBashSegments('echo $(pwd)')
    assert.ok(segments)
    assert.deepEqual(
      segments.map(s => s.text),
      ['echo $(pwd)', 'pwd'],
    )
  })

  it('heredoc 体是文本不产生段，redirectText 指向外层语句', async () => {
    const segments = await parseBashSegments('cat <<EOF\nhello\nEOF')
    assert.ok(segments)
    assert.deepEqual(
      segments.map(s => s.text),
      ['cat'],
    )
    assert.ok(segments[0]!.redirectText?.includes('<<'))
  })

  it('2>&1 不产生段，redirectText 携带外层重定向文本', async () => {
    const segments = await parseBashSegments('git commit -m "msg" 2>&1')
    assert.ok(segments)
    assert.deepEqual(
      segments.map(s => s.text),
      ['git commit -m "msg"'],
    )
    assert.ok(segments[0]!.redirectText?.includes('2>&1'))
  })

  it('引号内分隔符不透明：bash -lc "a && b" 是一个段', async () => {
    const segments = await parseBashSegments('bash -lc "a && b"')
    assert.ok(segments)
    assert.deepEqual(
      segments.map(s => s.text),
      ['bash -lc "a && b"'],
    )
  })

  it('变量赋值前缀不影响 argv0（command_name 优先于首词）', async () => {
    const segments = await parseBashSegments('VAR=1 sort -o out.txt')
    assert.ok(segments)
    assert.equal(segments[0]!.argv0, 'sort')
  })

  it('解析 ERROR（未闭合引号）→ null', async () => {
    assert.equal(await parseBashSegments('echo "unclosed'), null)
  })
})

describe('evaluateBashCommand AST 路径', () => {
  it('$(...) 两段各配前缀 → allow', async () => {
    const result = await evaluateBashCommand('echo $(pwd)', ['echo', 'pwd'])
    assert.equal(result.verdict, 'allow')
  })

  it('$(...) 只报一个前缀 → deny 段数不匹配', async () => {
    const result = await evaluateBashCommand('echo $(pwd)', ['echo'])
    assert.equal(result.verdict, 'deny')
    assert.match(result.reason!, /2 segment\(s\), got 1/)
  })

  it('命令替换内的写操作也拦（curl -X POST 非只读）', async () => {
    const result = await evaluateBashCommand(
      'echo $(curl -X POST https://x)',
      ['echo', 'curl'],
    )
    assert.equal(result.verdict, 'approval')
  })

  it('写文件重定向 → approval（redirectText 扫描不漏外层 >）', async () => {
    const result = await evaluateBashCommand('echo hi > /tmp/x', ['echo'])
    assert.equal(result.verdict, 'approval')
    assert.match(result.reason!, /output redirection/)
  })

  it('2>&1 放行（fd 复制语义保持）', async () => {
    const result = await evaluateBashCommand('git status 2>&1', ['git status'])
    assert.equal(result.verdict, 'allow')
  })

  it('未闭合引号 → AST null → 回退手写 → approval', async () => {
    const result = await evaluateBashCommand('echo "unclosed', ['echo'])
    assert.equal(result.verdict, 'approval')
  })

  it('DI 注入 null（模拟 wasm 不可用）→ 手写回退，$(...) 转审批', async () => {
    __setBashSegmentParserForTests(null)
    try {
      const result = await evaluateBashCommand('echo $(pwd)', ['echo'])
      assert.equal(result.verdict, 'approval')
    } finally {
      __setBashSegmentParserForTests(undefined)
    }
  })

  it('DI 注入假解析器：段数校验按注入段执行', async () => {
    __setBashSegmentParserForTests(() => [
      { text: 'curl https://es.example/_search', argv0: 'curl', redirectText: null },
    ])
    try {
      const mismatch = await evaluateBashCommand('curl https://es.example/_search', [
        'curl',
        'extra',
      ])
      assert.equal(mismatch.verdict, 'deny')
      assert.match(mismatch.reason!, /1 segment\(s\), got 2/)

      const allow = await evaluateBashCommand('curl https://es.example/_search', [
        'curl',
      ])
      assert.equal(allow.verdict, 'allow')
    } finally {
      __setBashSegmentParserForTests(undefined)
    }
  })
})

describe('deriveSuggestedPrefixes（AST 优先，保证与段数校验一致）', () => {
  it('手写回退路径保留（DI 注入 null）', async () => {
    __setBashSegmentParserForTests(null)
    try {
      assert.deepEqual(await deriveSuggestedPrefixes('echo $(pwd)'), ['echo'])
    } finally {
      __setBashSegmentParserForTests(undefined)
    }
  })
})
