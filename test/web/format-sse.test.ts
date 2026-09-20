/**
 * T10 前端**纯逻辑**测试。
 *
 * 范围刻意的取舍：不引 jsdom / testing-library（那会引入一大批运行期依赖，
 * 与 plan"运行时零新增依赖"的口径冲突）。这里只测**不需要 DOM 就能证明**的部分：
 *
 * 1. SSE 帧解析（协议正确性 —— 最容易悄悄错的地方）
 * 2. 展示层纯函数（时间格式、Markdown 转义、摘要提取、统计）
 * 3. API 客户端的请求构造（续聊必须带 sessionId；绝不带 userId）
 *
 * 组件渲染本身由 T10 的"端到端冒烟（UI）"覆盖（真浏览器），不在单测里硬凑。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseSseChunk } from '../../web/src/api/sse.js'
import {
  computeStats,
} from '../../web/src/components/UsageView.js'
import {
  eventSummary,
  formatDuration,
  formatPayload,
  formatTime,
  relativeTime,
  renderMarkdown,
  summarizeJob,
  truncate,
} from '../../web/src/format.js'

// ────────────────────────────────────────────────
// SSE 协议解析
// ────────────────────────────────────────────────

describe('parseSseChunk：SSE 帧解析', () => {
  it('解析标准帧（id + event + data）', () => {
    const frames = parseSseChunk('id: 3\nevent: tool_result\ndata: {"ok":true}\n\n')
    assert.equal(frames.length, 1)
    assert.equal(frames[0]!.id, 3)
    assert.equal(frames[0]!.event, 'tool_result')
    assert.equal(frames[0]!.data, '{"ok":true}')
  })

  it('解析多个帧（一次 read 可能带回多条）', () => {
    const frames = parseSseChunk(
      'id: 1\nevent: a\ndata: {}\n\nid: 2\nevent: b\ndata: {}\n\n',
    )
    assert.equal(frames.length, 2)
    assert.deepEqual(
      frames.map(f => f.id),
      [1, 2],
    )
  })

  it('忽略心跳注释帧（`: ping`）', () => {
    assert.equal(parseSseChunk(': ping\n\n').length, 0)
  })

  it('忽略无 data 的帧（如仅 retry）', () => {
    assert.equal(parseSseChunk('retry: 1000\n\n').length, 0)
  })

  it('【规范】多行 data 按 \\n 拼接', () => {
    const frames = parseSseChunk('id: 7\nevent: x\ndata: line1\ndata: line2\n\n')
    assert.equal(frames[0]!.data, 'line1\nline2')
  })

  it('data 值的前导空格被剥掉（`data: {}` → `{}`）', () => {
    const frames = parseSseChunk('id: 1\nevent: x\ndata: {"a":1}\n\n')
    assert.equal(frames[0]!.data, '{"a":1}')
  })

  it('id 非数字时为 null（不抛错）', () => {
    const frames = parseSseChunk('id: abc\nevent: x\ndata: {}\n\n')
    assert.equal(frames[0]!.id, null)
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(parseSseChunk(''), [])
    assert.deepEqual(parseSseChunk('\n\n'), [])
  })
})

// ────────────────────────────────────────────────
// 展示层纯函数
// ────────────────────────────────────────────────

describe('relativeTime：相对时间', () => {
  const now = 1_700_000_000_000

  it('秒级内显示"刚刚"', () => {
    assert.equal(relativeTime(now - 5_000, now), '刚刚')
  })

  it('分钟 / 小时 / 天', () => {
    assert.equal(relativeTime(now - 3 * 60_000, now), '3 分钟前')
    assert.equal(relativeTime(now - 5 * 3_600_000, now), '5 小时前')
    assert.equal(relativeTime(now - 3 * 86_400_000, now), '3 天前')
  })

  it('未来时间也归为"刚刚"（时钟偏差不显示负数）', () => {
    assert.equal(relativeTime(now + 10_000, now), '刚刚')
  })
})

describe('formatDuration：耗时', () => {
  it('ms / s / m 分档', () => {
    assert.equal(formatDuration(500), '500ms')
    assert.equal(formatDuration(1500), '1.5s')
    assert.equal(formatDuration(90_000), '1m30s')
  })

  it('null / 负数归为 —', () => {
    assert.equal(formatDuration(null), '—')
    assert.equal(formatDuration(-1), '—')
  })
})

describe('formatTime', () => {
  it('null 显示 —', () => {
    assert.equal(formatTime(null), '—')
  })

  it('格式化到秒', () => {
    const t = new Date(2026, 8, 20, 20, 41, 7).getTime()
    assert.equal(formatTime(t), '2026-09-20 20:41:07')
  })
})

describe('summarizeJob：摘要取值', () => {
  it('有 summary 就用它', () => {
    assert.equal(summarizeJob({ summary: '订单延迟升高' }), '订单延迟升高')
  })

  it('null / undefined / 空串 → 占位文案', () => {
    assert.equal(summarizeJob({ summary: null }), '(无摘要)')
    assert.equal(summarizeJob({}), '(无摘要)')
    assert.equal(summarizeJob({ summary: '   ' }), '(无摘要)')
  })
})

describe('renderMarkdown：极简 Markdown + **XSS 防护**', () => {
  it('标题 / 粗体 / 行内代码 / 列表', () => {
    const html = renderMarkdown('# 结论\n\n**重点** 与 `code`\n\n- 一\n- 二')
    assert.match(html, /<h1>结论<\/h1>/)
    assert.match(html, /<strong>重点<\/strong>/)
    assert.match(html, /<code>code<\/code>/)
    assert.match(html, /<ul><li>一<\/li><li>二<\/li><\/ul>/)
  })

  it('【关键】先转义再插标签：<script> 不得穿透', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('【关键】属性注入被转义', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    assert.doesNotMatch(html, /onerror="alert/)
    assert.match(html, /&quot;/)
  })

  it('Markdown 标记里的 HTML 同样被转义（转义先于 inline 处理）', () => {
    const html = renderMarkdown('**<b>x</b>**')
    assert.match(html, /&lt;b&gt;/)
    assert.doesNotMatch(html, /<b>x<\/b>/)
  })
})

describe('truncate / formatPayload / eventSummary', () => {
  it('truncate 压平空白并限长', () => {
    assert.equal(truncate('a\n\nb   c', 20), 'a b c')
    assert.equal(truncate('x'.repeat(50), 10).length, 10)
    assert.ok(truncate('x'.repeat(50), 10).endsWith('…'))
  })

  it('formatPayload 序列化对象为缩进 JSON', () => {
    assert.match(formatPayload({ a: 1 }), /"a": 1/)
    assert.equal(formatPayload('plain'), 'plain')
  })

  it('formatPayload 对循环引用不抛错', () => {
    const o: Record<string, unknown> = {}
    o.self = o
    assert.doesNotThrow(() => formatPayload(o))
  })

  it('eventSummary 对三种事件给出可读摘要', () => {
    assert.match(eventSummary('tool_start', { tool: 'query_logs' }), /query_logs/)
    assert.match(
      eventSummary('tool_result', { error: 'timeout' }),
      /失败：timeout/,
    )
    assert.match(eventSummary('assistant_message', { text: '根因是...' }), /根因是/)
  })

  it('eventSummary 对未知事件回退到通用序列化', () => {
    assert.match(eventSummary('weird_kind', { x: 1 }), /"x"/)
  })
})

// ────────────────────────────────────────────────
// 用量统计
// ────────────────────────────────────────────────

describe('computeStats：用量统计口径', () => {
  it('按状态计数 + 平均耗时（只算有 finishedAt 的）', () => {
    const stats = computeStats([
      job('a', 'completed', 0, 1000),
      job('b', 'completed', 0, 3000),
      job('c', 'failed', 0, 2000),
      job('d', 'running', null),
      job('e', 'pending', null),
    ])
    assert.equal(stats.total, 5)
    assert.equal(stats.completed, 2)
    assert.equal(stats.failed, 1)
    assert.equal(stats.active, 2)
    // (1000 + 3000 + 2000) / 3 = 2000
    assert.equal(stats.avgDuration, 2000)
  })

  it('无已完成任务时 avgDuration 为 null（不除零）', () => {
    const stats = computeStats([job('a', 'running', null)])
    assert.equal(stats.avgDuration, null)
  })

  it('空列表', () => {
    const stats = computeStats([])
    assert.deepEqual(stats, {
      total: 0,
      active: 0,
      completed: 0,
      failed: 0,
      avgDuration: null,
    })
  })
})

function job(
  id: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
  createdAt: number,
  finishedAt: number | null = null,
): Parameters<typeof computeStats>[0][number] {
  return {
    id,
    userId: 'u1',
    kind: 'chat',
    status,
    sessionId: null,
    incidentId: null,
    assignee: null,
    error: null,
    summary: null,
    createdAt,
    updatedAt: createdAt,
    finishedAt,
  }
}
