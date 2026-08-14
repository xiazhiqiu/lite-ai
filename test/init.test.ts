import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  initializeRepo,
  renderInitLiteMd,
  renderInitReport,
} from '../src/init.js'

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `lite-ai-init-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('renderInitLiteMd', () => {
  test('generates template for empty project', () => {
    const dir = makeTempDir()
    try {
      const result = renderInitLiteMd(dir)
      assert.ok(result.includes('# LITE.md'))
      assert.ok(result.includes('## Detected stack'))
      assert.ok(result.includes('No specific language markers'))
      assert.ok(result.includes('## Working agreement'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('detects TypeScript project', () => {
    const dir = makeTempDir()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.0' } }))
    writeFileSync(path.join(dir, 'tsconfig.json'), '{}')
    const result = renderInitLiteMd(dir)
    assert.ok(result.includes('Languages: TypeScript.'))
    assert.ok(result.includes('npm test'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('detects Python project', () => {
    const dir = makeTempDir()
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"')
    const result = renderInitLiteMd(dir)
    assert.ok(result.includes('Languages: Python.'))
    assert.ok(result.includes('pytest'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('detects Rust workspace', () => {
    const dir = makeTempDir()
    mkdirSync(path.join(dir, 'rust'), { recursive: true })
    writeFileSync(path.join(dir, 'rust', 'Cargo.toml'), '[workspace]\n')
    const result = renderInitLiteMd(dir)
    assert.ok(result.includes('Languages: Rust.'))
    assert.ok(result.includes('cargo clippy'))
    assert.ok(result.includes('rust/'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('detects frameworks from package.json', () => {
    const dir = makeTempDir()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { next: '14.0', react: '18.0', vite: '5.0' },
      devDependencies: { typescript: '5.0' },
    }))
    const result = renderInitLiteMd(dir)
    assert.ok(result.includes('Next.js'))
    assert.ok(result.includes('React'))
    assert.ok(result.includes('Vite'))
    assert.ok(result.includes('Next.js detected'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('detects src/ and tests/ directories', () => {
    const dir = makeTempDir()
    mkdirSync(path.join(dir, 'src'))
    mkdirSync(path.join(dir, 'tests'))
    const result = renderInitLiteMd(dir)
    assert.ok(result.includes('src/'))
    assert.ok(result.includes('tests/'))
    assert.ok(result.includes('both present'))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('initializeRepo', () => {
  test('creates expected artifacts', async () => {
    const dir = makeTempDir()
    try {
      const report = await initializeRepo(dir)
      assert.equal(report.artifacts.length, 3)
      assert.equal(report.artifacts[0].name, '.lite-ai/')
      assert.equal(report.artifacts[0].status, 'created')
      assert.equal(report.artifacts[1].name, '.gitignore')
      assert.equal(report.artifacts[2].name, 'LITE.md')
      assert.ok(existsSync(path.join(dir, '.lite-ai')))
      assert.ok(existsSync(path.join(dir, 'LITE.md')))

      const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8')
      assert.ok(gitignore.includes('.lite-ai/settings.local.json'))
      assert.ok(gitignore.includes('.lite-ai/sessions/'))
      assert.ok(gitignore.includes('# LiteAI local artifacts'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is idempotent — all skipped on re-run', async () => {
    const dir = makeTempDir()
    try {
      await initializeRepo(dir)
      const report = await initializeRepo(dir)
      for (const artifact of report.artifacts) {
        assert.equal(artifact.status, 'skipped', `${artifact.name} should be skipped`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not overwrite existing LITE.md', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'LITE.md'), 'custom rules')
      await initializeRepo(dir)
      const content = readFileSync(path.join(dir, 'LITE.md'), 'utf8')
      assert.equal(content, 'custom rules')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('appends to existing .gitignore without duplicating entries', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, '.gitignore'), '.lite-ai/sessions/\n')
      await initializeRepo(dir)
      const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8')
      assert.equal(gitignore.match(/\.lite-ai\/settings\.local\.json/g)?.length, 1)
      assert.equal(gitignore.match(/\.lite-ai\/sessions\//g)?.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('creates .gitignore when it does not exist', async () => {
    const dir = makeTempDir()
    try {
      await initializeRepo(dir)
      const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8')
      const lines = gitignore.split('\n').filter(l => l.trim())
      assert.equal(lines[0], '# LiteAI local artifacts')
      assert.ok(lines.includes('.lite-ai/settings.local.json'))
      assert.ok(lines.includes('.lite-ai/sessions/'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderInitReport', () => {
  test('formats artifacts with status labels', () => {
    const report = {
      projectRoot: '/test/project',
      artifacts: [
        { name: '.lite-ai/', status: 'created' as const },
        { name: '.gitignore', status: 'updated' as const },
        { name: 'LITE.md', status: 'skipped' as const },
      ],
    }
    const rendered = renderInitReport(report)
    assert.ok(rendered.includes('Init'))
    assert.ok(rendered.includes('/test/project'))
    assert.ok(rendered.includes('.lite-ai/'))
    assert.ok(rendered.includes('created'))
    assert.ok(rendered.includes('updated'))
    assert.ok(rendered.includes('skipped (already exists)'))
    assert.ok(rendered.includes('Next step'))
  })
})
