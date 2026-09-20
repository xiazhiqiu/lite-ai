/**
 * 聚合 / 去重的状态存储接口（T12）。
 *
 * ## 为什么接口长这样（关键设计决策）
 *
 * `IncidentRegistry.resolve()` 是**同步函数**（`incident-registry.ts:294`），
 * 其内部的分组 / 维度判定 / TTL 收敛全在一个事件循环 tick 内完成——这是它对
 * OpenObserve "per-incident 行锁"的等价物（见该文件顶部注释）。若为了落库把
 * `resolve()` 改成 async，就要在计算中途插入 await，**互斥即刻失效**：
 * 两个并发 `resolve()` 会各自基于陈旧快照决策，产生重复 incident 或错误合并。
 *
 * 因此接口**不暴露"逐条读改写"**，而暴露**快照式**语义：
 *
 * ```ts
 * const snapshot = await store.loadOpen()      // ① 取 open 事件快照（含 resolved 以便 TTL 判定）
 * const result = registry.resolve(alerts, cfg, now, graph, snapshot)  // ② 纯内存同步计算
 * await store.commit(diff)                     // ③ 一次性回写差异（create / update）
 * ```
 *
 * 于是"异步"只发生在①③两个边界点，**中间的计算保持同步原子**。
 *
 * ## 多实例一致性边界（必须诚实说明）
 *
 * 快照式读改写在**单实例**下与内存实现完全等价；在**多实例**下它把"互相看不见"
 * 降级为"偶发竞态"——两个实例同时 `loadOpen()` 可能拿到同一快照，各自创建事件。
 * 缓解手段有两条，本 Task 实现第一条：
 * 1. **唯一约束 + `ON CONFLICT`**：`incidents` 以 `(key_name, group_key, status='open')`
 *    的**部分唯一索引**拒绝重复创建（见 schema），落库冲突时返回既存行 id；
 * 2. 更高强度（**本 Task 不实现**）：`SELECT ... FOR UPDATE` 行锁包裹整段读改写，
 *    或把整个 resolve 做成 PG advisory lock 保护的临界区。属 P4 增强。
 *
 * 注意 PG 的部分唯一索引无法在内存实现里表达（内存是单线程，天然串行）。
 * 因此该约束的**行为**由 PG 集成测试单独验证，契约测试只验证"语义等价"部分。
 */
import type { IncidentRecord, DedupeRecord } from './types.js'

/**
 * 快照：一次 `resolve()` / `markResolved()` 所需的**全部**既有状态。
 *
 * 包含 resolved 事件是**有意为之**：`findOpenByKey` / `probeMatch` 只在 open 集合里
 * 检索，而 `sweep()` 需要看到 resolved 以做容量淘汰（`incident-registry.ts:734-754`）。
 * 若只加载 open，容量控制会失真（永远淘汰不到旧 resolved）。
 */
export type IncidentSnapshot = {
  /** 全部事件（open + resolved），按 incidentId 索引 */
  byId: Map<string, IncidentRecord>
}

/**
 * 回写差异：`resolve()` 之后产生的状态变化。
 *
 * 只回写**变化的部分**（而不是整表覆盖），理由有两点：
 * 1. `maxIncidents` 容量淘汰会删除事件，全量覆盖会让被淘汰的行"复活"；
 * 2. 多实例下少写即少冲突。
 */
export type IncidentDiff = {
  /** 新建的事件（整行插入，冲突时幂等忽略） */
  created: IncidentRecord[]
  /** 更新的事件（已存在，整行 upsert） */
  updated: IncidentRecord[]
  /** 被容量淘汰删除的事件 id */
  deleted: string[]
  /** 成员的增删（`addMembers` / `markResolved` 的增量） */
  memberUpserts: Array<{ incidentId: string; alert: unknown; seenCount: number; reasons: string[] }>
}

export interface IncidentStore {
  /**
   * 取全部事件快照（open + resolved）。
   * @param now 当前时间；用于 TTL 判定（**不**在这里做收敛，只用于可能的裁剪）
   */
  loadAll(now?: number): Promise<IncidentSnapshot>

  /**
   * 原子回写差异。
   *
   * PG 实现必须**在单个事务内**完成 created / updated / deleted / memberUpserts，
   * 否则多实例下会观察到"事件已建但成员未落"的中间态。
   */
  commit(diff: IncidentDiff, now?: number): Promise<void>

  /** 清空（测试 / 运维用；**仅内存实现支持**，PG 实现抛错以防误清生产数据）。 */
  clear(): Promise<void>
}

/**
 * 去重状态存储。
 *
 * 与 `IncidentStore` 不同，去重是**逐条读改写**（`shouldDiagnose(alert)` 天然按单条
 * 告警工作），因此接口按单条设计，无需快照式整批。
 *
 * 但注意 `shouldDiagnose` 内部"读判定 + 写时间戳"必须原子：若拆成
 * `get()` 再 `set()`，两个实例（或同实例两次调用）会各自判定为 `new`，
 * 双双放行诊断 → 去重失效。故接口设计成**单方法内完成读改写**。
 */
export interface DedupeStore {
  /**
   * 读取某 alertId 的去重条目（无则 null）。**只读**，供观测/测试；
   * 生产判定请用 `check`。
   */
  get(alertId: string): Promise<DedupeRecord | null>

  /**
   * 原子读改写：返回该条目的**既有状态**（null = 首次见到），
   * 并把新状态写入。调用方（`AlertDedupe`）据此做三态判定。
   *
   * 之所以返回"既有"而非"更新后"：判定逻辑必须在调用方（保持规则集中在一处），
   * 存储层只负责"给我旧值、存我新值"这一个原子动作。
   */
  check(
    alertId: string,
    next: DedupeRecord,
    now?: number,
  ): Promise<DedupeRecord | null>

  /** 清理静默期已过的条目（对应 `dedupe.ts:112-117` 的 setTimeout 清理）。 */
  purgeExpired(silenceMs: number, now?: number): Promise<number>

  /** 清空（测试 / 运维用）。 */
  clear(): Promise<void>
}
