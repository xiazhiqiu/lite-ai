/**
 * T9-c CLI 回归 —— **真起子进程**，证明服务端改造没有把 CLI 形态搞坏。
 *
 * ## 为什么要"真跑子进程"而不是单测函数
 *
 * T1–T8 全在做服务端：抽 SessionStore 接口、加 PG 后端、加鉴权、加 Worker。
 * 这些改动**全都动到了 CLI 也在用的模块**（`config.ts` / `session.ts` /
 * `permissions.ts` / `tools/index.ts`）。单测能证明"函数行为对"，
 * 证明不了"`tsx src/index.ts` 还能正常启动并回答一句话"——
 * 而后者才是老用户的实际用法。T9 的验收口径是"**CLI 形态不倒退**"，
 * 那就必须真的把它跑起来。
 *
 * ## 两种形态
 *
 * 1. **交互式 CLI（非 TTY 管道输入）**：走 `readline` 循环，与 TTY 形态共用
 *    同一套 `runAgentTurn`（`src/index.ts:302`）。真 TTY 需要 pty，本环境起不来；
 *    管道形态覆盖的是**同一条代码路径**（只差 TUI 渲染），足以挡住回归。
 * 2. **`--webhook`（deprecated 但仍在用）**：G7 尚未合并，老部署还在跑它。
 *    必须证明它仍能启动、仍能收告警（返回 202）、非 POST 仍 405。
 *
 * ## 隔离
 *
 * 子进程一律带 `LITE_AI_HOME=<临时目录>`：CLI 会把 permissions / 会话 / 告警
 * 记录写到 `LITE_AI_DIR`（`config.ts` 由 `LITE_AI_HOME` 派生）。
 * **不隔离就会污染用户真实的 `~/.lite-ai`** —— 这个坑本仓库已经踩过一次
 * （两个会话测试文件把真实 `~/.lite-ai/projects` 删掉了，见
 * `test/session-store-contract.test.ts` 的自检断言）。这里同理，绝不手软。
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CLI = path.join(REPO, 'src', 'index.ts')

/** managed node（与全仓库测试保持一致，避免依赖 PATH 上的系统 node）。 */
const NODE =
  process.env.LITE_AI_TEST_NODE ??
  'C:\\Users\\Queenie\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 取一个空闲端口（拿到就关，给子进程用）。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

type Spawned = {
  proc: ChildProcessWithoutNullStreams
  /** 到目前为止累积的 stdout（已去 ANSI）。 */
  out: () => string
  err: () => string
  /** 等 stdout 出现某段文本。 */
  waitFor: (needle: string, timeoutMs?: number) => Promise<void>
  /** 等进程退出，返回退出码。 */
  waitExit: (timeoutMs?: number) => Promise<number | null>
}

const ANSI = /\u001B\[[0-9;]*m/g

function spawnCli(args: string[], opts: { cwd: string; home: string }): Spawned {
  const proc = spawn(NODE, ['--import', 'tsx', CLI, ...args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      // 模型走 mock：CLI 回归不关心模型说什么，只关心"能跑完一轮"
      LITE_AI_MODEL_MODE: 'mock',
      // 关键隔离：绝不碰用户真实的 ~/.lite-ai
      LITE_AI_HOME: opts.home,
      // 关掉彩色与结构化日志，输出才好断言
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      LITE_AI_STRUCTURED_LOG: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  proc.stderr.on('data', chunk => {
    stderr += String(chunk)
  })

  return {
    proc,
    out: () => stdout.replace(ANSI, ''),
    err: () => stderr.replace(ANSI, ''),
    async waitFor(needle, timeoutMs = 60_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (stdout.replace(ANSI, '').includes(needle)) return
        await sleep(50)
      }
      throw new Error(
        `等 stdout 出现 "${needle}" 超时。\n--- stdout ---\n${stdout
          .replace(ANSI, '')
          .slice(-2000)}\n--- stderr ---\n${stderr.replace(ANSI, '').slice(-2000)}`,
      )
    },
    async waitExit(timeoutMs = 30_000): Promise<number | null> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill()
          reject(new Error('等进程退出超时（已 kill）'))
        }, timeoutMs)
        proc.once('exit', code => {
          clearTimeout(timer)
          resolve(code)
        })
      })
    },
  }
}

const children: Spawned[] = []
const homes: string[] = []

after(async () => {
  for (const child of children) {
    if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill()
  }
  await sleep(200)
  for (const home of homes) {
    await rm(home, { recursive: true, force: true })
  }
})

describe('T9 CLI 回归：服务端改造后 CLI 形态仍然可用', () => {
  it('交互式 CLI（管道输入）能启动、渲染 banner 并跑完一轮对话', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'lite-ai-cli-home-'))
    homes.push(home)

    const cli = spawnCli([], { cwd: REPO, home })
    children.push(cli)

    // 启动即渲染 banner（含 "LiteAI" 面板标题）
    await cli.waitFor('LiteAI')

    // 发一句话，走完整一轮 `runAgentTurn`。mock 模型对任意输入的回复是固定的
    // （`src/mock-model.ts:79-87`）—— 出现它 = 「读输入 → 跑 turn → 打印结论」
    // 这条链真的通了。刻意**不**用 `/cmd` 触发工具调用：非 TTY 下权限询问
    // 没有交互通道，可能挂住；那是既有行为，不属于本回归要守的面。
    cli.proc.stdin.write('订单服务 5xx 激增\n')
    await cli.waitFor('这是一个最小骨架版本')
    // 失败路径会打印「请求失败: ...」，看到了就说明 turn 抛错了
    assert.ok(
      !cli.out().includes('请求失败'),
      `CLI 不应走到失败分支，stderr=${cli.err().slice(-800)}`,
    )
    cli.proc.stdin.write('/exit\n')

    const code = await cli.waitExit()
    // 退出码必须干净：CLI 自身出错会走 main().catch → process.exitCode = 1
    assert.equal(code, 0, `CLI 应干净退出，stderr=${cli.err().slice(-800)}`)
  }, { timeout: 120_000 })

  it('--webhook 形态仍能启动并接收告警（POST 202 / 非 POST 405）', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'lite-ai-webhook-home-'))
    homes.push(home)
    const port = await freePort()

    const cli = spawnCli(['--webhook', String(port)], { cwd: REPO, home })
    children.push(cli)

    await cli.waitFor('[webhook] listening')

    // Alertmanager 形态的告警（与 test/webhook.test.ts 的 FIRING_PAYLOAD 同构）
    const payload = {
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'HighErrorRate', severity: 'critical', service: 'order-api' },
          annotations: { summary: 'order-api 5xx 突增' },
          startsAt: new Date().toISOString(),
        },
      ],
      groupLabels: {},
    }

    try {
      const post = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      assert.equal(post.status, 202, '告警入队必须 202（诊断异步跑）')
      await post.text()

      const get = await fetch(`http://127.0.0.1:${port}/webhook`)
      assert.equal(get.status, 405, '非 POST 必须 405（形态未变）')
      await get.text()

      const unknown = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST' })
      assert.equal(unknown.status, 404, '未知路径 404（形态未变）')
      await unknown.text()
    } finally {
      cli.proc.kill()
    }
  }, { timeout: 120_000 })
})
