import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocalToolShortcut } from '../src/local-tool-shortcuts.js'

describe('parseLocalToolShortcut', () => {
  it('parses /ls with an optional path', async () => {
    assert.deepEqual(await parseLocalToolShortcut('/ls'), {
      toolName: 'list_files',
      input: {},
    })
    assert.deepEqual(await parseLocalToolShortcut('/ls src'), {
      toolName: 'list_files',
      input: { path: 'src' },
    })
  })

  it('does not treat adjacent command text as an /ls path', async () => {
    assert.equal(await parseLocalToolShortcut('/lsfoo'), null)
  })

  it('rejects file edit shortcuts with blank paths', async () => {
    assert.equal(await parseLocalToolShortcut('/write ::content'), null)
    assert.equal(await parseLocalToolShortcut('/modify ::content'), null)
    assert.equal(await parseLocalToolShortcut('/edit   ::before::after'), null)
  })
})
