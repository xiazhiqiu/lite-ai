/**
 * T10 静态托管测试 —— **重点是路径穿越防御**，其次是 SPA fallback 语义。
 *
 * 路径穿越是这类代码唯一真实的安全要害：一个 `..` 的疏忽就等于把服务器
 * 文件系统暴露给任何能发 HTTP 请求的人。所以这里不只测"正常能取到文件"，
 * 而是把已知的绕过手法逐条钉死。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import { createServerApp } from '../../src/server/http.js'
import type { ServerApp } from '../../src/server/http.js'
import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import { contentTypeFor, resolveSafePath } from '../../src/server/static.js'

// ────────────────────────────────────────────────────────────
// 纯函数层：resolveSafePath / contentTypeFor
// ────────────────────────────────────────────────────────────

describe('resolveSafePath：路径穿越防御', () => {
  const ROOT = path.resolve('/srv/webroot')

  /** 安全不变量：返回值要么为 null，要么**严格落在根内**。 */
  function assertNeverEscapes(requestPath: string): void {
    const r = resolveSafePath(ROOT, requestPath)
    if (r === null) return
    assert.ok(
      r === ROOT || r.startsWith(ROOT + path.sep),
      `${requestPath} 解析出根外路径：${r}`,
    )
  }

  it('正常路径解析到根内', () => {
    const r = resolveSafePath(ROOT, '/assets/app.js')
    assert.equal(r, path.join(ROOT, 'assets', 'app.js'))
  })

  it('根路径解析为根目录本身（调用方再决定是否取 index.html）', () => {
    const r = resolveSafePath(ROOT, '/')
    assert.equal(r, ROOT)
  })

  /**
   * 【关键】`../` 在根层**被归一化消解**（POSIX 语义：根之上的 `..` 保持为根）。
   *
   * 即 `/../etc/passwd` → `/etc/passwd` → `<root>/etc/passwd`。
   * 这与 nginx 的 `root` 指令行为一致：**不是漏洞**，因为结果仍在根内
   * （攻击者只能看到 `<root>/etc/passwd` 这个几乎不可能存在的文件）。
   *
   * 真正要守住的不变量是「**永不落在根外**」，而非「必须返回 null」——
   * 早期版本把期望写成 null 是**测试期望写错**（见 skill 坑 14）。
   */
  it('【关键】../ 穿越被归一化消解，结果始终落在根内（而非逃出）', () => {
    for (const p of [
      '/../etc/passwd',
      '/../../etc/passwd',
      '/assets/../../secret',
      '/../../../root/.ssh/id_rsa',
    ]) {
      assertNeverEscapes(p)
    }
    // 具体形态：根层的 `..` 被消解
    assert.equal(resolveSafePath(ROOT, '/../etc/passwd'), path.join(ROOT, 'etc', 'passwd'))
  })

  it('【关键】URL 编码的穿越同样被消解 —— 证明先解码后归一化', () => {
    for (const p of [
      '/%2e%2e/etc/passwd',
      '/assets/%2e%2e%2f%2e%2e%2fsecret',
      '/%252e%252e/secret',
    ]) {
      assertNeverEscapes(p)
    }
    assert.equal(
      resolveSafePath(ROOT, '/%2e%2e/etc/passwd'),
      path.join(ROOT, 'etc', 'passwd'),
    )
  })

  it('【关键】Windows 反斜杠穿越被消解（先转 / 再 posix.normalize）', () => {
    for (const p of ['/..\\..\\boot.ini', '/assets\\..\\..\\secret', '/..%5C..%5Cboot.ini']) {
      assertNeverEscapes(p)
    }
  })

  it('【关键】拒绝 NUL 字节（C 字符串截断攻击）', () => {
    assert.equal(resolveSafePath(ROOT, '/app.js%00.png'), null)
  })

  it('畸形百分号编码直接拒绝，不猜不回退', () => {
    assert.equal(resolveSafePath(ROOT, '/%zz'), null)
    assert.equal(resolveSafePath(ROOT, '/%'), null)
  })

  it('【关键】前缀比较必须带分隔符（否则兄弟目录会被误放行）', () => {
    // 直接钉死判据本身：`/srv/webroot-evil` 以 `/srv/webroot` 为前缀，
    // 但不是其子路径。实现若写成 `startsWith(root)`（不带 path.sep）会误放行。
    const sibling = path.resolve('/srv/webroot-evil/secret.txt')
    assert.ok(sibling.startsWith(ROOT), '兄弟目录确实共享字符串前缀')
    assert.ok(
      !sibling.startsWith(ROOT + path.sep),
      '但加上分隔符后不再匹配 —— 这正是实现必须带 path.sep 的原因',
    )
    // 通过请求路径构造不出该兄弟目录（`..` 全被消解），故此处验证判据
    assertNeverEscapes('/../webroot-evil/secret.txt')
  })

  it('多层合法子目录正常解析', () => {
    const r = resolveSafePath(ROOT, '/a/b/c/file.css')
    assert.equal(r, path.join(ROOT, 'a', 'b', 'c', 'file.css'))
  })

  it('所有已知穿越手法统一走「不变量」断言（回归网）', () => {
    const attempts = [
      '/..',
      '/../',
      '/../../../../../../etc/shadow',
      '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fshadow',
      '/..\\..\\..\\windows\\system32\\config\\sam',
      '/./../../secret',
      '//../secret',
      '/a/../../b',
    ]
    for (const p of attempts) assertNeverEscapes(p)
  })
})

