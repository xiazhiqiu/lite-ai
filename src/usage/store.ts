/**
 * 用量 / 审计事件的存储接口与实现（T7）。
 *
 * ## 定位：这是**审计账本**，不是"指标"
 *
 * `observability/metrics.ts` 已经在写 SQLite 的 `llm_calls` / `tool_calls` / `turns`
 * —— 但那是**本机开发用的指标**（单机文件、无身份、无 job 维度、可随时删）。
 * 银行的合规要求问的是**另一个问题**：「**谁**在**什么时候**查了**什么**」。
 *
 * 所以本模块的存在理由不是"再存一份 token 数"，而是：
 * - 绑定 `user_id`（T6 的身份）—— 这是可追责的前提；
 * - 绑定 `job_id` / `trace_id` —— 让一条用量记录能回溯到具体那一次调查的全部事件；
 * - **不可篡改的落库**（PG 表 + 只追加）—— 指标库丢了无所谓，审计账本丢了是事故。
 *
 * ## 为什么不做成 `JobStore` 的一部分
 *
 * 两者的**生命周期与一致性要求不同**：job 是"可变的当前状态"（claim/finish 要
 * 乐观并发控制），usage 是"**只追加的事实**"（append-only，永不更新）。
 * 混在一起会让 JobStore 的契约测试被迫覆盖两类完全不同的语义。
 *
 * ## 为什么写失败不能影响 job
 *
 * **审计写失败必须让 job 失败吗？** 不。理由：
 * - 若审计写失败就 fail job，则审计库一抖，全站调查全挂 —— 可用性灾难；
 * - 但**静默吞掉**又违背"可追溯"的初衷。
 *
 * 折中：**调用方负责记日志**（`log('error', ...)`），本模块只如实把错误抛给调用方。
 * 至于"抛了之后怎么处理"，是调用方的策略（当前实现：记日志、不 fail job）。
 * 这样模块本身不替调用方做可用性与合规之间的取舍。
 */
import type pg from 'pg'

/**
 * 一条用量事实。
 *
 * 字段与 `schema.sql:186` 的 `usage_events` 表**逐列对应**（除了 id/created_at
 * 由存储生成），确保内存实现与 PG 实现不会悄悄漂移。
 */
export type UsageEvent = {
  userId: string
  jobId: string | null
  sessionId: string | null
  traceId: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  durationMs: number | null
  status: string | null
}

/** 落库后带主键与时间的完整行。 */
export type UsageRecord = UsageEvent & {
  id: number
  createdAt: number
}

/** 查询过滤条件（per-user 隔离由 userId 强制贯穿）。 */
export type ListUsageFilter = {
  /** **必传**：per-user 隔离的基础，调用方须从鉴权身份取，不得从请求参数取。 */
  userId: string
  jobId?: string
  limit?: number
}

/**
 * 聚合口径。
 *
 * **为什么聚合放在服务端**：若前端拿明细自己算，那么"本页看到的汇总"取决于
 * 分页边界 —— 用户翻到第 2 页会看到完全不同的"总数"。审计数字必须唯一口径，
 * 所以汇总只能由服务端基于**全量**（或明确的统计窗口）算。
 */
export type UsageSummary = {
  total: number
  completed: number
  failed: number
  inputTokens: number
  outputTokens: number
  avgDurationMs: number | null
}

export type UsageStore = {
  /** 追加一条事实（**只追加，永不更新** —— 审计账本的基本属性）。 */
  record(event: UsageEvent, now?: number): Promise<UsageRecord>
  /** 按用户查明细（新→旧）。 */
  list(filter: ListUsageFilter): Promise<UsageRecord[]>
  /** 按用户聚合（不受分页影响，是全量口径）。 */
  summarize(userId: string): Promise<UsageSummary>
}
