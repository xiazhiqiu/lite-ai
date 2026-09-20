/**
 * 会话持久化的**对外门面**。
 *
 * 本轮（T1）起，具体实现已迁到 `src/session/file-store.ts`（`SessionStore` 接口的
 * 文件后端）。本文件**只保留原有导出签名**并委托给 store —— 这样所有调用方
 * （`tty-app.ts` / `agent-loop.ts` / `diagnose.ts` / `cli-commands.ts` …）**零改动**，
 * 是"CLI 行为零变化"的硬保证。
 *
 * 服务化时（T8）只需把 `getSessionStore()` 换成 PG 实现即可，本文件签名依旧不变。
 */
import type { ChatMessage } from './types.js'
import type { CollapseSpan, ContextCollapseState } from './compact/context-collapse.js'
import { createFileSessionStore } from './session/file-store.js'
import type { SessionStore } from './session/store.js'
import type {
  PersistedTranscriptEntry,
  ProjectMeta,
  SessionMeta,
} from './session/types.js'

export type { PersistedTranscriptEntry, ProjectMeta, SessionMeta }

/** 当前存储后端。默认文件实现；服务化时（T8）按配置切换为 PG。 */
let activeStore: SessionStore | null = null

/** 取当前存储后端（惰性单例）。测试可通过 `setSessionStore` 注入。 */
export function getSessionStore(): SessionStore {
  if (activeStore === null) {
    activeStore = createFileSessionStore()
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
