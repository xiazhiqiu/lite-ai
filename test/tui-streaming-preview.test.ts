import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STREAMING_CURSOR,
  appendStreamingPreview,
  createStreamingPreviewState,
  dropStreamingPreview,
  sealStreamingPreviewAsProgress,
} from '../src/tty-app.ts'

function makeState() {
  return {
    transcript: [],
    nextEntryId: 1,
    transcriptScrollOffset: 0,
  } as any
}

describe('streaming preview', () => {
  it('首个增量创建 assistant 预览条目，正文带光标', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()

    appendStreamingPreview(state, streaming, '你好')

    assert.equal(state.transcript.length, 1)
    assert.equal(state.transcript[0].kind, 'assistant')
    assert.equal(state.transcript[0].body, `你好${STREAMING_CURSOR}`)
    assert.equal(streaming.entryId, state.transcript[0].id)
    assert.equal(streaming.text, '你好')
  })

  it('后续增量原地更新同一条目，不新增条目', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()

    appendStreamingPreview(state, streaming, '第一段')
    const entryId = streaming.entryId
    appendStreamingPreview(state, streaming, '第二段')

    assert.equal(state.transcript.length, 1)
    assert.equal(streaming.entryId, entryId)
    assert.equal(
      state.transcript[0].body,
      `第一段第二段${STREAMING_CURSOR}`,
    )
  })

  it('空增量不创建条目也不改状态', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()

    appendStreamingPreview(state, streaming, '')

    assert.equal(state.transcript.length, 0)
    assert.equal(streaming.entryId, null)
    assert.equal(streaming.text, '')
  })

  it('drop 移除预览条目并清零状态，重复 drop 幂等', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()
    appendStreamingPreview(state, streaming, '会被终稿替换')
    // 模拟随后推入的权威终稿条目
    state.transcript.push({ id: 999, kind: 'assistant', body: '终稿' })

    dropStreamingPreview(state, streaming)
    dropStreamingPreview(state, streaming)

    assert.equal(state.transcript.length, 1)
    assert.equal(state.transcript[0].id, 999)
    assert.equal(streaming.entryId, null)
    assert.equal(streaming.text, '')
  })

  it('seal 把旁白转成 progress 条目（无光标），流式状态清零', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()
    appendStreamingPreview(state, streaming, '我先看看日志')

    sealStreamingPreviewAsProgress(state, streaming)

    assert.equal(state.transcript.length, 1)
    assert.equal(state.transcript[0].kind, 'progress')
    assert.equal(state.transcript[0].body, '我先看看日志')
    assert.equal(streaming.entryId, null)
    assert.equal(streaming.text, '')
  })

  it('seal 空文本预览只清理不产条目', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()

    sealStreamingPreviewAsProgress(state, streaming)

    assert.equal(state.transcript.length, 0)
    assert.equal(streaming.entryId, null)
  })

  it('未开始的预览 drop/seal 均为安全空操作', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()

    dropStreamingPreview(state, streaming)
    sealStreamingPreviewAsProgress(state, streaming)

    assert.equal(state.transcript.length, 0)
    assert.equal(streaming.entryId, null)
  })

  it('seal 后可再次流式（下一步旁白开新预览）', () => {
    const state = makeState()
    const streaming = createStreamingPreviewState()
    appendStreamingPreview(state, streaming, '第一步旁白')
    sealStreamingPreviewAsProgress(state, streaming)

    appendStreamingPreview(state, streaming, '第二步旁白')

    assert.equal(state.transcript.length, 2)
    assert.equal(state.transcript[1].kind, 'assistant')
    assert.equal(state.transcript[1].body, `第二步旁白${STREAMING_CURSOR}`)
  })
})
