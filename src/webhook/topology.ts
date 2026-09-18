/**
 * L2 拓扑关联层（AIOps 关联规则④）——确定性图算法，零 LLM。
 *
 * 定位：叠在 correlate.ts 的规则①②③之上，专门回收它们"漏网的单例"。
 * 规则①按"标签相等"判同组，无法跨越标签不同的服务；④改按"图距离 / 业务归属"判同组，
 * 于是能把 `mysql` / `elasticsearch` / `apm` 这三个标签互不相同的服务，
 * 因"同属一个业务应用"或"在调用链上互为邻居"而并成同一个 Incident。
 *
 * 设计红线（延续项目"确定性引擎 + LLM 受限叶子"）：
 * - 图来源**可插拔**（`TopologySource`），算法与来源解耦：换源不改规则。
 * - **默认关闭**：无可信拓扑数据就不启用（对齐 Keep Topology Processor 的工程克制）。
 *   手写 CMDB 在企业里 80% 不准确（Gartner），不可信的图会"瞎猜"出错误合并，比漏关联更危险。
 * - 只处理"①② 未并组的单例"，**绝不动已并好的规则事件**，避免二次误并。
 * - 图缺失 / 拉取失败 → 降级为"仅规则关联"，绝不因拓扑故障影响诊断。
 *
 * 两类互补的图（都可接）：
 * | 来源 | 提供什么 | 对应 Keep 的哪一层 |
 * |---|---|---|
 * | k8s | **归属**：workload → application（label 推导） | 正是 L2 的"service → application 归属" |
 * | SkyWalking | **调用边**：谁调谁（Exit span peer ↔ Entry span service） | 更细的依赖图，用于跨服务因果 |
 *
 * 诚实边界：
 * - ④ 只在"图覆盖到相关服务"时生效；未追踪/未纳管的服务救不了。
 * - 拓扑主键必须与告警标签对齐，否则"图有、告警对不上"，形同虚设 —— 用 `aliases` 映射。
 * - 图是数据绑定，不是代码绑定：没有可信图，这层就是关着的。
 */
import type { Alert } from './types.js'

/** 可注入的 fetch（便于单测在不联网的情况下验证解析与请求构造）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 默认 BFS 最大跳数（Keep / 业界拓扑关联普遍取 1~2 跳）。 */
export const DEFAULT_TOPOLOGY_MAX_HOPS = 2

/** 告警中用于对齐图节点的标签键，按优先级取第一个非空。 */
export const DEFAULT_TOPOLOGY_SERVICE_KEYS = ['service', 'job', 'app']

/* ------------------------------------------------------------------ *
 * 图模型（与来源无关）
 * ------------------------------------------------------------------ */

export type DependencyGraph = {
  /** 图来源标识（static / k8s / skywalking） */
  source: string
  /** 无向邻接表：service → 相邻 service（来自运行时调用边） */
  edges: Record<string, string[]>
  /** 归属映射：service → application（来自 k8s，同属一个业务应用即同组） */
  applications: Record<string, string>
  /** 告警 service 名 → 图节点名 的别名映射（拓扑主键对齐，最大的坑） */
  aliases: Record<string, string>
  /** BFS 最大跳数 */
  maxHops: number
}

export type GraphSpec = {
  source?: string
  /** 有向输入，构建时视为无向 */
  edges?: Record<string, readonly string[]>
  applications?: Record<string, string>
  aliases?: Record<string, string>
  maxHops?: number
}

export function createGraph(spec: GraphSpec = {}): DependencyGraph {
  const edges: Record<string, string[]> = {}
  const addEdge = (from: string, to: string): void => {
    if (from === '' || to === '' || from === to) return
    const list = edges[from] ?? []
    if (!list.includes(to)) list.push(to)
    edges[from] = list
  }
  for (const [from, targets] of Object.entries(spec.edges ?? {})) {
    for (const to of targets) {
      addEdge(from, to)
      addEdge(to, from)
    }
  }
  const maxHops =
    typeof spec.maxHops === 'number' && spec.maxHops > 0
      ? Math.floor(spec.maxHops)
      : DEFAULT_TOPOLOGY_MAX_HOPS
  return {
    source: spec.source ?? 'unknown',
    edges,
    applications: { ...(spec.applications ?? {}) },
    aliases: { ...(spec.aliases ?? {}) },
    maxHops,
  }
}