describe('contentTypeFor', () => {
  it('覆盖 Vite 产物会用到的类型', () => {
    assert.match(contentTypeFor('index.html'), /text\/html/)
    assert.match(contentTypeFor('app.js'), /text\/javascript/)
    assert.match(contentTypeFor('app.css'), /text\/css/)
    assert.match(contentTypeFor('logo.svg'), /image\/svg\+xml/)
    assert.match(contentTypeFor('a.woff2'), /font\/woff2/)
  })

  it('大小写不敏感', () => {
    assert.match(contentTypeFor('APP.JS'), /text\/javascript/)
  })

  it('未知类型回退为二进制流（不猜成 text/html —— 那会被当页面渲染）', () => {
    assert.equal(contentTypeFor('weird.bin'), 'application/octet-stream')
    assert.equal(contentTypeFor('noext'), 'application/octet-stream')
  })
})

// ────────────────────────────────────────────────────────────
// 集成层：真起 server + 真磁盘目录
// ────────────────────────────────────────────────────────────

async function startApp(webRoot: string) {
  const app: ServerApp = createServerApp({
    store: createMemoryJobStore(),
    cwd: '/srv/workspace',
    webRoot,
  })
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = app.server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

describe('静态托管（真 HTTP）', () => {
  let root: string
  let ctx: Awaited<ReturnType<typeof startApp>>

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lite-ai-web-'))
    await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>')
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)')
    await writeFile(path.join(root, 'assets', 'app.css'), '.a{color:red}')
    ctx = await startApp(root)
  })

  after(async () => {
    await ctx.close()
    await rm(root, { recursive: true, force: true })
  })

  it('GET / 返回 index.html 且类型正确', async () => {
    const res = await fetch(`${ctx.baseUrl}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await res.text(), /<div id="root">/)
  })

  it('GET 真实资源命中并给出正确 Content-Type', async () => {
    const res = await fetch(`${ctx.baseUrl}/assets/app.js`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/)
    assert.equal(await res.text(), 'console.log(1)')

    const css = await fetch(`${ctx.baseUrl}/assets/app.css`)
    assert.match(css.headers.get('content-type') ?? '', /text\/css/)
  })

  it('【SPA fallback】深链接（无扩展名）回 index.html，刷新不 404', async () => {
    // /settings/profile 这类前端路由刷新时必须拿到 index.html，否则用户看到 404
    const res = await fetch(`${ctx.baseUrl}/settings/profile`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  })

  it('API 前缀不被静态托管截胡（/jobs、/chat、/sessions 仍走鉴权路由）', async () => {
    // 若静态托管抢先响应 /jobs，API 会被一个 HTML 页面顶掉 —— 必须排除
    const jobs = await fetch(`${ctx.baseUrl}/jobs/some-job-id`)
    assert.ok(jobs.status < 500, `不得 5xx（实得 ${jobs.status}）`)
    assert.doesNotMatch(
      jobs.headers.get('content-type') ?? '',
      /text\/html/,
      '/jobs 不得被 SPA fallback 成 HTML',
    )

    const chat = await fetch(`${ctx.baseUrl}/chat`, { method: 'POST' })
    assert.ok(chat.status < 500, `不得 5xx（实得 ${chat.status}）`)

    // /sessions 是后加的：曾因静态守卫的排除名单漏登，`GET /sessions` 被 SPA
    // fallback 当深链回 HTML（200 + text/html，且**绕过鉴权**）。这条钉死它。
    const sessions = await fetch(`${ctx.baseUrl}/sessions`)
    assert.ok(sessions.status < 500, `不得 5xx（实得 ${sessions.status}）`)
    assert.doesNotMatch(
      sessions.headers.get('content-type') ?? '',
      /text\/html/,
      '/sessions 不得被 SPA fallback 成 HTML',
    )
  })

  it('【关键】缺失的资源（带扩展名）返回 404，**不回 index.html**', async () => {
    // 若回 index.html，浏览器会拿 HTML 当 JS 解析 → 一堆莫名其妙的语法错
    const res = await fetch(`${ctx.baseUrl}/assets/missing.js`)
    assert.notEqual(res.status, 200, '缺失资源不得回 200')
  })

  it('HEAD 请求返回头但无 body', async () => {
    const res = await fetch(`${ctx.baseUrl}/assets/app.js`, { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '')
  })

  it('【关键】穿越尝试在真 HTTP 层被拒（不回 200）', async () => {
    for (const p of ['/../package.json', '/assets/../../package.json', '/%2e%2e/package.json']) {
      const res = await fetch(`${ctx.baseUrl}${p}`)
      assert.notEqual(res.status, 200, `${p} 不得返回 200`)
    }
  })

  it('未配置 webRoot 时不托管静态（保持纯 API 形态）', async () => {
    const app = createServerApp({ store: createMemoryJobStore(), cwd: '/srv/workspace' })
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject)
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = app.server.address() as AddressInfo
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      // 无鉴权配置 → 401（业务路由先鉴权），但绝不是 200 的静态页面
      assert.notEqual(res.status, 200)
    } finally {
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    }
  })
})
