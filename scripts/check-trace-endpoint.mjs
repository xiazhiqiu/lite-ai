#!/usr/bin/env node
/**
 * 读路径联调自检 —— `GET /trace/:jobId` 的四轨汇总是否**真的**对得上。
 *
 * ## 与 `check-tracing.mjs` 的分工
 *
 *   - `check-tracing.mjs` 验**写**路径：span 有没有真的落到 Langfuse。
 *   - 本脚本验**读**路径：`/trace/:jobId` 汇总出的四轨引用，指过去能不能查到东西。
 *
 * 两者不重叠，也不能互相替代。**单测（`test/server-trace-endpoint.test.ts`）只能
 * 证明端点结构正确**，证明不了下面这件事：
 *
 *   同一 job 上，`identity.otelTraceId` 与 Langfuse 里实际存的 span 的 traceId
 *   是否一致 —— 即**两套 traceId 空间能不能在运行期 join 上**。
 *
 * 这正是最容易被"顺手统一"搞坏的地方（`tr-<jobId>` 可反解 vs `sha256(jobId)[:32]`
 * 不可反解，见 `observability/tracing.ts` 的注释），所以值得有个真机检查钉着。
 *
 * ## 用法
 *
 * 前置：一套跑着的 lite-ai 服务端（PG 后端，`/trace` 才能读到 A/D 轨）
 *       + 一套跑着的 Langfuse（`docker/observability/`，B 轨才有东西可查）。
 *
 *   export LITE_AI_BASE_URL=http://127.0.0.1:4180
 *   export LITE_AI_API_KEY=...
 *   export LANGFUSE_PUBLIC_KEY=pk-lf-...
 *   export LANGFUSE_SECRET_KEY=sk-lf-...
 *   export LANGFUSE_BASE_URL=http://127.0.0.1:3000
 *   npm run check:trace-endpoint
 *
 * 缺 Langfuse 凭据时**只跑 A/C/D 三轨断言**并提示 B 轨被跳过 —— 不静默降级成
 * "全通过"（那正是本仓反复踩的坑：配置没读到和真的没数据长得一样）。
 *
 * 退出码：0 = 全通过；1 = 有断言失败；2 = 环境/前置条件不满足。
 */
const BASE = (process.env.LITE_AI_BASE_URL ?? 'http://127.0.0.1:4180').replace(/\/$/, '')
const API_KEY = process.env.LITE_AI_API_KEY?.trim()
const LF_PUBLIC = process.env.LANGFUSE_PUBLIC_KEY?.trim()
const LF_SECRET = process.env.LANGFUSE_SECRET_KEY?.trim()
const LF_BASE = (process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com').replace(/\/$/, '')
const CHECK_LANGFUSE = Boolean(LF_PUBLIC && LF_SECRET)

if (!API_KEY) {
  console.error('缺少 LITE_AI_API_KEY（服务端启动时用的那个 bearer）。')
  process.exit(2)
}

const H = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 请求服务端并**把非 2xx 也当失败**。
 *
 * 不能只 `res.json()`：服务端出错时回的是 `{error:...}`，字段全 undefined，
 * 断言会以"某某字段为空"的形式失败，看着像产品 bug 而不是"根本没打通"。
 */
async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const lfAuth = 'Basic ' + Buffer.from(`${LF_PUBLIC}:${LF_SECRET}`).toString('base64')
async function lfApi(path) {
  const res = await fetch(`${LF_BASE}${path}`, { headers: { authorization: lfAuth } })
  const text = await res.text()
  if (res.status === 401) throw new Error(`Langfuse 凭据被拒（401）：key 是否属于 ${LF_BASE} 上的这个 project？`)
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  if (!pass) failures++
}

// ── 0. 前置探活：不先探活的话，下面的失败全是"连不上"而不是断言不成立 ──────
try {
  await api('/info')
} catch (error) {
  console.error(`服务端不可达（${BASE}）：${error.message}`)
  console.error('先起一个：node --import tsx src/index.ts --serve 4180')
  process.exit(2)
}

// ── 1. 造一个真实 chat job ────────────────────────────────────────────────
const created = await api('/chat', {
  method: 'POST',
  body: JSON.stringify({ message: '列出 checkout 命名空间的 pod' }),
})
const jobId = created.jobId ?? created.id
console.log(`\n[1] POST /chat -> jobId=${jobId} sessionId=${created.sessionId}`)
if (typeof jobId !== 'string' || jobId.length === 0) {
  console.error('未拿到 jobId：', JSON.stringify(created))
  process.exit(2)
}

// ── 2. 等 job 跑到终态 ────────────────────────────────────────────────────
// 终态取值以 `src/jobs/types.ts` 的 JobStatus 为准：
// 'pending' | 'running' | 'completed' | 'failed' —— 没有 succeeded / cancelled。
let job = null
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  const j = await api(`/jobs/${jobId}`)
  job = j.job ?? j
  if (['completed', 'failed'].includes(job?.status)) break
}
console.log(`[2] job 终态 status=${job?.status}`)
check('job 走到终态', ['completed', 'failed'].includes(job?.status), `status=${job?.status}`)

