/**
 * 通用 REST 拉取 provider：**一份实现覆盖一大类"能查 REST 但不会推"的告警源**。
 *
 * 适用：Zabbix API / ELK / Loki / Splunk 查询接口 / 云监控 OpenAPI / 业务自建告警查询 ...
 * 只要目标接口能用「请求 URL + 可选 headers/body」拉到一段 JSON，且能用**路径**定位
 * 到告警数组与各字段，就不需要为它单独写适配器（对齐 Keep 的 provider 配置化思路）。
 *
 * 设计取舍：
 * - **零新增依赖**：用内置 `fetch`，不引入任何云厂商 SDK（否则每接一个云就拖一个 SDK）。
 *   云厂商私有签名（AWS SigV4 / 华为云 HMAC）不在本版范围 —— 退路是让 sidecar/脚本
 *   拉取后 POST 到 `/webhook`（此时走 push 适配器，链路完全一致）。
 * - **失败必须上抛**：网络错误 / 非 2xx / 非 JSON / 结构不符都**抛错**，由调度器捕获后
 *   `warn` 并跳过本轮。在这里静默吞掉会让"源挂了"表现为"今天没有告警"，是最危险的故障模式。
 * - **条目级容错**：单条记录缺 title 时**跳过该条**而非整批失败（一条脏数据不该吃掉整批告警）。
 */
import {
  DEFAULT_SEVERITY,
  computeAlertId,
  normalizeSeverity,
  type Alert,
} from '../../webhook/types.js'
// 复用告警源适配器的宽松取值助手：拉取源的字段类型同样不可信（数字/嵌套/缺失），
// 且必须与 push 侧保持同一套归一化语义（如 toAlertStatus 的"未知状态按 firing"）。
import {
  asRecord,
  asIso,
  labelsToDescription,
  scalarToString,
  toAlertStatus,
} from '../../webhook/sources/util.js'
import type { FetchLike } from '../../webhook/topology.js'
// 请求逻辑与 k8s-events 共用（第二份拷贝即抽取阈值，见 http-util.ts 的说明）。
import { DEFAULT_REQUEST_TIMEOUT_MS, requestJson } from './http-util.js'

/** 字段映射：把源里的字段名/路径映射到统一 Alert 字段。 */
export type HttpPollMap = {
  /** 告警名（**必填**）——取不到即视为该条不是告警而跳过 */
  title: string
  /** 严重度（会经 normalizeSeverity 归一化，如 Zabbix 的 disaster/average） */
  severity?: string
  summary?: string
  description?: string
  /** 触发时间（ISO 或可被 Date.parse 解析的字符串） */
  startsAt?: string
  /** 状态字段（resolved 词表见 toAlertStatus；未知状态按 firing） */
  status?: string
  /**
   * labels 取值路径列表。label 键 = 路径**最后一段**
   * （`"host.host"` → 键 `host`），避免各源是嵌套结构时键名冗长。
   */
  labelsFrom?: string[]
}

export type HttpPollConfig = {
  /** provider 名，写入 `Alert.source` */
  name: string
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** POST 请求体（对象会被 JSON 序列化），如 Zabbix 的 api_jsonrpc 调用参数 */
  body?: unknown
  /**
   * 从响应体中取出告警数组的路径，点号分隔，如 `result` / `data.alerts` / `hits.hits`。
   * 留空表示响应体**顶层就是数组**。取到的不是数组 → 抛错（让配置错误立刻暴露）。
   */
  itemsPath?: string
  map: HttpPollMap
  /** 固定附加标签（如 `env=prod`），与 labelsFrom 合并；labelsFrom 优先级更高 */
  staticLabels?: Record<string, string>
  /** 拉取周期（毫秒），缺省由调度器用全局默认值 60s */
  intervalMs?: number
  timeoutMs?: number
  /** 可注入 fetch（测试用本地 stub，零外网依赖） */
  fetchImpl?: FetchLike
}

/** 按点号路径取值；路径为空返回原值。任一段不存在返回 undefined（不抛错）。 */
export function getByPath(root: unknown, path: string): unknown {
  const trimmed = path.trim()
  if (trimmed === '') return root
  let current: unknown = root
  for (const segment of trimmed.split('.')) {
    if (segment === '') continue
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    current = asRecord(current)[segment]
    if (current === undefined) return undefined
  }
  return current
}

/** label 键 = 路径最后一段（`a.b` → `b`）。 */
function labelKeyOf(path: string): string {
  const segments = path.split('.').filter(s => s !== '')
  return segments.length > 0 ? segments[segments.length - 1]! : path
}

