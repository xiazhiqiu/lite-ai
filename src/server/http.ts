/**
 * 服务端 HTTP 层（T3）——**`node:http`，零框架**。
 *
 * 与 `webhook/index.ts:102` 同一技术栈与同一风格：手写 `createServer` + 极简
 * method/pathname 分发。为什么不引 Fastify/Express：既有 webhook 已是 `node:http`
 * 且工作良好，服务化只是**多几条路由**，引框架会把"运行时零新增依赖"这条口径打破。
 *
 * 本文件只做两件事：
 * 1. **传输层**：解析请求、分发路由、写响应（含 SSE）。
 * 2. **入队/查询**：调 `JobStore`，**不执行业务**——真正的调查由 Worker（T4/T5）
 *    在别处消费，这正是异步队列的意义（HTTP 层必须立刻返回，不能阻塞）。
 *
 * 边界：本文件**不含** Worker（T4）、**不含** 聚合（T12）。
 * 鉴权（T6）在本文件内**只做接线**：真正的校验/身份解析在 `auth.ts`。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { JobStore } from '../jobs/store.js'
import type { Job } from '../jobs/types.js'
import type { UsageRecord, UsageStore } from '../usage/index.js'
import { authenticate, isExemptPath, type AuthConfig } from './auth.js'
import { tryServeStatic } from './static.js'
// G7：请求体读取与本文件原本自建的那份**合并为一份**（`body.ts`），
// 否则同一条告警会在两种形态下被两套上限处理。
import { MAX_BODY_BYTES, readBody } from './body.js'
import { routeAlertSource } from '../webhook/sources/index.js'
import type { Alert } from '../webhook/types.js'
import type { IngestResult, IngestContext } from '../ingest/pipeline.js'
import type { SessionMeta, SessionStore } from '../session/store.js'

/** SSE 心跳间隔：防反向代理/负载均衡把空闲连接掐掉。 */
const SSE_HEARTBEAT_MS = 15_000
/** SSE 轮询间隔：事件源是 PG/Store 而非内存总线（plan G5），靠轮询拉增量。 */
const SSE_POLL_MS = 250

/**
 * **数据面** API 路径前缀。静态资源托管必须对它们让路。
 *
 * 为什么要有这张表：静态托管跑在鉴权**之前**（登录页要匿名可取，见 `handle` 内注释），
 * 而 SPA fallback 会把"无扩展名的未命中路径"一律回 `index.html`。于是只要某个 API
 * 路径没被排除，`GET` 它就会拿到一坨 HTML —— 无鉴权、200、且路由根本不生效。
 * （真实事故：`/sessions` 加进来时漏登，`GET /sessions` 返回了前端首页。）
 *
 * 用**集中登记 + 前缀匹配**替代散落的 `path !== x && !path.startsWith(y)`
 * 条件链：新增 API 只在此处加一行，不会再漏。`isApiPath` 同时覆盖
 * `/jobs` 与 `/jobs/:id`、`/sessions` 与 `/sessions/:id/rename` 两类形态。
 */
const API_PATH_PREFIXES = ['/chat', '/jobs', '/usage', '/sessions', '/webhook'] as const

