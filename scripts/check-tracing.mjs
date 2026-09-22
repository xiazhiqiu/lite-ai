#!/usr/bin/env node
/**
 * B 轨（OTel span → Langfuse）联调自检 —— 起来一套自托管 Langfuse 之后跑它。
 *
 * ## 为什么需要这个脚本
 *
 * `createTracingSink()` 在无凭据时走 noop（`observability/tracing.ts` 纪律 1）。
 * 这是对的，但带来一个盲区：**"配置读到了"和"span 真的上去了"在日志里长得一样**
 * —— 启动时那行 `[tracing] Langfuse 已启用` 只证明凭据被解析出来了，不证明
 * OTLP 导出成功。开发时最容易踩的几种情况恰好都不会让启动失败：
 *
 *   - `LANGFUSE_BASE_URL` 拼错（少个下划线写成 `BASEURL` 会直接退化 noop，
 *     倒还好；写成别家的地址就静默丢数据）；
 *   - 自托管栈的 S3/MinIO 凭据没对齐 → 摄入端 500（**实测踩过**，
 *     报 `The Access Key Id you provided does not exist in our records.`）；
 *   - Langfuse 大版本换了读取 API → 数据在库里但你以为没上去。
 *
 * 所以这里**走一遍完整回路**：用生产同一份 sink 代码打一组 span →
 * 等异步导出落地 → 用 Langfuse 公开 API 把它们捞回来核对字段。
 *
 * ## 用法
 *
 *   export LANGFUSE_PUBLIC_KEY=pk-lf-...
 *   export LANGFUSE_SECRET_KEY=sk-lf-...
 *   export LANGFUSE_BASE_URL=http://localhost:3000
 *   npm run check:tracing
 *
 * 自托管栈见 `docker/observability/`。**不需要**跑 lite-ai 服务端：
 * 脚本自己起 sink，不会碰数据库 / 队列。
 *
 * 退出码：0 = 全通过；1 = 有断言失败；2 = 环境/凭据问题。
 */
