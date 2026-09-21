/**
 * 共用告警摄入管道（Ingest Pipeline）。
 *
 * 定位：**与传输方式无关**的后处理链路。无论是 HTTP webhook 推送（push）还是
 * provider 定时拉取（pull），只要能产出统一 `Alert[]`，就走同一条管道：
 *
 *   Alert[] → 批处理护栏 → 跨批次注册表关联 → 事件/单条分级 → 有界并发池 → RCA
 *
 * 为什么要抽出来（本文件存在的唯一理由）：
 * 这条链路原先内联在 `webhook/index.ts` 的 HTTP handler 里。若不抽出，将来的
 * **拉取型 provider**（云监控 / Zabbix / 日志告警 / K8s Events —— 它们不是 POST
 * 给我们，而是我们去调它们的 API）就必须复制一份，push 与 pull 会立刻 divergent
 * 成两套逻辑（去重口径、关联口径、并发护栏各走各的）。抽出后二者共用同一实现。
 *
 * 本文件是**行为保持**的重构：关联/去重/并发/拓扑刷新逻辑逐行照搬原实现，
 * 验收标准是既有 webhook 测试集合不发生变化。
 *
 * 设计红线（沿用不变）：
 * - **关联纯规则、零 LLM**；AI 只在末端 `diagnose()` 这一个叶子节点参与。
 * - **事件是诊断单元**：一个 incident = 一个 sessionId = 一次 RCA。
 * - **拓扑层默认关闭**，拉取失败自动退化为纯规则关联，绝不阻塞诊断。
 */
import {
  DEFAULT_DEDUPE_SILENCE_MS,
  DEFAULT_MAX_BATCH_PER_REQUEST,
  DEFAULT_MAX_CONCURRENT_DIAGNOSES,
  type WebhookConfig,
} from '../config.js'
import { AlertDedupe, truncateAlerts } from '../webhook/dedupe.js'
import { IncidentRegistry } from '../webhook/incident-registry.js'
import {
  DEFAULT_TOPOLOGY_CONFIG,
  createTopologySource,
  type DependencyGraph,
} from '../webhook/topology.js'
import { runAlertDiagnosis, type DiagnosisResult } from '../webhook/diagnose.js'
import type { Alert, Incident } from '../webhook/types.js'
import { createSourceProviders } from './provider.js'
import { startPullScheduler } from './scheduler.js'
import { getGlobalPool, type BoundedPool } from '../jobs/pool.js'

/** 管道所需的配置子集（与 HTTP 监听参数 port/host/secret 无关）。 */
export type IngestConfig = Pick<
  WebhookConfig,
  | 'autoDiagnose'
  | 'maxConcurrentDiagnoses'
  | 'dedupeSilenceMs'
  | 'maxBatchPerRequest'
  | 'correlation'
  | 'topology'
  | 'sources'
>

/** 单次摄入的处理结果（回给调用方，如 HTTP 202 响应体）。 */
export type IngestResult = {
  /** 已入队诊断的单元数（事件级或单条） */
  accepted: number
  /** 被去重/冷却抑制的条数 */
  deduplicated: number
  /** 被批处理护栏截断的条数 */
  truncated: number
  /** 源侧已恢复（`resolved`）的条数：只做事件收敛，**不计入 accepted**（恢复不烧 token） */
  resolved: number
  /** 因源侧恢复而被关闭的事件数（全部成员均已 resolved） */
  closedIncidents: number
}

/**
 * 摄入上下文（G7）：随本次 HTTP 请求传入的元信息。
 *
 * 目前只有 `userId` —— 告警 job 必须落在**投递方的身份**下，否则值班台按 userId
 * 过滤时会看不到告警 job（per-user 隔离会把它们隔在外面）。
 *
 * 刻意做成参数一路透传，而不是给管道塞一个"当前请求"的可变字段：
 * 后者在并发请求下是共享可变状态，而 `ingest()` 是同步的，传参即可无竞态。
 */
export type IngestContext = {
  userId?: string
}

