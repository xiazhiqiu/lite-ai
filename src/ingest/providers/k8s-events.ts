/**
 * Kubernetes Events 拉取 provider —— 吃下「K8s 事件与容器监控」这一类源。
 *
 * 为什么需要它（而不是靠 http-poll 配置化覆盖）：
 * - K8s Events 的检索面是 `fieldSelector` / `labelSelector`，**不是** http-poll 那种
 *   单次 REST 查询；分页靠 `metadata.continue` 游标，需要循环拉取。
 * - in-cluster 的 ServiceAccount token 是**文件且会轮换**，必须在每次 poll 时惰性读取。
 * - 事件需要客户端侧的时间窗过滤（Events 在 API 里保留约 1 小时，不过滤就会
 *   每次 poll 重放整段历史）。
 * 这三条都不是"改改配置路径"能达到的，因此单独立一个 provider。
 *
 * 字段语义映射（→ 统一 Alert）：
 * - `reason`            → `title`（K8s 里它就是告警名，如 BackOff / FailedScheduling / OOMKilling）
 * - `type=Warning`      → severity `warning`；`type=Normal` 默认**不入库**（Normal 是"正常记录"，
 *                         如 Scheduled/Pulled，不是告警；`includeNormal: true` 时按 info 收录）
 * - 对象 + 命名空间      → labels（`namespace` / `kind` / `involved` / `component` / `node`）
 * - `message`           → summary + description
 * - `count`             → description 里的**对数桶**（见 `bucketCount`），不进 labels
 *
 * 诚实边界：
 * - K8s Events **没有 resolved 语义**（事件被 API TTL 淘汰，不代表故障恢复），因此本层
 *   产出的告警恒为 `firing`；真正的收敛仍由注册表 TTL sweep 负责。
 * - 不解析 `series` 的完整语义，只取其 count；`eventTime` / `firstTimestamp` 两种
 *   时间字段都做了兼容。
 * - 不做 TLS 定制（自签 CA 请用 `NODE_EXTRA_CA_CERTS`），不引入 k8s 客户端 SDK。
 */
import { readFile } from 'node:fs/promises'

import { computeAlertId, normalizeSeverity, type Alert } from '../../webhook/types.js'
import { asRecord, asIso, labelsToDescription } from '../../webhook/sources/util.js'
import type { FetchLike } from '../../webhook/topology.js'
import { DEFAULT_REQUEST_TIMEOUT_MS, requestJson } from './http-util.js'

/** in-cluster 默认 API Server（ServiceAccount 挂载的 DNS 名）。 */
export const DEFAULT_K8S_API_SERVER = 'https://kubernetes.default.svc'

/** in-cluster ServiceAccount token 的标准挂载路径。 */
export const DEFAULT_K8S_TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token'

/**
 * 默认只看最近 5 分钟内仍活跃的事件 —— 与 `correlate.ts` 的关联窗口（5 分钟）对齐，
 * 保证「拉取到的都还在同一个关联窗内」。设为 `0` 可关闭过滤。
 */
export const DEFAULT_K8S_LOOKBACK_MS = 5 * 60 * 1000

/** 分页上限（默认 3 页 × 500 条）。超出即视为"过滤条件不足"，抛错提示而非静默截断。 */
export const DEFAULT_K8S_MAX_PAGES = 3

const K8S_PAGE_LIMIT = 500

