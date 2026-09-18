/**
 * 拉取型告警源（pull provider）抽象 —— 补齐与 Keep 最本质的差距。
 *
 * 背景：webhook 只能吃"别人推给我们"的源（Alertmanager / Grafana / PagerDuty ...）。
 * 但用户环境里一半以上的源**没有推送能力**，必须我们主动去调它的 API：
 * 云监控（CloudWatch / 阿里云 / 华为云 CES）、Zabbix、ELK/Loki/Splunk 日志告警、
 * K8s Events、业务自建查询接口 ...。Keep 能吃下这些，靠的就是 provider **双模**：
 * 每个 provider 既能收 webhook，也能定时轮询（`query data`）。
 *
 * 本模块只负责 **pull 那一半**，并刻意与传输层解耦：
 *
 *   provider.poll() → Alert[]  ──┐
 *                                ├─→ IngestPipeline.ingest() → 去重/关联/分级/并发池 → RCA
 *   POST /webhook → adapter → ──┘
 *
 * 关键设计约束（与 topology.ts 的 `createTopologySource` 同构，保持一致性）：
 * 1. **默认关闭**：`enabled` 必须显式为 `true` 才启用 —— 与拓扑层同一哲学，无配置即静默不启用。
 * 2. **配置不完整返回 null**，绝不抛错炸掉启动流程。
 * 3. **单个 provider 失败不影响其它 provider 与 webhook 主链路**（容错在调度器里）。
 */
import type { Alert } from '../webhook/types.js'
import { createHttpPollProvider, type HttpPollConfig } from './providers/http-poll.js'
import { createK8sEventsProvider, type K8sEventsConfig } from './providers/k8s-events.js'

/** 拉取型告警源：一次 poll 返回统一 Alert[]；调度与容错由调用方（scheduler）负责。 */
export interface SourceProvider {
  /** provider 名，写入 `Alert.source`，同时用于日志与去重观测 */
  readonly name: string
  /**
   * 拉取周期（毫秒）。缺省时用调度器的全局默认值。
   * 放在 provider 上而非调度器上：不同源的合理节奏差一个数量级
   * （K8s Events 秒级、云监控分钟级），统一节奏会要么打爆 API、要么漏告警。
   */
  readonly intervalMs?: number
  /** 拉取一次并返回统一 Alert[]。失败时**抛错**（由调度器捕获降级，不在此静默吞掉）。 */
  poll(signal?: AbortSignal): Promise<Alert[]>
}

/**
 * 单个拉取源的配置。所有源共用 `type / name / enabled / intervalMs`，
 * 其余字段由该 type 自己的工厂解释（如 httpPoll 见 `HttpPollConfig`）。
 */
export type PullProviderConfig = {
  /** provider 类型，决定用哪个工厂（`httpPoll` / 后续 `k8sEvents` ...） */
  type: string
  /** provider 名（写入 Alert.source） */
  name: string
  /** **默认 false**：必须显式 `true` 才拉取（无配置即静默不启用） */
  enabled?: boolean
  /** 拉取周期（毫秒），缺省 `DEFAULT_PULL_INTERVAL_MS` */
  intervalMs?: number
  [key: string]: unknown
}

/** `webhook.sources` 配置节。 */
export type PullSourcesConfig = {
  pull?: PullProviderConfig[]
}

/** 默认拉取周期（60 秒）：多数监控 API 的告警判定周期本身就在分钟级。 */
export const DEFAULT_PULL_INTERVAL_MS = 60_000

type ProviderFactory = (cfg: PullProviderConfig) => SourceProvider | null

/** provider 类型注册表：**新增一个 pull 源 = 加一个工厂 + 注册一行**。 */
const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  httpPoll: cfg => createHttpPollProvider(cfg as unknown as HttpPollConfig),
  k8sEvents: cfg => createK8sEventsProvider(cfg as unknown as K8sEventsConfig),
}

/** 被跳过的源（供调用方记录日志，避免"配了没生效"却无人知晓）。 */
export type SkippedProvider = { name: string; reason: string }

/**
 * 按配置创建拉取源。未启用 / 类型未知 / 配置不完整 → 跳过（收集在 `skipped` 里）。
 * **绝不因配置错误抛错**：告警接入是增强能力，不能阻塞 webhook 主链路启动。
 */
export function createSourceProviders(
  configs: PullProviderConfig[] | undefined,
): { providers: SourceProvider[]; skipped: SkippedProvider[] } {
  const providers: SourceProvider[] = []
  const skipped: SkippedProvider[] = []
  for (const cfg of configs ?? []) {
    const name = cfg?.name ?? cfg?.type ?? 'unknown'
    if (cfg?.enabled !== true) {
      skipped.push({ name, reason: 'enabled 未显式设为 true（拉取源默认关闭）' })
      continue
    }
    const factory = PROVIDER_FACTORIES[cfg.type]
    if (factory === undefined) {
      skipped.push({ name, reason: `未知的 provider 类型 "${cfg.type}"` })
      continue
    }
    const provider = factory(cfg)
    if (provider === null) {
      skipped.push({ name, reason: '配置不完整（缺少必要字段）' })
      continue
    }
    providers.push(provider)
  }
  return { providers, skipped }
}