/** 告警 service 名 → 图节点名。别名映射用于解决两套命名不一致（如 `payment-app` vs `payments`）。 */
export function resolveNode(graph: DependencyGraph, service: string): string {
  return graph.aliases[service] ?? service
}

export function graphNeighbors(graph: DependencyGraph, service: string): string[] {
  return graph.edges[resolveNode(graph, service)] ?? []
}

/** 查归属：同属一个 application 即为"同一业务"。 */
export function applicationOf(
  graph: DependencyGraph,
  service: string,
): string | undefined {
  const node = resolveNode(graph, service)
  return graph.applications[node] ?? graph.applications[service]
}

/** BFS 最短跳数；超出 maxHops 或不可达返回 Infinity。 */
export function graphHops(
  graph: DependencyGraph,
  from: string,
  to: string,
): number {
  const start = resolveNode(graph, from)
  const goal = resolveNode(graph, to)
  if (start === goal) return 0

  const seen = new Set<string>([start])
  let frontier: string[] = [start]
  for (let depth = 1; depth <= graph.maxHops; depth += 1) {
    const next: string[] = []
    for (const node of frontier) {
      for (const neighbor of graph.edges[node] ?? []) {
        if (seen.has(neighbor)) continue
        if (neighbor === goal) return depth
        seen.add(neighbor)
        next.push(neighbor)
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return Number.POSITIVE_INFINITY
}

/** 两个 service 是否可关联：同 application（业务归属）或图距离 ≤ maxHops（调用链邻居）。 */
export function servicesRelated(
  graph: DependencyGraph,
  a: string,
  b: string,
): boolean {
  if (a === '' || b === '') return false
  const appA = applicationOf(graph, a)
  if (appA !== undefined && appA === applicationOf(graph, b)) return true
  return Number.isFinite(graphHops(graph, a, b))
}

/** 合并多张图（k8s 给归属 + SkyWalking 给调用边，可同时接）。后者覆盖前者的同键映射。 */
export function mergeGraphs(graphs: readonly DependencyGraph[]): DependencyGraph {
  const edges: Record<string, readonly string[]> = {}
  const applications: Record<string, string> = {}
  const aliases: Record<string, string> = {}
  const sources: string[] = []
  let maxHops = DEFAULT_TOPOLOGY_MAX_HOPS
  for (const graph of graphs) {
    for (const [from, targets] of Object.entries(graph.edges)) {
      edges[from] = [...(edges[from] ?? []), ...targets]
    }
    Object.assign(applications, graph.applications)
    Object.assign(aliases, graph.aliases)
    sources.push(graph.source)
    maxHops = Math.max(maxHops, graph.maxHops)
  }
  return createGraph({ source: sources.join('+'), edges, applications, aliases, maxHops })
}

/** 从告警标签解析 service 身份（拓扑主键）。全部缺失返回 null（不参与拓扑关联）。 */
export function resolveAlertService(
  alert: Alert,
  serviceKeys: string[] = DEFAULT_TOPOLOGY_SERVICE_KEYS,
): string | null {
  for (const key of serviceKeys) {
    const value = alert.labels?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 规则④ 本体：对"①② 漏网单例"做图关联
 * ------------------------------------------------------------------ */

export type TopologyCluster = {
  /** 分组键（展示用），形如 `application=payments` 或 `topology=mysql+elasticsearch` */
  groupKey: string
  /** incident id 派生身份（含成员 service 集合，保证时间窗切分后仍不撞 id） */
  identity: string
  members: Alert[]
  /** 命中的业务归属（无归属时为 undefined） */
  application?: string
}

export type TopologyClusterOptions = {
  serviceKeys: string[]
  windowMs: number
  minAlerts: number
}

/** 时间窗判定：两边时间戳都可解析时要求 |Δ| ≤ windowMs；缺失时间戳时仅凭图关系判断。 */
function withinWindow(a: Alert, b: Alert, windowMs: number): boolean {
  const ta = Date.parse(a.startsAt)
  const tb = Date.parse(b.startsAt)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true
  return Math.abs(ta - tb) <= windowMs
}

/**
 * 对"单例"告警做拓扑聚类：
 * 两条单例若 **图相关（同 application 或 ≤ maxHops 邻居）** 且 **时间窗相近**，归入同一簇。
 * 多跳链用并查集传递合并（A—B—C 全收）。
 *
 * 复杂度 O(n²)：单例数受批处理护栏 `MAX_ALERTS_PER_BATCH`（默认 200）约束，代价可忽略。
 */
export function clusterByTopology(
  singles: readonly Alert[],
  graph: DependencyGraph,
  opts: TopologyClusterOptions,
): TopologyCluster[] {
  const resolved: Array<{ alert: Alert; service: string }> = []
  for (const alert of singles) {
    const service = resolveAlertService(alert, opts.serviceKeys)
    if (service !== null) resolved.push({ alert, service })
  }
  if (resolved.length < opts.minAlerts) return []

  const parent = resolved.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    let cursor = index
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]!
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (i: number, j: number): void => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[rj] = ri
  }

  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      if (!servicesRelated(graph, resolved[i]!.service, resolved[j]!.service)) continue
      if (!withinWindow(resolved[i]!.alert, resolved[j]!.alert, opts.windowMs)) continue
      union(i, j)
    }
  }

  const buckets = new Map<number, Array<{ alert: Alert; service: string }>>()
  for (let i = 0; i < resolved.length; i += 1) {
    const root = find(i)
    const list = buckets.get(root)
    if (list) list.push(resolved[i]!)
    else buckets.set(root, [resolved[i]!])
  }

  const clusters: TopologyCluster[] = []
  for (const members of buckets.values()) {
    if (members.length < opts.minAlerts) continue
    const services = [...new Set(members.map(m => m.service))].sort()

    // 归属优先：整簇同属一个 application 时，语义最清晰（"同一业务被拖垮"）。
    let application: string | undefined
    const apps = members
      .map(m => applicationOf(graph, m.service))
      .filter((app): app is string => app !== undefined)
    if (apps.length === members.length && new Set(apps).size === 1) {
      application = apps[0]
    }

    const groupKey =
      application !== undefined
        ? `application=${application}`
        : `topology=${services.join('+')}`
    clusters.push({
      groupKey,
      identity: `${groupKey}|${services.join('+')}`,
      members: members.map(m => m.alert),
      application,
    })
  }

  // 稳定排序：先按成员数降序，再按分组键，保证结果可复现。
  clusters.sort((a, b) =>
    b.members.length - a.members.length || a.groupKey.localeCompare(b.groupKey),
  )
  return clusters
}

/* ------------------------------------------------------------------ *
 * 图来源（可插拔）
 * ------------------------------------------------------------------ */

export interface TopologySource {
  readonly name: string
  /** 拉取依赖图。失败时抛错，由调用方降级（绝不因拓扑故障影响诊断）。 */
  load(): Promise<DependencyGraph>
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** 静态图：**仅用于 demo / 单测**，企业里手写 CMDB 不可信（Gartner: 80% 项目无业务价值）。 */
export class StaticTopologySource implements TopologySource {
  readonly name = 'static'
  constructor(private readonly spec: GraphSpec) {}
  async load(): Promise<DependencyGraph> {
    return createGraph({ ...this.spec, source: 'static' })
  }
}

/* ---- SkyWalking（主路径：运行时调用边） ---- */

/**
 * SkyWalking OAP GraphQL 查询。schema 随版本演进，落地前需在环境里做一次
 * introspection 核对字段名（本查询对齐 getGlobalTopology → nodes/calls）。
 */
export const SKYWALKING_TOPOLOGY_QUERY =
  'query ($duration: Duration!) { getGlobalTopology(duration: $duration) { nodes { id name type } calls { id source target detectPoint } } }'

export type SkyWalkingSourceConfig = {
  /** OAP GraphQL 地址，如 `http://skywalking-oap:12800`（自动补 `/graphql`） */
  endpoint: string
  /** 拓扑统计窗口（分钟），默认 30 */
  durationMinutes?: number
  timeoutMs?: number
  fetchImpl?: FetchLike
}

/** SkyWalking Duration 的时间格式（UTC，`YYYY-MM-DD HHmm`）。 */
function formatSkyWalkingTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  )
}

