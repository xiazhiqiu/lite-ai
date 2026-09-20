/**
 * 会话持久化的**对外门面**。
 *
 * 本轮（T1）起，具体实现已迁到 `src/session/file-store.ts`（`SessionStore` 接口的
 * 文件后端）。本文件**只保留原有导出签名**并委托给 store —— 这样所有调用方
 * （`tty-app.ts` / `agent-loop.ts` / `diagnose.ts` / `cli-commands.ts` …）**零改动**，
 * 是"CLI 行为零变化"的硬保证。
 *
 * T8 起后端可切换：`LITE_AI_SESSION_BACKEND=pg|file`（未指定则按是否有 PG 配置推导，
 * 见 `config.ts:resolveSessionBackend`）。**本文件签名依旧不变** —— 换的只是
 * `getSessionStore()` 返回的实现。
 */
import type { ChatMessage } from './types.js'
import type { CollapseSpan, ContextCollapseState } from './compact/context-collapse.js'
import { resolveSessionBackend } from './config.js'
// `requirePgPool` 静态 import：本仓库是 ESM（`"type": "module"`），
// 不能在这里用 `require()` —— 运行期它会直接是 undefined。
// 静态 import 的代价是 pg 驱动总被加载，但 `pg` 已是 dependencies 的硬依赖
// （jobs/usage 的 PG 后端都要它），所以没有额外负担。
import { requirePgPool } from './db/pool.js'
import { createFileSessionStore } from './session/file-store.js'
import { createPgSessionStore } from './session/pg-store.js'
import type { SessionStore } from './session/store.js'
import type {
  PersistedTranscriptEntry,
  ProjectMeta,
  SessionMeta,
} from './session/types.js'

export type { PersistedTranscriptEntry, ProjectMeta, SessionMeta }

/** 当前存储后端。默认文件实现；T8 起按配置切换（见下方 `getSessionStore`）。 */
let activeStore: SessionStore | null = null

/**
 * 按配置创建存储后端。
 *
 * ## 为什么是 `async` 而 `getSessionStore()` 是同步的
 *
 * PG 路径需要动态 `import('pg')`（本仓库是 ESM，`package.json` 的 `"type": "module"`
 * 让 `require()` 在运行期直接不存在）。而 `getSessionStore()` 有大量同步调用方
 * （`agent-loop.ts` / `tty-app.ts` / `diagnose.ts`），改签名就等于破坏 T1 定下的
 * "对外签名不变"红线 —— 那正是"CLI 行为零变化"的保证。
 *
 * 折中：**同步只负责建对象**。`pg` 驱动在**模块顶层静态 import**（见文件头部），
 * 于是这里同步调用即可；建池本身也是同步的（`pg.Pool` 构造函数不连库，
 * 首次 `query()` 才连）。所以整条路径不需要 await。
 */
function createStoreForBackend(): SessionStore {
  const backend = resolveSessionBackend()
  if (backend === 'file') return createFileSessionStore()

  // 显式要求 pg 就真的用 pg，连不上就报错。**不 catch 回退** ——
  // 静默降级到文件后端会让部署方看到"服务起来了"却以为会话在库里，
  // 多实例下表现成"聊完刷新就丢"，比启动失败难查得多。
  return createPgSessionStore(requirePgPool())
}

/** 取当前存储后端（惰性单例）。测试可通过 `setSessionStore` 注入。 */
export function getSessionStore(): SessionStore {
  if (activeStore === null) {
    activeStore = createStoreForBackend()
  }
  return activeStore
}

/** 替换存储后端（测试 / 服务化切换用）。 */
export function setSessionStore(store: SessionStore | null): void {
  activeStore = store
}

/**
 * 存储抽象的委托实现（`session.ts` 对外签名与 `SessionStore` 一一对应）。
 * 迁到 PG 后端时，这些函数**一行都不用改** —— 换的是 `getSessionStore()` 的返回实现。
 */

export async function saveSession(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
  alreadySavedCount: number = 0,
): Promise<void> {
  return getSessionStore().save(cwd, sessionId, messages, alreadySavedCount)
}

export async function loadSession(
  cwd: string,
  sessionId: string,
): Promise<ChatMessage[] | null> {
  return getSessionStore().load(cwd, sessionId)
}

export async function clearSession(cwd: string, sessionId: string): Promise<void> {
  return getSessionStore().clear(cwd, sessionId)
}

export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  return getSessionStore().list(cwd)
}

export async function renameSession(
  cwd: string,
  sessionId: string,
  newTitle: string,
): Promise<boolean> {
  return getSessionStore().rename(cwd, sessionId, newTitle)
}

export async function forkSession(cwd: string, sessionId: string): Promise<string | null> {
  return getSessionStore().fork(cwd, sessionId)
}

export async function cleanupExpiredSessions(cwd: string, maxAgeMs: number): Promise<number> {
  return getSessionStore().cleanupExpired(cwd, maxAgeMs)
}

export async function listAllProjects(): Promise<ProjectMeta[]> {
  return getSessionStore().listProjects()
}

export async function loadTranscript(
  cwd: string,
  sessionId: string,
): Promise<PersistedTranscriptEntry[] | null> {
  return getSessionStore().loadTranscript(cwd, sessionId)
}

export async function appendSnipBoundary(
  cwd: string,
  sessionId: string,
  boundaryMessage: Extract<ChatMessage, { role: 'snip_boundary' }>,
): Promise<void> {
  return getSessionStore().appendSnipBoundary(cwd, sessionId, boundaryMessage)
}

export async function appendContextCollapseSpan(
  cwd: string,
  sessionId: string,
  span: CollapseSpan,
): Promise<void> {
  return getSessionStore().appendContextCollapseSpan(cwd, sessionId, span)
}

export async function appendCompactBoundary(
  cwd: string,
  sessionId: string,
  summaryText: string,
  trigger: 'auto' | 'manual',
  preTokens: number,
  postTokens: number,
  retainedMessages: ChatMessage[] = [],
): Promise<void> {
  return getSessionStore().appendCompactBoundary(
    cwd, sessionId, summaryText, trigger, preTokens, postTokens, retainedMessages,
  )
}

export async function loadContextCollapseState(
  cwd: string,
  sessionId: string,
): Promise<ContextCollapseState | null> {
  return getSessionStore().loadContextCollapseState(cwd, sessionId)
}