import { randomUUID } from 'node:crypto'
import { createLangfuseTracingSink } from '../src/observability/langfuse-sink.js'
import { deriveTraceId } from '../src/observability/tracing.js'

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY?.trim()
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY?.trim()
const BASE_URL = (process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com').trim()

if (!PUBLIC_KEY || !SECRET_KEY) {
  console.error(
    '缺少 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY。\n' +
      '自托管栈的 key 在 docker/observability/.env 的 LANGFUSE_INIT_PROJECT_* 里。',
  )
  process.exit(2)
}

/**
 * jobId **每轮随机**。
 *
 * 曾经用固定 jobId（看着"便于反复核对同一个 traceId"），但那是错的：traceId 由
 * jobId 派生 = 固定，于是**上一轮留下的 observation 会和新一轮的混在同一个
 * traceId 下**，断言随机地在旧数据上失败（实测踩到：旧的 userId 是 `operator`、
 * 新的是 `check-tracing`，`find()` 拿到哪条全看排序）。随机 jobId 让每轮自成一条
 * trace，结论才可信。
 */
const JOB_ID = `job-${randomUUID()}`
const SESSION_ID = 'sin-check-tracing'
const TRACE_ID = deriveTraceId(JOB_ID)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 显式声明要哪些字段组。
 *
 * 该端点**默认只回 `core` + `basic`**（见其 OpenAPI：`fields` 默认
 * `core,basic`）—— 不写清楚就只能拿到 name/userId/sessionId，拿不到
 * model 与 usageDetails，于是"断言失败"其实是**请求没要**，而不是数据没上去。
 */
const FIELDS = 'core,basic,model,usage,trace_context'

const auth = 'Basic ' + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')

async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { authorization: auth } })
  const text = await res.text()
  if (res.status === 401) {
    throw new Error(`凭据被拒（401）。检查 key 是否属于 ${BASE_URL} 上的这个 project。`)
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const sink = await createLangfuseTracingSink({
  credentials: {
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    baseUrl: BASE_URL,
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? 'local',
    release: 'check-tracing',
  },
  log: (level, message) => console.log(`  [${level}] ${message}`),
})

console.log(`\n[1] sink.enabled=${sink.enabled}  baseUrl=${sink.baseUrl}`)
console.log(`[2] 派生 otelTraceId = ${TRACE_ID}`)

const trace = sink.startJobTrace({
  jobId: JOB_ID,
  kind: 'chat',
  sessionId: SESSION_ID,
  userId: 'check-tracing',
})
trace.toolStart('t1', 'kubectl_get_pods', { namespace: 'checkout' })
trace.toolEnd('t1', 'kubectl_get_pods', 'checkout-1  1/1 Running', false)
trace.generation({
  model: 'check-model',
  provider: 'check-provider',
  inputTokens: 1234,
  outputTokens: 321,
  totalTokens: 1555,
  latencyMs: 880,
})
trace.event('assistant_message', { text: '自检事件' })
trace.end({ status: 'ok', output: '自检完成' })

console.log('[3] flush + shutdown（关闭序列里最后一波 span 不能丢）')
await sink.flush()
await sink.shutdown()

// 异步 OTLP 导出 → 队列 → ClickHouse 落库，分钟级延迟是设计内的，所以要轮询。
console.log('[4] 轮询 Langfuse 直到这条 trace 可见（最多 ~90s）…')
let observations = []
for (let i = 0; i < 30; i++) {
  try {
    const page = await api(
      `/api/public/v2/observations?traceId=${TRACE_ID}&limit=50&fields=${FIELDS}`,
    )
    observations = page.data ?? []
  } catch (error) {
    // 端点不可用时给出**版本相关**的提示，而不是笼统报错：
    // Langfuse v4 起 legacy 的 /api/public/traces 与 /observations 已下线，
    // 只有 /api/public/v2/observations 可用。
    console.error(`    API 调用失败：${error.message}`)
    process.exit(2)
  }
  if (observations.length > 0) break
  process.stdout.write('.')
  await sleep(3000)
}
process.stdout.write('\n')

const byType = observations.reduce((m, o) => ((m[o.type] = (m[o.type] ?? 0) + 1), m), {})
console.log(`[5] 捞回 ${observations.length} 条 observation：${JSON.stringify(byType)}`)

const root = observations.find(o => o.type === 'SPAN')
const tool = observations.find(o => o.type === 'TOOL')
const generation = observations.find(o => o.type === 'GENERATION')
const event = observations.find(o => o.type === 'EVENT')

const checks = [
  ['traceId 与 deriveTraceId(jobId) 一致', observations.every(o => o.traceId === TRACE_ID)],
  ['root span 存在且名为 job:chat', root?.name === 'job:chat' && root?.isRootObservation === true],
  ['user.id 透传（trace 级属性）', observations.every(o => o.userId === 'check-tracing')],
  // 这条是 propagateAttributes 生效的证据：只给 root 设属性的话，子 span 上会是空。
  [
    'session.id 透传到**每个子 span**（propagateAttributes 生效）',
    observations.length > 1 && observations.every(o => o.sessionId === SESSION_ID),
  ],
  ['tool span 的父子关系正确', tool !== undefined && tool.parentObservationId === root?.id],
  // 注意：GENERATION 的模型名落在 `name`（该端点没有独立的 `model` 字段名占用），
  // 而 model 组回的是 `model`。两个都断，免得哪天只改了一边。
  ['generation 带模型名', generation?.name === 'check-model' && generation?.model === 'check-model'],
  ['generation 带 usageDetails', Number(generation?.usageDetails?.input) === 1234],
  ['event 类型正确', event?.name === 'assistant_message'],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) ok = false
}

if (!ok && observations.length === 0) {
  console.log(
    '\n提示：一条都没捞到。按这个顺序查 ——\n' +
      '  1) 启动日志里若出现 `[tracing] OTel 诊断：…`，那是导出端真报错了（本仓已把 OTel diag 接到 log）；\n' +
      '  2) 自托管栈看 `docker compose logs langfuse-web | grep -i s3`：\n' +
      '     事件 JSON 先落 S3/MinIO 再进队列，S3 凭据不对会 500 而 OTLP 端点本身返回错误码；\n' +
      '  3) `docker compose logs langfuse-worker` 确认它在消费 ingestion-queue。',
  )
}

console.log(ok ? '\n=== B 轨自检全部通过 ===' : '\n=== B 轨自检有失败 ===')
process.exit(ok ? 0 : 1)
