import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownish } from '../src/tui/markdown.ts'
import { isLogTool, detectLogLevel, renderLogBody } from '../src/tui/logs.ts'

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const BRIGHT_RED = '\u001b[91m'

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '')
}

describe('markdown table rendering', () => {
  it('aligns columns, boldens header, and dims separator', () => {
    const input = [
      '| Name | 时间 | Value |',
      '| :--- | :--: | ---: |',
      '| a    |  中  |   1  |',
      '| bb   | 长文 |  22  |',
    ].join('\n')

    const rawLines = renderMarkdownish(input).split('\n')
    const lines = rawLines.map(stripAnsi)

    assert.equal(lines.length, 4)

    // 表头加粗 + 青色
    assert.equal(rawLines[0]!.includes(CYAN + '\u001b[1m'), true)

    // 分隔线弱化（DIM）
    assert.equal(rawLines[1]!.includes(DIM), true)
    assert.equal(lines[1], '│---- │ ---- │ -----│')

    // 表头行
    assert.equal(lines[0], '│Name │ 时间 │ Value│')

    // 数据行左 / 中 / 右对齐（CJK 全角按宽 2 计）
    const row2 = lines[2]!.split('│')
    assert.equal(row2[1]!.trim(), 'a')
    assert.equal(row2[1]!.startsWith(' '), false) // 左对齐：无左填充
    assert.equal(row2[2]!.trim(), '中')
    assert.equal(row2[2]!.trimStart().length < row2[2]!.length, true) // 居中：两侧均有填充
    assert.equal(row2[2]!.trimEnd().length < row2[2]!.length, true)
    assert.equal(row2[3]!.trim(), '1')
    assert.equal(row2[3]!.startsWith(' '), true) // 右对齐：有左填充
    assert.equal(row2[3]!.endsWith(' '), false)

    const row3 = lines[3]!.split('│')
    assert.equal(row3[1]!.trim(), 'bb')
    assert.equal(row3[1]!.startsWith(' '), false)
    assert.equal(row3[2]!.trim(), '长文')
    assert.equal(row3[2]!.trimStart().length < row3[2]!.length, true)
    assert.equal(row3[3]!.trim(), '22')
    assert.equal(row3[3]!.startsWith(' '), true)
  })

  it('leaves non-table lines unchanged relative to fallback rendering', () => {
    const input = 'plain line\n> a quote\n- an item\n# Title\n'
    const out = stripAnsi(renderMarkdownish(input))
    assert.equal(out.split('\n')[0], 'plain line')
    assert.equal(out.split('\n')[1], '> a quote')
    assert.equal(out.split('\n')[2], '• an item')
    assert.equal(out.split('\n')[3], 'Title')
  })
})

describe('log rendering', () => {
  it('recognizes log tools', () => {
    assert.equal(isLogTool('tail_logs'), true)
    assert.equal(isLogTool('follow_logs'), true)
    assert.equal(isLogTool('read_file'), false)
  })

  it('detects log levels', () => {
    assert.equal(detectLogLevel('[ERROR] boom'), 'ERROR')
    assert.equal(detectLogLevel('level=error boom'), 'ERROR')
    assert.equal(detectLogLevel('WARNING: something'), 'WARN')
    assert.equal(detectLogLevel('2024-01-01T12:00:00Z INFO started'), 'INFO')
    assert.equal(detectLogLevel('plain text without level'), null)
  })

  it('colors level lines but leaves plain lines untouched', () => {
    const body = [
      '2024-01-01T12:00:00.000Z [ERROR] disk full',
      '2024-01-01T12:00:01.000Z INFO started',
      'nothing special here',
    ].join('\n')

    const out = renderLogBody(body)
    const lines = out.split('\n')

    assert.equal(lines[0]!.includes(BRIGHT_RED), true)
    assert.equal(lines[1]!.includes(CYAN), true)
    assert.equal(lines[2]!.includes(YELLOW), false)
    assert.equal(lines[2]!.includes(BRIGHT_RED), false)
    assert.equal(lines[2], 'nothing special here')
  })

  it('dims the ISO timestamp prefix', () => {
    const out = renderLogBody('2024-01-01T12:00:00Z something')
    assert.equal(out.includes(DIM), true)
    assert.equal(stripAnsi(out), '2024-01-01T12:00:00Z something')
  })
})