// ── 3. /trace/:jobId 四轨汇总 ─────────────────────────────────────────────
const trace = await api(`/trace/${jobId}`)
console.log(`[3] GET /trace/${jobId}`)
check('job 字段回填', trace.job?.id === jobId, `job.id=${trace.job?.id}`)
// 这条是**防"顺手统一两套 traceId"**的回归钉子，与单测里的 notEqual 同旨。
check(
  'identity 两套 traceId 并存且不等',
  typeof trace.identity?.auditTraceId === 'string' &&
    typeof trace.identity?.otelTraceId === 'string' &&
    trace.identity.auditTraceId !== trace.identity.otelTraceId,
  `${trace.identity?.auditTraceId} / ${trace.identity?.otelTraceId}`,
)
check('auditTraceId 可由 jobId 反解', trace.identity?.auditTraceId === `tr-${jobId}`, trace.identity?.auditTraceId)
check('identity 带 sessionId', trace.identity?.sessionId === created.sessionId, trace.identity?.sessionId)

const A = trace.tracks?.jobEvents
const D = trace.tracks?.usage
const B = trace.tracks?.langfuse
const C = trace.tracks?.metrics
console.log(`    A jobEvents: ${A?.events?.length} 条 (source=${A?.source})`)
console.log(`    D usage:     ${D?.records?.length} 条 (source=${D?.source})`)
console.log(`    B langfuse:  enabled=${B?.enabled} traceId=${B?.traceId}`)
console.log(`    C metrics:   available=${C?.available} reason=${C?.reason}`)

check('A 轨有事件', (A?.events?.length ?? 0) > 0, `${A?.events?.length}`)
check('D 轨有账本记录（每轮恰好一条）', (D?.records?.length ?? 0) >= 1, `${D?.records?.length}`)
check('B 轨如实回报 enabled + baseUrl', B?.enabled === true && typeof B?.baseUrl === 'string', `${B?.baseUrl}`)
check('B 轨 traceId == identity.otelTraceId', B?.traceId === trace.identity?.otelTraceId)
// C 轨**必须**如实说不可用：metrics.db 无 job 维度。这条防的是"为了好看硬填"。
check('C 轨诚实标注不可用', C?.available === false && typeof C?.reason === 'string', C?.reason)
check('D 轨记录全部绑到同一 jobId', (D?.records ?? []).every(r => r.jobId === jobId))

// ── 4. 拿 B 轨那个 traceId 去 Langfuse 真查 ───────────────────────────────
if (!CHECK_LANGFUSE) {
  console.log('\n[4] 跳过：未设 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY，B 轨无法反查。')
  console.log('    ⚠️ 上面 A/C/D 全过**不代表**B 轨没事，别把这次结果当全绿。')
} else {
  const traceId = trace.identity?.otelTraceId
  console.log(`[4] 用 traceId=${traceId} 反查 Langfuse…`)
  // 该端点默认只回 core+basic，model 与 usageDetails 得显式要。
  const FIELDS = 'core,basic,model,usage,trace_context'
  let obs = []
  let lastError = null
  for (let i = 0; i < 30; i++) {
    try {
      obs = (await lfApi(`/api/public/v2/observations?traceId=${traceId}&limit=50&fields=${FIELDS}`)).data ?? []
    } catch (error) {
      // Langfuse v4 起 legacy `/api/public/traces` 与 `/observations` 已下线，
      // 只有 `/api/public/v2/observations` 可用 —— 报错要说清是版本问题。
      lastError = error
      break
    }
    if (obs.length > 0) break
    process.stdout.write('.')
    await sleep(3000)
  }
  process.stdout.write('\n')
  if (lastError) {
    console.error(`    API 调用失败：${lastError.message}`)
    process.exit(2)
  }
  const byType = obs.reduce((m, o) => ((m[o.type] = (m[o.type] ?? 0) + 1), m), {})
  console.log(`    捞回 ${obs.length} 条：${JSON.stringify(byType)}`)
  check('Langfuse 里能查到本 job 的 span', obs.length > 0, `${obs.length}`)
  check('每条都挂在该 otelTraceId 下', obs.length > 0 && obs.every(o => o.traceId === traceId))
  // 这条同时证明 propagateAttributes 生效（只给 root 设属性的话子 span 上没有）。
  check(
    'session.id 与 /trace 回报的 sessionId 一致',
    obs.length > 0 && obs.every(o => o.sessionId === created.sessionId),
    obs[0]?.sessionId,
  )
  check('root span 为 job:chat', obs.some(o => o.isRootObservation === true && o.name === 'job:chat'))
}

if (failures === 0 && !CHECK_LANGFUSE) {
  console.log('\n=== 读路径自检通过（B 轨未验证）===')
} else if (failures === 0) {
  console.log('\n=== 读路径自检全部通过（含 B 轨跨轨 join）===')
} else {
  console.log(`\n=== 有 ${failures} 项失败 ===`)
}
process.exit(failures === 0 ? 0 : 1)
