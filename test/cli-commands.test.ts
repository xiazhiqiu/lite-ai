import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryHandleLocalCommand } from '../src/cli-commands.ts'
import { LITE_AI_PERMISSIONS_PATH } from '../src/config.ts'

describe('tryHandleLocalCommand', () => {
  it('prints full permission lists for /permissions', async () => {
    const result = await tryHandleLocalCommand('/permissions', {
      permissionSummary: [
        'cwd: /repo',
        'extra allowed dirs: /one, /two',
        'dangerous allowlist: git push, npm publish',
      ],
    })

    assert.equal(
      result,
      [
        `permission store: ${LITE_AI_PERMISSIONS_PATH}`,
        'cwd: /repo',
        'extra allowed dirs: /one, /two',
        'dangerous allowlist: git push, npm publish',
      ].join('\n'),
    )
  })
})
