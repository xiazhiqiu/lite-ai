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

/**
 * 并发度。默认交给 `node --test` 自己决定（≈ CPU 核数 - 1）。
 *
 * 为什么留这个旋钮：多个测试文件并发跑时，若某个文件持有全局副作用
 * （真实 HTTP 监听、OTLP/Langfuse 建连、模型加载等），资源受限的机器 / CI 上
 * 仍可能互相干扰。显式给非法值即报错，不静默回退 —— 否则
 * "我明明设了 1 怎么还并发"很难查。
 */
const concurrency = process.env.LITE_AI_TEST_CONCURRENCY?.trim()
if (concurrency !== undefined && concurrency !== '' && !/^[1-9]\d*$/.test(concurrency)) {
  console.error(`LITE_AI_TEST_CONCURRENCY 取值非法：${concurrency}（只接受正整数）`)
  process.exit(1)
}

/**
 * `--test-force-exit`：用例跑完后**强制退出**，不等 event loop 里残留的 handle。
 *
 * 为什么需要：少数测试文件（`ingest-pipeline` / `ingest-resolved` /
 * `server/alert-merge`）的 import 链路会建起全局连接池 / HTTP agent 一类 handle。
 * 用例本身 **3 秒就跑完**，但进程**永不退出**。后果有两层，都很难看：
 *   1. 单独跑 → 被外部 timeout 杀掉（exit=124），且 TAP 里**文件级容器**会被记成
 *      `fail 1`。数一下 `it()` 只有 6 个而 tally 说 7 个 —— 那 1 个是容器，
 *      **不是真用例失败**，但足以让人误判"测试挂了"。
 *   2. 跑全量 → 整个 run 被拖到 20 分钟以上（未加此 flag 时实测 20m51s）。
 *
 * 加上此 flag 后：同样三个文件 3 秒退出、exit=0、用例数归位。
 *
 * 注意范围：这是**测试运行器**层面的处置，**不是产物代码的修复**。这些 handle
 * 对长期驻留的 `serve` 进程本来就是正常的（本就该持有连接池），只有短命进程
 * （测试 / CLI）才会被它拖住 —— 所以不该为了跑测试去改生产代码的连接生命周期。
 *
 * Node 22 起支持；低版本自动跳过（不报错），行为回到"能跑完，但要多等"。
 */
const supportsForceExit = Number.parseInt(process.versions.node.split('.')[0], 10) >= 22

const child = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    ...(supportsForceExit ? ['--test-force-exit'] : []),
    ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
    ...testFiles,
  ],
  { stdio: 'inherit' },
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
