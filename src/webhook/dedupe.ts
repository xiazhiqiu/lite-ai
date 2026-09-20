/**
 * 兜底去重 + 批处理护栏。
 *
 * Alertmanager 自身已提供分组（group_by）、重复控制（repeat_interval）、
 * 抑制（inhibit_rules）、静默（silence）。lite-ai 侧仅做轻量兜底：
 * - 兜底去重：覆盖 HA 双发（秒级）、网络重试（分钟级）
 * - 批处理护栏：防止单次请求含异常大量的告警（通常意味着上游 group_by 误配）
 *
 * 设计对齐开源实践（而非硬编码魔法常量）：
 * - 去重：Keep 双层去重（完整重复→抑制；内容变化→更新重处理）+ OpenObserve 可配置
 *   silence 静默期（窗口内重触发被抑制）。键用 Alert.id（= alertname+labels 的
 *   fingerprint，见 types.computeAlertId），与 Alertmanager 去重键语义一致。
 * - 截断 / 并发：全部可配置，默认值对齐开源量级（见 config.ts 的 DEFAULT_*）。
 */
import { createHash } from 'node:crypto'
import type { Alert } from './types.js'
import { severityWeight } from './types.js'
import type { DedupeStore } from '../incident/store.js'

/**
 * 单次请求最多处理的告警数（护栏，可配置；默认 200）。
 * Alertmanager group_by 已限制微批大小，200 仅作内存安全护栏，
 * 触发后应检查上游 group_by 配置，而非"静默丢弃"。
 */
export const MAX_ALERTS_PER_BATCH = 200

/** 去重判定结果（对齐 Keep 两层去重的语义）。 */
export type DedupeOutcome =
  /** 首次见到该 fingerprint（或静默期已过）→ 诊断 */
  | 'new'
  /** 同一 fingerprint、但内容哈希变化（如指标值跳变）→ 视为更新，重诊断 */
  | 'updated'
  /** 静默期内、且内容未变（完整重复，HA 双发/网络重试）→ 抑制，不烧 token */
  | 'suppressed'

/**
 * 批处理护栏：按严重级别排序后截断，critical 优先。
 * 返回 { alerts, truncated }，truncated 为被截掉的告警数。
 *
 * 注意：截断是内存安全护栏，不是"丢弃"语义——超限时调用方应检查上游 group_by 配置。
 * `limit` 可配置（默认见 MAX_ALERTS_PER_BATCH）。
 */
export function truncateAlerts(
  alerts: Alert[],
  limit: number = MAX_ALERTS_PER_BATCH,
): { alerts: Alert[]; truncated: number } {
  if (alerts.length <= limit) {
    return { alerts, truncated: 0 }
  }
  const sorted = [...alerts].sort(
    (a, b) => severityWeight(b.severity) - severityWeight(a.severity),
  )
  return {
    alerts: sorted.slice(0, limit),
    truncated: alerts.length - limit,
  }
}

/**
 * 双层去重（对齐 Keep 的两级去重 + OpenObserve 的 silence 静默期）：
 * - `new`        首次见到该 fingerprint（或静默期已过）→ 诊断
 * - `updated`    同一 fingerprint、但内容哈希变化 → 视为更新，重诊断（根因上下文可能变化）
 * - `suppressed` 静默期内、且内容未变（完整重复，HA 双发/网络重试）→ 抑制，不烧 token
 *
 * 键使用 Alert.id（= alertname+labels 的 fingerprint），与 Alertmanager 去重键语义一致；
 * 静默期 `silenceMs` 可配置（默认 5 分钟，对齐 OpenObserve 的 silence 配置）。
 */
export class AlertDedupe {
  private seen = new Map<string, { hash: string; firstSeen: number }>()
  private readonly silenceMs: number
  /**
   * 状态存储（T12）；null = 纯内存（默认，行为零变化）。
   *
   * 配 store 时，"判定 + 写状态"必须走 `shouldDiagnosePersisted()`，
   * 因为读改写要跨 await 边界，同步版 `shouldDiagnose()` 无法保证原子。
   */
  private readonly store: DedupeStore | null
  /** 本次 flush 周期内待回写的条目（alertId → 新状态）。 */
  private readonly dirty = new Map<string, { hash: string; firstSeen: number }>()

