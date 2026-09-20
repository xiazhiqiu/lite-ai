import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const testDir = path.join(root, 'test')

/**
 * 递归收集 `*.test.ts`。
 *
 * **为什么必须递归**：原实现只 `readdir(test/)` 一层，于是 `test/server/*.test.ts`、
 * `test/helpers/*` 下的用例**在 `npm test` 里完全不被执行**——T6 新增的 39 个
 * 鉴权用例就这样"交付了但没进 CI"。测试发现器漏扫 = 门禁失效，比测试写错更危险。
 *
 * 跳过 `helpers/`：那里放的是共享契约断言集（纯函数，由具体测试文件 import
 * 后调用），本身不是测试文件。它们不含 `.test.ts` 后缀，天然被下面的过滤排除，
 * 这里显式跳过只是让意图更清楚。
 */
async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'helpers' || entry.name === 'node_modules') continue
      files.push(...(await collectTestFiles(full)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(full)
  }
  return files
}

const testFiles = (await collectTestFiles(testDir)).sort()

if (testFiles.length === 0) {
  console.error('No test files found under test/**/*.test.ts')
  process.exit(1)
}

console.log(`[test] 发现 ${testFiles.length} 个测试文件`)

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  { stdio: 'inherit' },
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