/** 该路径是否属于数据面 API（静态托管须跳过）。 */
function isApiPath(pathname: string): boolean {
  return API_PATH_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export type ServerAppOptions = {
  store: JobStore
  /**
   * 用量 / 审计账本（T7）。**不传 = 不挂 `/usage` 路由**（404）。
   *
   * 为什么不给个默认的内存实现：审计数据的"看起来能用"是**危险的假象**——
   * 部署方会以为合规检查有据可查，实际重启即空。宁可在未接线时明确 404，
   * 让缺口暴露在集成测试里，也不要静默提供一个会骗人的默认。
   */
  usage?: UsageStore
  /**
   * 服务端工作区路径（plan G4）——**不是**用户本地目录。
   * 文件类工具只能在此路径下取证。
   */
  cwd: string
  /**
   * 就绪探测（`/readyz`）。缺省恒 ready。
   * 生产接线时传 `() => pingPg(pool)` —— 让 readyz 真实查库，
   * 而不是恒返 200 把"依赖挂了"藏起来。
   */
  ready?: () => Promise<boolean>
  /**
   * 鉴权配置（T6）。`keys` 为空 = **业务请求一律 401**（fail-closed），
   * 而非"不启用鉴权"：空表里没有任何 key 可匹配。启动层的 fail-fast 只对
   * 回环地址放行"允许启动"（`server/index.ts` 装配层），但那不代表端点开放。
   */
  auth?: AuthConfig
  /**
   * 前端静态资源目录（T10，`dist/web`）。
   *
   * **不传 = 不托管前端** —— 保持 T3 纯 API 形态（也便于单测只测路由）。
   * 传了则先尝试静态命中，未命中再进 API 路由。
   */
  webRoot?: string
  /**
   * 【G7】告警摄入。提供时才启用 `POST /webhook`（未提供 → 404，即不启用告警形态）。
   *
   * 为什么是注入而不是在 http 层 `new IngestPipeline`：本文件是**传输层**，
   * 不该知道去重 / 关联 / 队列的存在；由装配层决定"告警进来之后去哪"。
   * 返回值 `IngestResult`（accepted/deduplicated/...）直接作为 202 响应体，
   * 与旧 webhook 进程**同口径**，Alertmanager 侧无需改解析。
   */
  alertIngest?: (alerts: Alert[], ctx: IngestContext) => IngestResult
  /**
   * 会话存储（第 1 档：`/sessions` 系列 —— 列表 / 重命名 / 分叉）。
   *
   * **不传 = 不挂这些路由**（404）—— 与 `usage` 同范式：宁可让缺口显式暴露在
   * 集成测试里，也不要静默给一个看起来能用、实则没接数据的端点。
   *
   * ⚠️ `SessionStore` 是 **cwd 作用域**的，本身**没有 userId**。per-user 隔离
   * 由本层用「该用户发起过的 job」反查归属后强制贯彻 —— 见 `handleListSessions`。
   */
  sessions?: SessionStore
  /**
   * 外部触发关闭（测试注入）；与 SIGINT/SIGTERM 等效。
   */
  abortSignal?: AbortSignal
}

export type ServerApp = {
  server: http.Server
  store: JobStore
  /** 停止接收新连接并关闭（等待在途请求结束）。 */
  close(): Promise<void>
}

function reply(
  res: http.ServerResponse,
  code: number,
  data: Record<string, unknown>,
): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/**
 * job → 对外的 JSON 形态（snake_case 出入参对齐 HolmesGPT 的 API 风格）。
 *
 * **`summary` 是刻意裁剪的投影，不下发整个 `payload`**：告警 payload 可能很大
 * （原始告警体、labels、annotations），也可能含敏感字段。列表页/详情页只需要
 * 一行"这是在查什么"，所以这里只提取一个字符串摘要。
 */
function toWireJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    userId: job.userId,
    kind: job.kind,
    status: job.status,
    sessionId: job.sessionId,
    incidentId: job.incidentId,
    assignee: job.assignee,
    error: job.error,
    summary: summarizeJobPayload(job.payload),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  }
}

/**
 * session → 对外的 JSON 形态。
 *
 * `title` 缺省落 `null`（而不是空串）：前端可据此区分"还没起名"与"起了个空名"。
 */
function toWireSession(meta: SessionMeta): Record<string, unknown> {
  return {
    id: meta.id,
    title: meta.title ?? null,
    messageCount: meta.messageCount,
    updatedAt: meta.updatedAt,
  }
}

/**
 * 从 payload 里提取一行摘要（**只取字符串，不序列化整个对象**）。
 *
 * 键序即优先级：人工问询的 `message` 最有用；告警类退化到 `alertName`/`title`。
 * 全部缺失时返回 null（前端自己给占位文案），**不猜**。
 */
function summarizeJobPayload(payload: Record<string, unknown>): string | null {
  for (const key of ['message', 'alertName', 'title', 'summary']) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      const oneLine = v.replace(/\s+/g, ' ').trim()
      // 截断，避免一条超长 message 撑爆前端列表
      return oneLine.length <= 200 ? oneLine : `${oneLine.slice(0, 199)}…`
    }
  }
  return null
}

