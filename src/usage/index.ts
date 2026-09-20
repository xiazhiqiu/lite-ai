/**
 * 用量 / 审计事件模块（T7）的统一出口。
 *
 * 对外只暴露**接口与类型**（store.ts）与**两个实现工厂**。
 * 装配层按是否有 PG 选择实现 —— 见 `server/index.ts`。
 */
export {
  createMemoryUsageStore,
  USAGE_LIMIT_DEFAULT,
  USAGE_LIMIT_MAX,
  clampUsageLimit,
} from './memory-store.js'
export { createPgUsageStore } from './pg-store.js'
export type {
  ListUsageFilter,
  UsageEvent,
  UsageRecord,
  UsageStore,
  UsageSummary,
} from './store.js'