export type IngestPipelineOptions = {
  /**
   * 诊断执行器，默认 `runAlertDiagnosis`（测试可注入）。
   * 事件级诊断时第二个参数为 Incident（sessionId 取 incidentId）；单条诊断时不传。
   */
  diagnose?: (alert: Alert, incident?: Incident) => Promise<DiagnosisResult>
  /** 注入时钟（测试需要确定性时间推进）。 */
  now?: () => number
  /** 注入日志（测试静音 / 结构化收集）。 */
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
  /**
   * 注入并发池。**缺省用进程级全局单例**（`getGlobalPool`，plan G1）——
   * 生产路径必须共用同一个池，否则 provider 看到的并发会翻倍。
   *
   * 仅**测试**需要注入私有池：全局池一旦建立，其 `limit` 就固定为首次调用值，
   * 而不同测试用例会各自断言不同的上限（如 2 与 3）。注入让每个用例拥有
   * 独立的池，从而能在同一进程里验证"限流确实按传入值生效"。
   */
  pool?: BoundedPool
  /**
   * 【G7】诊断出口注入。提供时，**末端那次 RCA 不再在管道自己的池里跑**，而是
   * 交给调用方 —— 服务端形态即"入 jobs 队列（kind='alert'）"，由 Worker 认领执行，
   * 从而获得 job 的一切好处：过程可见（SSE）、失败可重派、多实例故障转移。
   *
   * 缺省（undefined）→ 退回原行为（池内直接跑），单进程 webhook 形态**零变化**。
   *
   * 为什么注入的是"出口"而不是"换掉 diagnose"：
   * 去重 / 关联 / 分级这些**零 LLM 的规则判定必须留在同步的 `ingest()` 里** ——
   * HTTP 要立刻回 `accepted/deduplicated`，而这些都是纯内存判定、不耗时。
   * 真正需要异步化的只有末端那一次烧 token 的 RCA。
   */
  enqueueDiagnosis?: (
    alert: Alert,
    incident?: Incident,
    ctx?: IngestContext,
  ) => void | Promise<void>
}

/**
 * 有界并发池已抽到 `src/jobs/pool.ts`（T4，plan G1）——**全局单例**。
 *
 * 原因：服务化后 Worker 也要跑诊断，如果 Worker 再 new 一个池，两个池各自限流会让
 * LLM provider 实际看到的并发 = 两池之和（全局配额翻倍）。池必须是进程级的。
 * 本管道通过 `getGlobalPool()` 取用与 Worker 同一个实例。
 */

/**
 * 告警摄入管道。
 *
 * 用法（webhook）：
 * ```ts
 * const pipeline = new IngestPipeline({ cwd, config })
 * pipeline.start()                       // 启动拓扑后台刷新（默认关闭时不产生任何定时器）
 * const r = pipeline.ingest(alerts)      // 同步入队，返回 accepted/deduplicated/truncated
 * await pipeline.drained()               // 优雅关停：等诊断跑完
 * pipeline.close()
 * ```
 */
export class IngestPipeline {
  private readonly dedupe: AlertDedupe
  private readonly registry: IncidentRegistry
  private readonly pool: BoundedPool
  private readonly diagnose: (
    alert: Alert,
    incident?: Incident,
  ) => Promise<DiagnosisResult>
  private readonly now: () => number
  private readonly log: (level: 'log' | 'warn' | 'error', message: string) => void
  /**
   * 【G7】诊断出口。undefined = 退回池内执行（单进程形态）。
   * 见 `IngestPipelineOptions.enqueueDiagnosis` 注释。
   */
  private readonly enqueueDiagnosis:
    | ((alert: Alert, incident?: Incident, ctx?: IngestContext) => void | Promise<void>)
    | undefined

  /** L2 拓扑关联用的依赖图；未启用 / 拉取失败时为 null（退化为纯规则关联）。 */
  private topologyGraph: DependencyGraph | null = null
  private topologyTimer: ReturnType<typeof setInterval> | null = null
  /** 拉取源调度的停止函数；未启用任何拉取源时为 null。 */
  private stopPullScheduler: (() => void) | null = null
  private started = false

  constructor(
    private readonly cwd: string,
    private readonly config: IngestConfig,
    opts: IngestPipelineOptions = {},
  ) {
    this.dedupe = new AlertDedupe(
      config.dedupeSilenceMs ?? DEFAULT_DEDUPE_SILENCE_MS,
    )
    this.registry = new IncidentRegistry()
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((level, message) => console[level](message))
    this.diagnose =
      opts.diagnose ??
      ((alert: Alert, incident?: Incident) =>
        runAlertDiagnosis({ cwd: this.cwd, alert, incident }))
    // G7：诊断出口。未注入 → dispatchDiagnosis 退回池内执行，单进程形态行为不变。
    this.enqueueDiagnosis = opts.enqueueDiagnosis
    // 全局单例池（plan G1）：Worker 与摄入管道共用同一个限流上限，
    // 否则两个池各自限流会让 provider 实际看到的并发翻倍。
    // 测试可注入私有池（见 IngestPipelineOptions.pool 注释）。
    this.pool =
      opts.pool ??
      getGlobalPool(
        config.maxConcurrentDiagnoses ?? DEFAULT_MAX_CONCURRENT_DIAGNOSES,
        message => this.log('error', `[webhook] 诊断失败: ${message}`),
      )
  }