function toWireEvent(event: {
  seq: number
  kind: string
  payload: Record<string, unknown>
  createdAt: number
}): Record<string, unknown> {
  return {
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt,
  }
}

/**
 * 从 `?after=` / `Last-Event-ID` 解析增量起点。
 * 两者都无效（NaN / 负数）时退回 0（从头拉）。
 */
function parseSeq(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** 列表分页默认值与上限 —— 见 `handleListJobs` 的约束 2。 */
const LIST_LIMIT_DEFAULT = 50
const LIST_LIMIT_MAX = 200

/**
 * 解析列表 `limit`：非法 / 缺省 → 默认值；超上限 → 夹到上限。
 * **绝不把用户传的值直接下传**（`?limit=100000` 会拉垮服务端）。
 */
function parseLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return LIST_LIMIT_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return LIST_LIMIT_DEFAULT
  return Math.min(Math.floor(n), LIST_LIMIT_MAX)
}

/**
 * 用量明细的 limit。
 *
 * 值与 `usage/memory-store.ts` 的 `USAGE_LIMIT_*` **必须一致** —— 这里刻意重复
 * 常量而不是 import，是为了让 HTTP 层对"用户能一次拉多少"有独立的、显式的上限
 * （存储层的 clamp 是纵深防御的第二道，不是第一道）。
 */
const USAGE_LIMIT_DEFAULT = 100
const USAGE_LIMIT_MAX = 500

function parseUsageLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return USAGE_LIMIT_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return USAGE_LIMIT_DEFAULT
  return Math.min(Math.floor(n), USAGE_LIMIT_MAX)
}

/** 用量行 → 对外 JSON。字段名与 `usage_events` 列名对齐（snake_case 归前端管）。 */
function toWireUsage(row: UsageRecord): Record<string, unknown> {
  return {
    id: row.id,
    jobId: row.jobId,
    sessionId: row.sessionId,
    traceId: row.traceId,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    durationMs: row.durationMs,
    status: row.status,
    createdAt: row.createdAt,
  }
}