  /**
   * @param silenceMs 静默期（毫秒），默认 5 分钟；对齐 OpenObserve silence
   * @param opts.store 状态存储（T12）；缺省为纯内存
   */
  constructor(silenceMs = 300_000, opts: { store?: DedupeStore } = {}) {
    this.silenceMs = silenceMs
    this.store = opts.store ?? null
  }

  /**
   * 从 store 加载冷却态进内存（T12）。配 store 时应在首次判定前调用
   * （或直接用 `shouldDiagnosePersisted()`，它自带 hydrate）。
   */
  async hydrate(): Promise<void> {
    if (this.store === null) return
    // DedupeStore 是逐条接口，没有"全量加载"——因为去重只按单条 alertId 检索，
    // 全量预载既慢又无必要。这里只清空本地缓存，让后续判定走 store 回查。
    this.seen.clear()
    this.dirty.clear()
  }

  /** 把本次判定产生的状态变更回写 store（T12）。未配 store 时空操作。 */
  async flush(): Promise<void> {
    if (this.store === null || this.dirty.size === 0) return
    for (const [alertId, record] of this.dirty) {
      await this.store.check(alertId, { ...record })
    }
    this.dirty.clear()
  }

  /**
   * 持久化版判定（T12）：单方法内完成"读状态 → 三态判定 → 写状态"，
   * 保证多实例下的原子性（对应 `dedupe.ts` 顶部注释中"读判定+写时间戳必须原子"）。
   *
   * 三态语义与同步版 `shouldDiagnose()` **逐条一致**，只是状态的来源/去处换成 store。
   */
  async shouldDiagnosePersisted(
    alert: Alert,
    now: number = Date.now(),
  ): Promise<DedupeOutcome> {
    if (this.store === null) {
      // 未配 store：退回同步语义（用注入的 now 无法生效——同步版取 Date.now()，
      // 这是既有行为，保持不动）。
      return this.shouldDiagnose(alert)
    }

    const hash = this.contentHash(alert)
    const prev = await this.store.get(alert.id)

    if (prev === null) {
      await this.store.check(alert.id, { hash, firstSeen: now }, now)
      return 'new'
    }

    const withinSilence = now - prev.firstSeen < this.silenceMs
    if (!withinSilence) {
      // 静默期已过：当作新的一次发作，重新诊断（起点推进）
      await this.store.check(alert.id, { hash, firstSeen: now }, now)
      return 'new'
    }

    if (prev.hash === hash) {
      // 完整重复（内容未变）→ 抑制（**状态不变**，不写回）
      return 'suppressed'
    }
    // 同一 fingerprint、内容变化 → 更新，重诊断（firstSeen 不动，窗口内持续放行）
    await this.store.check(alert.id, { hash, firstSeen: prev.firstSeen }, now)
    return 'updated'
  }

  /** 同一 fingerprint 下用于判断"内容是否变化"的哈希（指标值跳变即视为 updated）。 */
  private contentHash(alert: Alert): string {
    const payload = `${alert.title}|${alert.severity}|${alert.summary}|${alert.description}|${JSON.stringify(alert.labels)}`
    return createHash('sha1').update(payload).digest('hex').slice(0, 16)
  }

  /** 判定该告警的去重结果（见 DedupeOutcome）。 */
  shouldDiagnose(alert: Alert): DedupeOutcome {
    const fp = alert.id
    const now = Date.now()
    const hash = this.contentHash(alert)
    const prev = this.seen.get(fp)

    if (prev === undefined) {
      this.seen.set(fp, { hash, firstSeen: now })
      this.scheduleCleanup(fp)
      return 'new'
    }

    const withinSilence = now - prev.firstSeen < this.silenceMs
    if (!withinSilence) {
      // 静默期已过：当作新的一次发作，重新诊断
      this.seen.set(fp, { hash, firstSeen: now })
      this.scheduleCleanup(fp)
      return 'new'
    }

    if (prev.hash === hash) {
      // 完整重复（内容未变）→ 抑制
      return 'suppressed'
    }
    // 同一 fingerprint、内容变化 → 更新，重诊断（firstSeen 不动，窗口内变化持续放行）
    this.seen.set(fp, { hash, firstSeen: prev.firstSeen })
    return 'updated'
  }

  private scheduleCleanup(fp: string): void {
    // 窗口结束后自动清理该 key，防止 Map 无限膨胀。
    setTimeout(() => {
      this.seen.delete(fp)
    }, this.silenceMs + 1)
  }
}