  /**
   * 启动后台任务：拓扑图周期刷新 + 拉取源调度。
   * 与构造函数分离：避免"仅构造一个管道"就意外留下定时器句柄。
   *
   * 两者相互独立 —— 拓扑层没配置好**不能**连累拉取源，反之亦然。
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.startTopologyRefresh()
    this.startPullSources()
  }

  /**
   * 挂载拉取型告警源（云监控 / Zabbix / 日志告警 ...）。默认**全部关闭**：
   * 只有配置里显式 `enabled: true` 的源才会被创建；被跳过的源逐条 warn，
   * 避免"配了没生效"却无人知晓。
   *
   * 拉取结果走 `this.ingest()` —— 与 webhook 推送**同一条管道**：
   * 同一份去重表、同一份跨批次注册表、同一个有界并发池。
   */
  private startPullSources(): void {
    const { providers, skipped } = createSourceProviders(this.config.sources?.pull)
    for (const item of skipped) {
      this.log('warn', `[ingest] 拉取源 ${item.name} 未启用: ${item.reason}`)
    }
    if (providers.length === 0) return

    this.log(
      'log',
      `[ingest] 已启用 ${providers.length} 个拉取源: ${providers.map(p => p.name).join(', ')}`,
    )
    this.stopPullScheduler = startPullScheduler(providers, {
      ingest: alerts => {
        this.ingest(alerts)
      },
      log: this.log,
    })
  }