function buildLabels(record: Record<string, unknown>, cfg: HttpPollConfig): Record<string, string> {
  // 先放固定标签，再让 labelsFrom 覆盖（显式取值优先于静态默认）。
  const labels: Record<string, string> = { ...(cfg.staticLabels ?? {}) }
  for (const path of cfg.map.labelsFrom ?? []) {
    const value = scalarToString(getByPath(record, path))
    if (value !== '') labels[labelKeyOf(path)] = value
  }
  return labels
}

/**
 * 纯函数：把拉取到的 JSON 响应按配置解析成统一 `Alert[]`（不联网，便于单测）。
 */
export function parseHttpPollItems(payload: unknown, cfg: HttpPollConfig): Alert[] {
  const itemsPath = cfg.itemsPath ?? ''
  const items = getByPath(payload, itemsPath)
  if (!Array.isArray(items)) {
    throw new Error(
      `${cfg.name} 拉取失败: 响应中 "${itemsPath === '' ? '(顶层)' : itemsPath}" 不是数组，请检查 itemsPath 配置`,
    )
  }

  const nowIso = new Date().toISOString()
  const alerts: Alert[] = []

  for (const item of items) {
    const record = asRecord(item)
    const title = scalarToString(getByPath(record, cfg.map.title)).trim()
    // 无标题的条目不是告警（可能是分页元数据等）：跳过该条，不影响整批。
    if (title === '') continue

    const labels = buildLabels(record, cfg)
    const rawSeverity =
      cfg.map.severity !== undefined
        ? scalarToString(getByPath(record, cfg.map.severity)).trim()
        : ''
    const status =
      cfg.map.status !== undefined ? toAlertStatus(getByPath(record, cfg.map.status)) : 'firing'

    // resolved 不再丢弃：交由 `IngestPipeline` 走事件收敛路径（关闭事件、不触发 RCA），
    // 与 push 适配器保持一致（T6 落地）。

    const summary =
      cfg.map.summary !== undefined ? scalarToString(getByPath(record, cfg.map.summary)) : ''
    const descriptionRaw =
      cfg.map.description !== undefined
        ? scalarToString(getByPath(record, cfg.map.description))
        : ''
    const startsAt =
      cfg.map.startsAt !== undefined
        ? asIso(getByPath(record, cfg.map.startsAt), nowIso)
        : nowIso

    alerts.push({
      id: computeAlertId(title, labels),
      title,
      severity: rawSeverity === '' ? DEFAULT_SEVERITY : normalizeSeverity(rawSeverity),
      source: cfg.name,
      summary: summary || labelsToDescription(labels),
      description: descriptionRaw || labelsToDescription(labels),
      labels,
      startsAt,
      status,
    })
  }

  return alerts
}

/** 通用 REST 拉取 provider。 */
export class HttpPollProvider {
  readonly name: string
  readonly intervalMs?: number

  private readonly cfg: HttpPollConfig
  private readonly method: 'GET' | 'POST'
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(cfg: HttpPollConfig) {
    this.cfg = cfg
    this.name = cfg.name
    this.intervalMs = cfg.intervalMs
    this.method = cfg.method ?? 'GET'
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init))
    this.headers = {
      accept: 'application/json',
      ...(this.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(cfg.headers ?? {}),
    }
  }

  async poll(signal?: AbortSignal): Promise<Alert[]> {
    const payload = await this.loadPayload(signal)
    return parseHttpPollItems(payload, this.cfg)
  }

  /**
   * 发请求并取 JSON。超时 / 进程关停取消 / 非 2xx / 非 JSON 的可区分错误
   * 统一由 `http-util.ts` 的 `requestJson` 负责（与 k8s-events 共用同一实现）。
   */
  private async loadPayload(signal?: AbortSignal): Promise<unknown> {
    return requestJson({
      owner: this.name,
      url: this.cfg.url,
      method: this.method,
      headers: this.headers,
      body: this.cfg.body,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      signal,
    })
  }
}

/** 按配置创建；配置不完整返回 null（该源静默不启用，与 createTopologySource 同构）。 */
export function createHttpPollProvider(cfg: HttpPollConfig): HttpPollProvider | null {
  if (typeof cfg.url !== 'string' || cfg.url.trim() === '') return null
  if (typeof cfg.map?.title !== 'string' || cfg.map.title.trim() === '') return null
  const name =
    typeof cfg.name === 'string' && cfg.name.trim() !== '' ? cfg.name.trim() : 'httpPoll'
  return new HttpPollProvider({ ...cfg, url: cfg.url.trim(), name })
}