/**
 * 解析 SkyWalking getGlobalTopology 响应为依赖图。
 * 纯函数（不联网），便于单测验证解析；调用边 `source → target` 按节点名登记为无向边。
 */
export function parseSkyWalkingTopology(
  payload: unknown,
  opts: { maxHops?: number; source?: string } = {},
): DependencyGraph {
  const topology = (
    payload as {
      data?: { getGlobalTopology?: { nodes?: unknown; calls?: unknown } | null }
    }
  )?.data?.getGlobalTopology
  const nodes = Array.isArray(topology?.nodes) ? topology.nodes : []
  const calls = Array.isArray(topology?.calls) ? topology.calls : []

  const nameById = new Map<string, string>()
  for (const raw of nodes) {
    const node = raw as { id?: unknown; name?: unknown }
    if (typeof node?.id === 'string' && typeof node?.name === 'string' && node.name !== '') {
      nameById.set(node.id, node.name)
    }
  }

  const edges: Record<string, string[]> = {}
  for (const raw of calls) {
    const call = raw as { source?: unknown; target?: unknown }
    const from = typeof call?.source === 'string' ? nameById.get(call.source) : undefined
    const to = typeof call?.target === 'string' ? nameById.get(call.target) : undefined
    if (from === undefined || to === undefined) continue
    const list = edges[from] ?? []
    list.push(to)
    edges[from] = list
  }

  return createGraph({
    source: opts.source ?? 'skywalking',
    edges,
    maxHops: opts.maxHops,
  })
}

