/**
 * JobStore 契约测试（T2，plan G6）——**内存实现**。
 *
 * 核心断言是**并发正确性**——这正是选异步队列的全部理由，因此**绝不 skip**：
 * 内存实现无外部依赖，任何环境都能跑，把「并发 claim 不重复分配」「stale 回收」
 * 变成可自动化证明的事实。
 *
 * PG 实现必须通过**同一组契约**：见 `jobs-claim-pg.test.ts`（两者都调用
 * `helpers/job-store-contract.ts` 的 `runJobStoreContract`）。
 */
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { runJobStoreContract } from './helpers/job-store-contract.js'

runJobStoreContract('memory', () => createMemoryJobStore())