export type K8sEventsConfig = {
  /** provider 名，写入 `Alert.source` */
  name: string
  /** API Server 地址；缺省 `https://kubernetes.default.svc` */
  apiServer?: string
  /** ServiceAccount token（优先级最高，便于本机调试用 `kubectl proxy` + 空 token） */
  token?: string
  /**
   * token 文件路径；缺省不读。in-cluster 场景建议设为 `DEFAULT_K8S_TOKEN_FILE`。
   * **每次 poll 惰性读取**：SA token 会轮换，启动时缓存会让长跑进程在某次轮换后 401。
   */
  tokenFile?: string
  /** 限定命名空间；缺省全集群（`/api/v1/events`） */
  namespace?: string
  /** 附加 labelSelector，如 `app=payments` */
  labelSelector?: string
  /** fieldSelector；缺省 `type!=Normal`（`includeNormal: true` 时不加） */
  fieldSelector?: string
  /** 是否把 Normal 事件也当告警收录（默认 false） */
  includeNormal?: boolean
  /** 只看最近 N 毫秒内活跃的事件（默认 5 分钟；0 = 不过滤） */
  lookbackMs?: number
  /** 按 reason 覆盖严重度，如 `{ OOMKilling: 'critical', BackOff: 'warning' }` */
  severityByReason?: Record<string, string>
  /** 按 reason 屏蔽（默认为空 —— **不默认静默丢弃任何事件**，避免掩盖真问题） */
  ignoreReasons?: string[]
  /** 固定附加标签（如 `service` / `env`），用于与其它源对齐关联维度 */
  staticLabels?: Record<string, string>
  /** 额外请求头 */
  headers?: Record<string, string>
  /** 拉取周期（毫秒）；K8s Events 变化快，建议比云监控更短 */
  intervalMs?: number
  timeoutMs?: number
  /** 分页上限（默认 3 页） */
  maxPages?: number
  /** 可注入 fetch（测试用本地 stub，零外网依赖） */
  fetchImpl?: FetchLike
  /** 可注入 token 文件读取（测试用，避免真读盘） */
  readFileImpl?: (path: string) => Promise<string>
}

/**
 * 构造 Events 列表 URL（纯函数，便于单测）。
 *
 * 路径选择：限定 namespace 走 `/api/v1/namespaces/{ns}/events`，否则全集群 `/api/v1/events`。
 * 缺省 fieldSelector `type!=Normal` 让**服务端**先过滤掉绝大多数噪音，减少分页压力。
 */
export function buildEventsUrl(cfg: K8sEventsConfig, continueToken?: string): string {
  const base = (cfg.apiServer ?? DEFAULT_K8S_API_SERVER).replace(/\/+$/, '')
  const namespace = typeof cfg.namespace === 'string' ? cfg.namespace.trim() : ''
  const path =
    namespace === ''
      ? '/api/v1/events'
      : `/api/v1/namespaces/${encodeURIComponent(namespace)}/events`

  const params = new URLSearchParams()
  const fieldSelector =
    cfg.fieldSelector ?? (cfg.includeNormal === true ? undefined : 'type!=Normal')
  if (typeof fieldSelector === 'string' && fieldSelector.trim() !== '') {
    params.set('fieldSelector', fieldSelector.trim())
  }
  if (typeof cfg.labelSelector === 'string' && cfg.labelSelector.trim() !== '') {
    params.set('labelSelector', cfg.labelSelector.trim())
  }
  params.set('limit', String(K8S_PAGE_LIMIT))
  if (typeof continueToken === 'string' && continueToken !== '') {
    params.set('continue', continueToken)
  }
  return `${base}${path}?${params.toString()}`
}

/**
 * 把 `count` 归到**对数桶**。
 *
 * 动机：`count` 直接进 description 会让崩溃重启循环的 Pod 每轮 poll 都产生新的内容哈希，
 * 被 Keep 双层去重判为 `updated` → **每个周期重烧一次 token**（重复的是同一结论）。
 * 对数桶让"单纯累加"不改变哈希，而"量级跃升"（1 → 500 次）才构成新信号。
 */
export function bucketCount(count: number): string {
  if (!Number.isFinite(count) || count <= 1) return '1'
  if (count <= 5) return '2-5'
  if (count <= 20) return '6-20'
  if (count <= 100) return '21-100'
  if (count <= 1000) return '101-1000'
  return '>1000'
}

/** 取事件时间：兼容 v1 的 firstTimestamp / eventTime / series，最后退到创建时间。 */
function eventStartIso(item: Record<string, unknown>, meta: Record<string, unknown>, fallbackIso: string): string {
  return (
    asIso(item.firstTimestamp, '') ||
    asIso(item.eventTime, '') ||
    asIso(asRecord(item.series).lastObservedTime, '') ||
    asIso(meta.creationTimestamp, '') ||
    fallbackIso
  )
}