export function createServerApp(opts: ServerAppOptions): ServerApp {
  const { store } = opts
  const usage = opts.usage
  const ready = opts.ready ?? (async () => true)
  const auth: AuthConfig = opts.auth ?? { keys: [] }
  const webRoot = opts.webRoot
  const alertIngest = opts.alertIngest
  const sessions = opts.sessions

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // ---- 健康检查：**免鉴权**（对齐 HolmesGPT auth.py 豁免，LB/k8s 探针不能带凭证）----
    // 豁免判定须用**归一化后的 pathname 精确匹配**，不信任任何转发头
    // （HolmesGPT CVE-2026-48710 的教训：Host 头可伪造，别用它重建豁免路径）。
    if (isExemptPath(path, auth.exemptPaths)) {
      if (path === '/healthz') {
        if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
        return reply(res, 200, { status: 'ok' })
      }
      if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
      let ok = false
      try {
        ok = await ready()
      } catch {
        // 依赖探测抛错 = 未就绪。绝不吞成 200 —— 否则 LB 会把流量打到坏实例。
        ok = false
      }
      return reply(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not ready' })
    }

    // ---- T10 静态资源：**在鉴权之前** ----
    // 理由：HTML/JS/CSS 本身不含任何数据，登录页必须能匿名拿到，否则用户
    // 连"输入 key 的界面"都看不到。真正的数据面（/chat、/jobs、/usage、
    // /sessions、/webhook）仍在下面严格鉴权 —— 静态免鉴权不等于数据免鉴权。
    //
    // **数据面路径一律不走静态**：交由 `isApiPath` 集中判定（见其注释），
    // 否则 SPA fallback 会把 `GET /sessions` 之类当深链回 HTML。
    if (webRoot !== undefined && !isApiPath(path)) {
      const result = await tryServeStatic(req, res, { root: webRoot })
      if (result.served) return
    }

    // ---- T6 鉴权：非豁免路径一律先验身份，拿到 userId 再进业务 ----
    // 401 文案对"没带凭证"与"凭证不对"**保持一致**，不泄漏哪一种失败。
    const ident = authenticate(req.headers as Record<string, unknown>, auth)
    if (!ident.ok) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      return reply(res, 401, { error: 'unauthorized' })
    }
    const userId = ident.userId

    if (path === '/chat') {
      if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' })
      return handleChat(req, res, userId)
    }

    // GET /jobs —— 列表（T10）。前端值班台的会话列表 / 告警列表 / 用量页都靠它。
    //
    // **per-user 隔离在本层强制**：userId 一律取自鉴权身份，**忽略**查询串里的
    // userId（否则任何人加个 `?userId=别人` 就能读别人的任务列表）。
    // 其余过滤条件（status / incidentId / sessionId / limit）透传给 store。
    if (path === '/jobs') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
      return handleListJobs(req, res, url, userId)
    }

    // GET /usage —— 用量 / 审计账本（T7）。
    //
    // 与 /jobs 同一套隔离口径：`userId` 只取自身份，查询串里的 `userId` 被忽略。
    // 未接线 `usage` 时**明确 404**（不是 200 空数组）—— 见 ServerAppOptions.usage。
    if (path === '/usage') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
      if (usage === undefined) return reply(res, 404, { error: 'not found' })
      return handleListUsage(res, url, userId)
    }

    // ── /sessions 系列（第 1 档：会话管理） ──
    //
    // 为什么需要：`SessionStore` 早有 list / rename / fork，但 HTTP 层**一条都没
    // 暴露** —— 值班台只能拿 job 列表充数（同一会话追问两轮 = 两条 job），且无法
    // 重命名 / 分叉。
    //
    // 归属模型：`SessionStore` 是 cwd 作用域、**没有 userId**；所以"这个会话是不是
    // 你的"只能靠 **job 所有权** 判定（会话因有人发起调查而存在，job 是所有权凭证）。
    if (path === '/sessions') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
      if (sessions === undefined) return reply(res, 404, { error: 'not found' })
      return handleListSessions(res, url, userId)
    }

    const sessionActionMatch = /^\/sessions\/([^/]+)\/(rename|fork)$/.exec(path)
    if (sessionActionMatch !== null) {
      if (sessions === undefined) return reply(res, 404, { error: 'not found' })
      if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' })
      const sessionId = decodeURIComponent(sessionActionMatch[1]!)
      if (!(await sessionOwnedBy(sessionId, userId))) {
        // 刻意**不区分**"不存在"与"不属于你" —— 否则它就成了探测他人会话 id 的信道。
        return reply(res, 404, { error: 'session not found' })
      }
      if (sessionActionMatch[2] === 'rename') {
        return handleRenameSession(req, res, sessionId)
      }
      return handleForkSession(res, sessionId)
    }

    // POST /webhook —— 告警摄入（G7：由 `--serve` 直接吸收，不再单独起进程）。
    //
    // 与旧 webhook 进程**同一套口径**：读 body → JSON.parse → routeAlertSource
    // 归一化 → 交给注入的 alertIngest → 202 + IngestResult。
    // 鉴权走本文件统一身份（serve API key），不再单独认 webhook.secret ——
    // 一个 key 管所有入口，密钥轮换与审计只有一处，不会两套凭证各自过期。
    if (path === '/webhook') {
      if (req.method !== 'POST') {
        return reply(res, 405, { error: 'method not allowed' })
      }
      if (alertIngest === undefined) {
        return reply(res, 404, { error: 'not found' })
      }

      let alertBody: string
      try {
        alertBody = await readBody(req)
      } catch {
        return reply(res, 400, { error: 'payload too large' })
      }

      let payload: unknown
      try {
        payload = JSON.parse(alertBody || '{}')
      } catch {
        return reply(res, 400, { error: 'invalid json' })
      }

      let sourceAdapter
      try {
        sourceAdapter = routeAlertSource(payload)
      } catch {
        return reply(res, 400, { error: 'unrecognized alert source payload' })
      }

      let alerts: Alert[]
      try {
        alerts = sourceAdapter.parse(payload)
      } catch {
        return reply(res, 400, { error: 'payload parse failed' })
      }

      // 归一化之后的一切与"这条告警是怎么来的"无关 —— 推送与拉取共用同一条管道。
      //
      // `userId` 取自身份：告警 job 落在**投递方**名下，per-user 隔离才能正确覆盖
      // （运维含义：告警投递用什么 key，告警 job 就属于谁 —— 值班台要看到它们，
      //  就得用同一个 userId 的 key，见 README「服务端形态与部署」）。
      return reply(res, 202, { ...alertIngest(alerts, { userId }) })
    }

    // /jobs/:id 与 /jobs/:id/stream
    const jobMatch = /^\/jobs\/([^/]+)(\/stream)?$/.exec(path)
    if (jobMatch !== null) {
      const jobId = decodeURIComponent(jobMatch[1]!)
      const isStream = jobMatch[2] !== undefined
      if (isStream) {
        if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
        return handleStream(req, res, jobId, url, userId)
      }
      if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
      return handleGetJob(req, res, jobId, url, userId)
    }

    reply(res, 404, { error: 'not found' })
  }

  /** POST /chat —— 入队，**立即 202**（不等待执行）。 */
  async function handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    userId: string,
  ): Promise<void> {
    let bodyStr: string
    try {
      bodyStr = await readBody(req)
    } catch {
      return reply(res, 400, { error: 'payload too large' })
    }

    let body: unknown
    try {
      body = JSON.parse(bodyStr || '{}')
    } catch {
      return reply(res, 400, { error: 'invalid json' })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply(res, 400, { error: 'body must be a json object' })
    }

    const obj = body as Record<string, unknown>
    const message = obj.message
    if (typeof message !== 'string' || message.trim().length === 0) {
      return reply(res, 400, { error: 'message is required' })
    }

    const sessionIdRaw = obj.sessionId
    if (sessionIdRaw !== undefined && typeof sessionIdRaw !== 'string') {
      return reply(res, 400, { error: 'sessionId must be a string' })
    }
    // 【G2 多轮续接】传了 sessionId 就挂到该会话上（新建 job、复用 session）；
    // 没传则开一个新会话。返回体一并给 sessionId，客户端据此继续续接。
    // 注意：此处**不校验会话是否存在** —— 允许对告警自动诊断产出的会话直接续接
    // （"机器先查、人接着问"的桥），执行层 load 时自然兼容"历史为空"。
    const sessionId =
      typeof sessionIdRaw === 'string' && sessionIdRaw.length > 0
        ? sessionIdRaw
        : `sin-${randomUUID()}`

    // 【T6】提交者**只能**来自鉴权结果，绝不读 body.userId ——
    // 否则任何人塞一个 `userId: "admin"` 就能伪造身份、绕过 per-user 隔离。
    // body 里若带 userId 一律忽略（不报错：老客户端可能仍在发，静默以鉴权身份为准）。
    const job = await store.create({
      userId,
      cwd: opts.cwd,
      kind: 'chat',
      sessionId,
      payload: { message },
    })

    // 202 Accepted：已受理、尚未完成。这是异步队列 HTTP 语义的关键一笔。
    return reply(res, 202, { jobId: job.id, sessionId })
  }

  /**
   * GET /usage[?jobId=&limit=] —— 当前用户的用量明细 + 服务端全量聚合（T7）。
   *
   * **为什么明细与汇总在同一个响应里**（而不是分两个接口）：
   * 前端 `UsageView` 要在同一屏同时显示"最近若干条"与"总计 token / 成功率"。
   * 拆两个接口会让前端多一次往返、并多一个"两次请求之间账本变了"的不一致窗口。
   *
   * **汇总必须来自 `summarize()`（服务端全量），不能在响应里由本页明细算出** ——
   * 那样"总数"会随 `?limit=` 变化，审计数字就有了第二口径。见 `usage/store.ts`。
   *
   * 关于越权：`jobId` 过滤是**在 userId 之上叠加**的（`list()` 内部先按 userId 收窄），
   * 所以传别人的 jobId 只会得到空数组，不会泄漏。
   */
  async function handleListUsage(
    res: http.ServerResponse,
    url: URL,
    userId: string,
  ): Promise<void> {
    if (usage === undefined) return reply(res, 404, { error: 'not found' })

    const [events, summary] = await Promise.all([
      usage.list({
        userId, // ← 强制取自身份，不读查询串
        jobId: url.searchParams.get('jobId') ?? undefined,
        limit: parseUsageLimit(url.searchParams.get('limit')),
      }),
      usage.summarize(userId),
    ])

    return reply(res, 200, {
      events: events.map(toWireUsage),
      summary,
    })
  }

  /**
   * `GET /sessions` —— 会话列表（**per-user**）。
   *
   * 归属判定：**逐会话**查「它下面有没有属于本用户的 job」。刻意不用"先拉一批 job
   * 取 sessionId 集合"那种写法 —— 那需要一个"拉多少条"的魔数，超过它的老会话会被
   * **静默漏掉**；而会话量级（几十~几百）下逐条判定的代价完全可以接受。
   *
   * **诚实标注的边界**：没有任何 job 的会话不会出现在结果里（例如 CLI 直接建的、
   * 或迁移进来的历史会话）。它们不是丢了，只是没有服务端归属凭证。
   */
  async function handleListSessions(
    res: http.ServerResponse,
    url: URL,
    userId: string,
  ): Promise<void> {
    const all = await sessions!.list(opts.cwd)
    const owned: SessionMeta[] = []
    for (const meta of all) {
      if (await sessionOwnedBy(meta.id, userId)) owned.push(meta)
    }
    const limit = parseLimit(url.searchParams.get('limit'))
    return reply(res, 200, { sessions: owned.slice(0, limit).map(toWireSession) })
  }

  /**
   * 会话归属判定：该会话下是否有属于 `userId` 的 job。
   *
   * `limit: 1` 只为回答"有没有"，不拉全量 —— 判定代价与会话内 job 数无关。
   */
  async function sessionOwnedBy(sessionId: string, userId: string): Promise<boolean> {
    const mine = await store.list({ userId, sessionId, limit: 1 })
    return mine.length > 0
  }

  /** `POST /sessions/:id/rename` —— body `{ title }`（归属校验在路由层已做）。 */
  async function handleRenameSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
  ): Promise<void> {
    let bodyStr: string
    try {
      bodyStr = await readBody(req)
    } catch {
      return reply(res, 400, { error: 'payload too large' })
    }
    let body: unknown
    try {
      body = JSON.parse(bodyStr || '{}')
    } catch {
      return reply(res, 400, { error: 'invalid json' })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply(res, 400, { error: 'body must be a json object' })
    }
    const title = (body as Record<string, unknown>).title
    if (typeof title !== 'string' || title.trim().length === 0) {
      return reply(res, 400, { error: 'title is required' })
    }
    const ok = await sessions!.rename(opts.cwd, sessionId, title.trim())
    if (!ok) return reply(res, 404, { error: 'session not found' })
    return reply(res, 200, { ok: true })
  }

  /** `POST /sessions/:id/fork` —— 派生独立副本，201 + 新 sessionId。 */
  async function handleForkSession(
    res: http.ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const newId = await sessions!.fork(opts.cwd, sessionId)
    if (newId === null) return reply(res, 404, { error: 'session not found' })
    return reply(res, 201, { sessionId: newId })
  }

  /** GET /jobs/:id[?after=<seq>] —— 状态快照 + 事件增量（**仅限本人 job**）。 */
  async function handleGetJob(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    jobId: string,
    url: URL,
    userId: string,
  ): Promise<void> {
    const job = await store.get(jobId)
    // 【T6】跨用户访问返回 **404 而非 403**：403 等于告诉攻击者"这个 job 确实存在，
    // 只是不归你"，可用于枚举他人 jobId / 探测系统规模。404 把"不存在"与"不是你的"
    // 统一成一个回答，不泄漏资源存在性（对齐 HolmesGPT 的越权处理口径）。
    if (job === null || job.userId !== userId) {
      return reply(res, 404, { error: 'job not found' })
    }

    // 增量拉取：前端轮询带上次收到的最后一个 seq，避免重复传全量事件
    const after = parseSeq(url.searchParams.get('after'))
    const events = await store.listEvents(jobId, after)

    return reply(res, 200, {
      job: toWireJob(job),
      events: events.map(toWireEvent),
    })
  }

  /**
   * GET /jobs[?status=&incidentId=&sessionId=&limit=] —— 当前用户的 job 列表（T10）。
   *
   * 两条硬约束：
   * 1. **`userId` 只能来自鉴权身份**，查询串里的 `userId` 被忽略——否则等于
   *    把 per-user 隔离交给客户端自觉。这是 T6 隔离在列表接口上的延续。
   * 2. **limit 必须有上限**，且默认值要小。列表接口是"值班台轮询"用的（SessionList
   *    每 3s 一次），放任 `?limit=100000` 会把整表拉出来打垮服务端。
   */
  async function handleListJobs(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    userId: string,
  ): Promise<void> {
    const statusParam = url.searchParams.get('status')
    const status =
      statusParam === null || statusParam === ''
        ? undefined
        : (statusParam as Job['status'])

    const jobs = await store.list({
      userId, // ← 强制取自身份，不读查询串
      status,
      incidentId: url.searchParams.get('incidentId') ?? undefined,
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      limit: parseLimit(url.searchParams.get('limit')),
    })

    return reply(res, 200, { jobs: jobs.map(toWireJob) })
  }

  /**
   * GET /jobs/:id/stream —— SSE 流式推事件。
   *
   * **【G5】事件源必须是 `JobStore`（生产即 PG `job_events`），不能是内存总线。**
   * 否则 job 跑在实例 A、SSE 连在实例 B 时，B 的内存总线里没有事件，前端会一直空转。
   * 这里用**轮询 `listEvents(after)`** 实现，天然跨实例正确；代价是几百毫秒延迟，
   * 对"看调查过程"够用（日后可用 PG LISTEN/NOTIFY 降延迟，接口不用改）。
   */
  async function handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    jobId: string,
    _url: URL,
    userId: string,
  ): Promise<void> {
    const job = await store.get(jobId)
    // 【T6】SSE 同样做归属校验：事件流里含工具调用细节与调查结论，越权订阅
    // 等于把别人的调查过程直接推到攻击者浏览器里。404 口径与 GET 一致。
    if (job === null || job.userId !== userId) {
      return reply(res, 404, { error: 'job not found' })
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-cache + no-transform：防反向代理缓冲住事件流（plan T9 部署注记）
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 nginx 的缓冲（有此头则按流式转发）
      'X-Accel-Buffering': 'no',
    })

    // 断线续传：优先 Last-Event-ID（浏览器自动带），退回 ?after=
    const lastEventId = req.headers['last-event-id']
    let cursor = parseSeq(
      Array.isArray(lastEventId) ? lastEventId[0] : lastEventId ?? _url.searchParams.get('after'),
    )

    let closed = false
    const onClose = (): void => {
      closed = true
    }
    req.on('close', onClose)

    const heartbeat = setInterval(() => {
      if (closed) return
      // SSE 注释行：维持连接、不产生事件（前端会忽略）
      res.write(': ping\n\n')
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()

    try {
      // 终态后不再等待新事件：把剩余事件吐完就收流，避免连接永久挂住。
      for (;;) {
        if (closed) break
        const events = await store.listEvents(jobId, cursor)
        for (const event of events) {
          if (closed) break
          cursor = event.seq
          res.write(`id: ${event.seq}\n`)
          res.write(`event: ${event.kind}\n`)
          res.write(`data: ${JSON.stringify(event.payload)}\n\n`)
        }

        const current = await store.get(jobId)
        if (current === null) break
        if (
          (current.status === 'completed' || current.status === 'failed') &&
          events.length === 0
        ) {
          break
        }
        if (closed) break
        await sleep(SSE_POLL_MS)
      }
    } finally {
      clearInterval(heartbeat)
      req.off('close', onClose)
      if (!closed) res.end()
    }
  }

  return {
    server,
    store,
    close: async (): Promise<void> => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { MAX_BODY_BYTES, SSE_HEARTBEAT_MS, SSE_POLL_MS }
