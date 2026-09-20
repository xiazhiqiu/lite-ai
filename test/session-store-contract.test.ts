/**
 * SessionStore 契约测试（T8）——**文件实现**。
 *
 * 与 `jobs-claim.test.ts` 同一取向：**不依赖 PG，绝不 skip**。
 * 因为会话语义（system 跳过 / 幂等 / compact 截断 / snip 插回）的正确性与
 * 用什么后端无关 —— 它们错了对谁都是错的。
 *
 * PG 后端的等价性由 `session-store-pg.test.ts` 跑**同一份**契约保证。
 *
 * ## ⚠️ 隔离：这一段是本文件的**安全红线**，不要为了省几行删掉
 *
 * 契约用例会往 `LITE_AI_PROJECTS_DIR` 写临时会话，跑完要清干净。而
 * `LITE_AI_PROJECTS_DIR` 若不隔离，指向的就是**用户真实的**
 * `~/.lite-ai/projects/` —— 那个 `rm -rf` 会连带删掉用户本机的真实会话历史
 * （`fs.rm` 是 unlink，**不走回收站，不可恢复**）。
 *
 * 这不是假想事故：本文件初版没做隔离，跑一次就把该目录连带用户的真实会话
 * 一起删掉了。而 `node:test` 按文件并行，同一时刻 `session.test.ts` 也在这块
 * 目录上作业，排查起来会更乱。
 *
 * 所以沿用 `session-store.test.ts` 的成熟做法：
 * 1. 先在模块体最前面把 `LITE_AI_HOME` 指到**专属临时目录**；
 * 2. 因为 ESM 的静态 import 会被提升（写在文件第几行都没用，一定先于模块体执行），
 *    必须用**动态 import** 才能在"设完环境变量之后"才加载 `src/config.js`；
 * 3. 加**自检**：断言该常量确实落在隔离目录内 —— 万一有人改回静态 import，
 *    这里立刻炸，而不是等到弄脏了用户数据才发现。
 */
import { after } from 'node:test'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 专属 HOME（与 `session-store.test.ts` 用不同名字，避免并行互删）。 */
const ISOLATED_HOME = path.join(os.tmpdir(), 'lite-ai-session-contract-home')
process.env.LITE_AI_HOME = ISOLATED_HOME
await rm(ISOLATED_HOME, { recursive: true, force: true })

// 环境变量设好之后再加载被测模块（动态 import 不会被提升）
const { LITE_AI_PROJECTS_DIR } = await import('../src/config.js')
const { createFileSessionStore } = await import('../src/session/file-store.js')
const { runSessionStoreContract } = await import('./helpers/session-store-contract.js')

// 自检：隔离失效就立刻失败，绝不带病跑
if (!LITE_AI_PROJECTS_DIR.startsWith(ISOLATED_HOME)) {
  throw new Error(
    `测试隔离失效：LITE_AI_PROJECTS_DIR=${LITE_AI_PROJECTS_DIR} 不在 ${ISOLATED_HOME} 内`,
  )
}

const makeStore = () => createFileSessionStore()

runSessionStoreContract('file', makeStore)

after(async () => {
  try {
    await rm(ISOLATED_HOME, { recursive: true, force: true })
  } catch {
    /* 目录不存在也算清理完成 */
  }
})