/** 取事件最近一次出现的时间（时间窗过滤用）；字段缺失时退到 startsAt。 */
function eventLastSeenIso(item: Record<string, unknown>, meta: Record<string, unknown>, fallbackIso: string): string {
  return (
    asIso(item.lastTimestamp, '') ||
    asIso(item.eventTime, '') ||
    asIso(asRecord(item.series).lastObservedTime, '') ||
    asIso(meta.creationTimestamp, '') ||
    fallbackIso
  )
}

function numericOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * 纯函数：把 K8s `EventList` 解析成统一 `Alert[]`（不联网，便于单测）。
 *
 * @param nowMs 当前时间（显式传入，保证时间窗过滤可测）
 */
export function parseK8sEventList(
  payload: unknown,
  cfg: K8sEventsConfig,
  nowMs: number,
): Alert[] {
  const items = asRecord(payload).items
  if (!Array.isArray(items)) {
    throw new Error(
      `${cfg.name} 拉取失败: 响应缺少 items 数组（返回的不是 K8s EventList？）`,
    )
  }

  const includeNormal = cfg.includeNormal === true
  const lookbackMs = cfg.lookbackMs ?? DEFAULT_K8S_LOOKBACK_MS
  const ignore = new Set(cfg.ignoreReasons ?? [])
  const severityByReason = cfg.severityByReason ?? {}
  const nowIso = new Date(nowMs).toISOString()
  const alerts: Alert[] = []

  for (const raw of items) {
    const item = asRecord(raw)
    const type = typeof item.type === 'string' ? item.type.trim() : ''

    // Normal 是"正常记录"（Scheduled / Pulled / Created ...），不是告警。
    if (type === 'Normal' && !includeNormal) continue

    const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
    // 没有 reason 的条目无法作为告警名（对齐 http-poll「无 title 即跳过」）。
    if (reason === '') continue
    if (ignore.has(reason)) continue

    const meta = asRecord(item.metadata)
    const involved = asRecord(item.involvedObject)
    const involvedKind = typeof involved.kind === 'string' ? involved.kind.trim() : ''
    const involvedName = typeof involved.name === 'string' ? involved.name.trim() : ''
    const namespace =
      (typeof meta.namespace === 'string' ? meta.namespace.trim() : '') ||
      (typeof involved.namespace === 'string' ? involved.namespace.trim() : '')

    const startsAt = eventStartIso(item, meta, nowIso)
    // 时间窗过滤：Events 在 API 里保留约 1 小时，不过滤会导致每轮 poll 重放整段历史。
    if (lookbackMs > 0) {
      const lastSeen = Date.parse(eventLastSeenIso(item, meta, nowIso))
      if (Number.isFinite(lastSeen) && lastSeen < nowMs - lookbackMs) continue
    }

    const labels: Record<string, string> = { ...(cfg.staticLabels ?? {}) }
    if (namespace !== '') labels.namespace = namespace
    if (involvedKind !== '') labels.kind = involvedKind
    if (involvedKind !== '' && involvedName !== '') {
      labels.involved = `${involvedKind}/${involvedName}`
    }
    const source = asRecord(item.source)
    const component =
      (typeof source.component === 'string' ? source.component.trim() : '') ||
      (typeof item.reportingComponent === 'string' ? item.reportingComponent.trim() : '')
    if (component !== '') labels.component = component
    const node = typeof source.host === 'string' ? source.host.trim() : ''
    if (node !== '') labels.node = node

    const rawSeverity =
      severityByReason[reason] ?? (type === 'Normal' ? 'info' : 'warning')
    const count = numericOf(item.count) || numericOf(asRecord(item.series).count) || 1
    const message = typeof item.message === 'string' ? item.message.trim() : ''
    const summary = message.split('\n')[0]?.trim() ?? ''
    const evidence = [
      message,
      involvedKind !== '' && involvedName !== ''
        ? `对象 ${involvedKind}/${involvedName}${namespace === '' ? '' : ` (ns ${namespace})`}`
        : '',
      `type=${type === '' ? 'Unknown' : type}`,
      `累计 ${bucketCount(count)} 次`,
      component === '' ? '' : `组件 ${component}`,
    ]
      .filter(part => part !== '')
      .join(' | ')

    alerts.push({
      id: computeAlertId(reason, labels),
      title: reason,
      severity: normalizeSeverity(rawSeverity),
      source: cfg.name,
      summary: summary === '' ? labelsToDescription(labels) : summary,
      description: evidence === '' ? labelsToDescription(labels) : evidence,
      labels,
      startsAt,
      // K8s Events 无 resolved 语义（被 TTL 淘汰 ≠ 恢复），恒为 firing。
      status: 'firing',
    })
  }

  return alerts
}