export class SkyWalkingTopologySource implements TopologySource {
  readonly name = 'skywalking'
  private readonly endpoint: string
  private readonly durationMinutes: number
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(config: SkyWalkingSourceConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.durationMinutes = config.durationMinutes ?? 30
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async load(): Promise<DependencyGraph> {
    const end = new Date()
    const start = new Date(end.getTime() - this.durationMinutes * 60_000)
    const payload = await fetchJson(
      this.fetchImpl,
      `${this.endpoint}/graphql`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: SKYWALKING_TOPOLOGY_QUERY,
          variables: {
            duration: {
              start: formatSkyWalkingTime(start),
              end: formatSkyWalkingTime(end),
              step: 'MINUTE',
            },
          },
        }),
      },
      this.timeoutMs,
    )
    return parseSkyWalkingTopology(payload)
  }
}

/* ---- k8s（主路径：业务归属） ---- */

export type K8sSourceConfig = {
  /** API Server 地址；in-cluster 默认 `https://kubernetes.default.svc` */
  apiServer?: string
  /** ServiceAccount token；缺省读 env `KUBERNETES_SERVICE_ACCOUNT_TOKEN` */
  token?: string
  /** 限定命名空间；缺省全集群 */
  namespaces?: string[]
  timeoutMs?: number
  fetchImpl?: FetchLike
}

/** 推导 application 的标签键（优先级从高到低）。 */
const K8S_APP_LABEL_KEYS = [
  'app.kubernetes.io/part-of',
  'app.kubernetes.io/name',
  'app',
  'k8s-app',
] as const

/** 可作为"告警 service 标签值 → 图节点"对齐身份的标签键。 */
const K8S_IDENTITY_LABEL_KEYS = [
  'app.kubernetes.io/name',
  'app',
  'k8s-app',
  'service',
  'app.kubernetes.io/component',
] as const

/**
 * 解析 k8s workload 列表（Deployments / StatefulSets 的 items 即可）为**归属图**。
 * k8s 给的是"哪些服务属于同一业务应用"，正是 Keep L2 所需的那一层；不含调用边。
 */
