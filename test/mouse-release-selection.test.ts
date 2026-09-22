import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TranscriptSelection } from '../src/tui/transcript.ts'

const renderModulePromise = import('../src/tui/app/render.ts')

describe('mouse release selection', () => {
  it('keeps the current selection after mouse release', async () => {
    const renderModule = await renderModulePromise
    const keepSelectionAfterMouseRelease =
      (renderModule as { keepSelectionAfterMouseRelease?: (selection: TranscriptSelection | null) => TranscriptSelection | null })
        .keepSelectionAfterMouseRelease

    assert.equal(typeof keepSelectionAfterMouseRelease, 'function')

    const selection: TranscriptSelection = {
      startLine: 6,
      startCol: 1,
      endLine: 14,
      endCol: 44,
    }

    assert.deepEqual(keepSelectionAfterMouseRelease!(selection), selection)
  })

  it('keeps null when there is no selection', async () => {
    const renderModule = await renderModulePromise
    const keepSelectionAfterMouseRelease =
      (renderModule as { keepSelectionAfterMouseRelease?: (selection: TranscriptSelection | null) => TranscriptSelection | null })
        .keepSelectionAfterMouseRelease

    assert.equal(typeof keepSelectionAfterMouseRelease, 'function')
    assert.equal(keepSelectionAfterMouseRelease!(null), null)
  })
})