/** 分页拉取：跟随 `metadata.continue` 直到取尽或达到 `maxPages`。 */
async function fetchAllPages(
  cfg: K8sEventsConfig,
  token: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const maxPages = cfg.maxPages ?? DEFAULT_K8S_MAX_PAGES
  const pages: unknown[] = []
  let continueToken = ''
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    ...(cfg.headers ?? {}),
  }

  for (let page = 0; page < maxPages; page++) {
    const payload = await requestJson({
      owner: cfg.name,
      url: buildEventsUrl(cfg, continueToken),
      headers,
      timeoutMs,
      fetchImpl,
      signal,
    })
    pages.push(payload)
    const next = asRecord(asRecord(payload).metadata).continue
    continueToken = typeof next === 'string' ? next : ''
    if (continueToken === '') return pages
  }

  // 取满 maxPages 仍有后续 → 过滤条件不足以覆盖当前事件量。**抛错而非静默截断**：
  // "少看了一部分事件"如果静默发生，运维会以为"今天告警就是少"。
  throw new Error(
    `${cfg.name} 拉取被截断: 事件数超过 ${maxPages} 页 × ${K8S_PAGE_LIMIT} 条，` +
      `请用 namespace / labelSelector 收窄范围或调大 maxPages`,
  )
}

/** K8s Events 拉取 provider。 */
export class K8sEventsProvider {
  readonly name: string
  readonly intervalMs?: number

  private readonly cfg: K8sEventsConfig
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike
  private readonly readFileImpl: (path: string) => Promise<string>

  constructor(cfg: K8sEventsConfig) {
    this.cfg = cfg
    this.name = cfg.name
    this.intervalMs = cfg.intervalMs
    // 与 topology.ts 的 K8sTopologySource 保持同一优先级：显式 token > env。
    this.token = cfg.token ?? process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN ?? ''
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init))
    this.readFileImpl = cfg.readFileImpl ?? (path => readFile(path, 'utf8'))
  }

  /** 惰性解析 token：显式 token > env > tokenFile（每次 poll 读，兼容 token 轮换）。 */
  private async resolveToken(): Promise<string> {
    if (this.token !== '') return this.token
    const file = this.cfg.tokenFile
    if (typeof file !== 'string' || file.trim() === '') return ''
    return (await this.readFileImpl(file)).trim()
  }

  async poll(signal?: AbortSignal): Promise<Alert[]> {
    const token = await this.resolveToken()
    if (token === '') {
      // 明确报错而非静默 0 条：拉取源"没有告警"和"没跑起来"必须能区分。
      throw new Error(
        `${this.name} 缺少 token（配置 token / env KUBERNETES_SERVICE_ACCOUNT_TOKEN / tokenFile 三者至少一个）`,
      )
    }
    const pages = await fetchAllPages(this.cfg, token, this.fetchImpl, this.timeoutMs, signal)
    const nowMs = Date.now()
    return pages.flatMap(page => parseK8sEventList(page, this.cfg, nowMs))
  }
}

/** 按配置创建；缺少 name 时返回 null（该源静默不启用，与其它 provider 工厂一致）。 */
export function createK8sEventsProvider(cfg: K8sEventsConfig): K8sEventsProvider | null {
  if (typeof cfg?.name !== 'string' || cfg.name.trim() === '') return null
  return new K8sEventsProvider({ ...cfg, name: cfg.name.trim() })
}