export function parseK8sWorkloads(
  payload: unknown,
  opts: { source?: string } = {},
): DependencyGraph {
  const items = (payload as { items?: unknown })?.items
  const list = Array.isArray(items) ? items : []
  const applications: Record<string, string> = {}

  for (const raw of list) {
    const meta = (
      raw as { metadata?: { name?: unknown; labels?: Record<string, unknown> } }
    )?.metadata
    if (meta === undefined || meta === null) continue
    const labels = meta.labels ?? {}
    const label = (key: string): string | undefined => {
      const value = labels[key]
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    }
    const workloadName =
      typeof meta.name === 'string' && meta.name !== '' ? meta.name : undefined

    let application: string | undefined
    for (const key of K8S_APP_LABEL_KEYS) {
      application = label(key)
      if (application !== undefined) break
    }
    application ??= workloadName
    if (application === undefined) continue

    for (const key of K8S_IDENTITY_LABEL_KEYS) {
      const value = label(key)
      if (value !== undefined) applications[value] = application
    }
    if (workloadName !== undefined) applications[workloadName] = application
  }

  return createGraph({ source: opts.source ?? 'k8s', applications })
}

export class K8sTopologySource implements TopologySource {
  readonly name = 'k8s'
  private readonly apiServer: string
  private readonly token: string
  private readonly namespaces: string[]
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(config: K8sSourceConfig = {}) {
    this.apiServer = (config.apiServer ?? 'https://kubernetes.default.svc').replace(/\/+$/, '')
    this.token = config.token ?? process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN ?? ''
    this.namespaces = config.namespaces ?? []
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async load(): Promise<DependencyGraph> {
    if (this.token === '') {
      throw new Error('k8s 拓扑源缺少 token（KUBERNETES_SERVICE_ACCOUNT_TOKEN 未设置）')
    }
    const paths =
      this.namespaces.length > 0
        ? this.namespaces.map(ns => `/apis/apps/v1/namespaces/${ns}/deployments`)
        : ['/apis/apps/v1/deployments']

    const graphs: DependencyGraph[] = []
    for (const path of paths) {
      const payload = await fetchJson(
        this.fetchImpl,
        `${this.apiServer}${path}?limit=500`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        },
        this.timeoutMs,
      )
      graphs.push(parseK8sWorkloads(payload))
    }
    return graphs.length === 1 ? graphs[0]! : mergeGraphs(graphs)
  }
}

/* ------------------------------------------------------------------ *
 * 配置与工厂
 * ------------------------------------------------------------------ */

export type TopologyConfig = {
  /** 是否启用拓扑关联，**默认 false**（无可信拓扑数据不启用）。 */
  enabled: boolean
  /** 图来源 */
  source: 'static' | 'k8s' | 'skywalking'
  /** BFS 最大跳数 */
  maxHops: number
  /** 图刷新周期（毫秒），默认 5 分钟；后台周期聚合，不阻塞 webhook 请求路径。 */
  refreshMs: number
  /** static 源的内联图（仅 demo / 单测） */
  static?: GraphSpec
  k8s?: Omit<K8sSourceConfig, 'fetchImpl'>
  skywalking?: Omit<SkyWalkingSourceConfig, 'fetchImpl'>
}

export const DEFAULT_TOPOLOGY_CONFIG: TopologyConfig = {
  enabled: false,
  source: 'skywalking',
  maxHops: DEFAULT_TOPOLOGY_MAX_HOPS,
  refreshMs: 5 * 60 * 1000,
}

/** 按配置创建图来源；未启用或配置不完整时返回 null（该层静默关闭）。 */
export function createTopologySource(config: TopologyConfig): TopologySource | null {
  if (!config.enabled) return null
  if (config.source === 'static') {
    return new StaticTopologySource({ maxHops: config.maxHops, ...(config.static ?? {}) })
  }
  if (config.source === 'k8s') {
    return new K8sTopologySource(config.k8s ?? {})
  }
  const endpoint = config.skywalking?.endpoint
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null
  return new SkyWalkingTopologySource({
    ...(config.skywalking ?? {}),
    endpoint: endpoint.trim(),
  })
}