  private startTopologyRefresh(): void {
    const topologyCfg = {
      ...DEFAULT_TOPOLOGY_CONFIG,
      ...(this.config.topology ?? {}),
    }
    const topologySource = createTopologySource(topologyCfg)
    if (topologySource === null) {
      if (topologyCfg.enabled) {
        this.log(
          'warn',
          '[webhook] 拓扑关联已启用但图来源配置不完整（如缺少 skywalking.endpoint / k8s token），该层保持关闭',
        )
      }
      return
    }

    const refresh = async (): Promise<void> => {
      try {
        const graph = await topologySource.load()
        this.topologyGraph = graph
        this.log(
          'log',
          `[webhook] 拓扑图已更新（来源 ${graph.source}，调用边节点 ${Object.keys(graph.edges).length}，归属条目 ${Object.keys(graph.applications).length}，maxHops=${graph.maxHops}）`,
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.log('warn', `[webhook] 拓扑图拉取失败，退化为纯规则关联: ${reason}`)
      }
    }
    void refresh()
    this.topologyTimer = setInterval(() => {
      void refresh()
    }, topologyCfg.refreshMs)
    // 不阻止进程退出：定时器只为诊断提供额外证据，不是主链路的一部分。
    this.topologyTimer.unref()
  }

  /** 停止后台任务（优雅关停时调用）：清定时器 + 取消在途拉取请求。 */
  close(): void {
    if (this.topologyTimer !== null) {
      clearInterval(this.topologyTimer)
      this.topologyTimer = null
    }
    if (this.stopPullScheduler !== null) {
      this.stopPullScheduler()
      this.stopPullScheduler = null
    }
    this.started = false
  }

  /** 等待所有已入队诊断跑完（优雅关停用）。 */
  drained(): Promise<void> {
    return this.pool.drained()
  }

  /** 直接访问注册表（测试 / 运维观测用）。 */
  get incidents(): IncidentRegistry {
    return this.registry
  }

  /**
   * 摄入一批已归一化的告警。
   *
   * 同步返回：只做"入队"决策，诊断在后台并发池里跑，因此 HTTP 可以快速回 202。
   */
  ingest(alerts: Alert[], ctx?: IngestContext): IngestResult {
    const { alerts: kept, truncated } = truncateAlerts(
      alerts,
      this.config.maxBatchPerRequest ?? DEFAULT_MAX_BATCH_PER_REQUEST,
    )
    if (truncated > 0) {
      this.log(
        'warn',
        `[webhook] 告警被截断: 原始 ${alerts.length} 条 → 保留 ${kept.length} 条（critical 优先）。请检查 Alertmanager group_by/repeat_interval 配置。`,
      )
    }

    // 分流：`resolved`（源侧恢复通知）只做事件收敛，**绝不进 RCA 路径**。
    // 恢复不该烧 token —— 这是本层与 `registry.resolve()` 的分工边界。
    // 放在 autoDiagnose 判断之外：收敛不是诊断，关了自动诊断也应照常收敛。
    const firing = kept.filter(alert => alert.status !== 'resolved')
    const recovered = kept.filter(alert => alert.status === 'resolved')

    let closedIncidents = 0
    if (recovered.length > 0) {
      const { closed, resolvedMembers, unmatched } = this.registry.markResolved(
        recovered,
        this.config.correlation ?? {},
        this.now(),
      )
      closedIncidents = closed.length
      this.log(
        'log',
        `[webhook] 源侧恢复 ${recovered.length} 条 → 关闭 ${closed.length} 个事件` +
          `（记录 ${resolvedMembers} 个已恢复成员，未匹配 ${unmatched} 条）`,
      )
    }

    let accepted = 0
    let deduplicated = 0

    if (this.config.autoDiagnose !== false) {
      // L2 关联（确定性、零 LLM、零网络）：
      //   ① 批次内 —— 同分组 + 同时间窗达阈值的告警聚成事件；
      //   ② 跨批次 —— 新告警与注册表中的 open 事件匹配，能并入则并入（照 OpenObserve）。
      // 同一告警重复到达只记时间线、不重复烧 token；已有事件的新成员触发一次"增量重分析"。
      const { units, repeated } = this.registry.resolve(
        firing,
        this.config.correlation ?? {},
        this.now(),
        this.topologyGraph,
      )
      deduplicated += repeated

      for (const unit of units) {
        const ok =
          unit.level === 'incident'
            ? this.handleIncident(unit.incident, ctx)
            : this.handleAlert(unit.alert, ctx)
        if (ok) accepted += 1
        else deduplicated += 1
      }
    }

    return {
      accepted,
      deduplicated,
      truncated,
      resolved: recovered.length,
      closedIncidents,
    }
  }

  /** 单条告警诊断：双层去重后入队。返回 true 表示已入队。 */
  private handleAlert(alert: Alert, ctx?: IngestContext): boolean {
    // 双层去重：完整重复（静默期内内容未变）→ 抑制；内容变化 → 更新重诊断。
    const outcome = this.dedupe.shouldDiagnose(alert)
    if (outcome === 'suppressed') {
      this.log(
        'log',
        `[webhook] 去重抑制 ${alert.title} (${alert.id})，静默期内完整重复`,
      )
      return false
    }
    if (outcome === 'updated') {
      this.log(
        'log',
        `[webhook] 告警内容变化，重诊断 ${alert.title} (${alert.id})`,
      )
    }
    this.dispatchDiagnosis(alert, undefined, ctx)
    return true
  }

  /**
   * 【G7】诊断出口：决定"跑一次 RCA"这件事交给谁执行。
   *
   * - 注入了 `enqueueDiagnosis`（服务端形态）→ 入 jobs 队列，由 Worker 认领执行；
   *   失败归队列侧记录（job → failed + 可被 stale sweep 重派），这里只兜底防
   *   unhandled rejection —— 入队失败不该让告警摄入的 HTTP 请求崩掉。
   * - 缺省（单进程 webhook）→ 走有界并发池，异常记 error 日志后吞掉（G7 前原行为）。
   */
  private dispatchDiagnosis(
    alert: Alert,
    incident?: Incident,
    ctx?: IngestContext,
  ): void {
    if (this.enqueueDiagnosis === undefined) {
      this.pool.enqueue(async () => {
        try {
          const result = await this.diagnose(alert, incident)
          this.log(
            'log',
            incident
              ? `[webhook] 事件诊断完成 ${incident.incidentId}（${incident.alerts.length} 条成员，主告警 ${incident.primaryAlert.title}）→ session ${result.sessionId}`
              : `[webhook] 诊断完成 ${alert.title} (${alert.severity}) → session ${result.sessionId}`,
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          this.log(
            'error',
            incident
              ? `[webhook] 事件诊断异常 ${incident.incidentId}: ${reason}`
              : `[webhook] 诊断异常 ${alert.title}: ${reason}`,
          )
        }
      })
      return
    }
    void Promise.resolve(this.enqueueDiagnosis(alert, incident, ctx)).catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      this.log(
        'error',
        `[ingest] 诊断入队失败 ${incident?.incidentId ?? alert.title}: ${reason}`,
      )
    })
  }

  /**
   * 事件级诊断：整个 incident 作为一次诊断单元（sessionId = incidentId）。
   * 是否触发由注册表的关联决策决定（同一告警重复到达不触发），因此这里**不再做冷却判定**
   * —— 否则跨批次新成员并入已有事件时会被"同 incidentId 冷却"误拦（既有缺陷）。
   */
  private handleIncident(incident: Incident, ctx?: IngestContext): boolean {
    // 先标记已诊断：同一事件后续到达的新成员据此标记为"增量重分析"。
    this.registry.markDiagnosed(incident.incidentId)
    this.dispatchDiagnosis(incident.primaryAlert, incident, ctx)
    return true
  }
}
