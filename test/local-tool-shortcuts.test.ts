import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocalToolShortcut } from '../src/local-tool-shortcuts.js'

describe('parseLocalToolShortcut', () => {
  it('parses /cmd with a command and args', () => {
    assert.deepEqual(parseLocalToolShortcut('/cmd ls -la'), {
      toolName: 'run_command',
      input: { command: 'ls', args: ['-la'], cwd: undefined },
    })
  })

  it('parses /cmd with an optional cwd', () => {
    assert.deepEqual(parseLocalToolShortcut('/cmd /tmp::ls'), {
      toolName: 'run_command',
      input: { command: 'ls', args: [], cwd: '/tmp' },
    })
  })

  it('returns null for empty command or non /cmd input', () => {
    assert.equal(parseLocalToolShortcut('/cmd '), null)
    assert.equal(parseLocalToolShortcut('/ls'), null)
    assert.equal(parseLocalToolShortcut('/read foo'), null)
    assert.equal(parseLocalToolShortcut('plain text'), null)
  })
})