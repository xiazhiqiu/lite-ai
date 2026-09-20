/**
 * 会话存储抽象（SessionStore）。
 *
 * 定位：**服务化改造的唯一关键 seam**。当前 lite-ai 的会话读写全部收敛在
 * `src/session.ts`，落盘为 `projects/<cwd-转义>/<sessionId>.jsonl`（append-only）。
 * 把它抽成接口后，服务端只需换一个实现（PG），**不必动 `agent-loop.ts` 一行**。
 *
 * 设计约束（不可违反）：
 * - **对外签名不变**：`src/session.ts` 现在导出的自由函数签名保持原样，
 *   内部委托给本接口的默认实现。这是"CLI 行为零变化"的硬保证。
 * - **append-only 语义**：`append*` 系列只追加，不重写历史（对齐现有 jsonl 设计）。
 * - **cwd 作用域**：所有方法都带 `cwd`，因为现有实现按 cwd 分目录隔离会话。
 * - **失败降级**：读失败（不存在 / 损坏）返回 `null`，不抛异常（沿用现有语义）。
 */
import type { ChatMessage } from '../types.js'
import type { CollapseSpan, ContextCollapseState } from '../compact/context-collapse.js'
import type {
  PersistedTranscriptEntry,
  ProjectMeta,
  SessionMeta,
  SnipBoundaryMetadata,
} from './types.js'

/** 会话存储后端。文件实现见 `file-store.ts`；PG 实现见 `pg-store.ts`（T8）。 */
export interface SessionStore {
  /** 追加保存消息（append-only，按 message.id / alreadySavedCount 去重）。 */
  save(
    cwd: string,
    sessionId: string,
    messages: ChatMessage[],
    alreadySavedCount?: number,
  ): Promise<void>

  /** 读取会话消息；不存在或损坏返回 null。 */
  load(cwd: string, sessionId: string): Promise<ChatMessage[] | null>

  /** 删除会话（不存在不报错）。 */
  clear(cwd: string, sessionId: string): Promise<void>

  /** 列出该 cwd 下所有会话元信息，按 updatedAt 降序。 */
  list(cwd: string): Promise<SessionMeta[]>

  /** 重命名会话；不存在返回 false。 */
  rename(cwd: string, sessionId: string, newTitle: string): Promise<boolean>

  /** 从已有会话派生出独立副本，返回新 sessionId；源不存在返回 null。 */
  fork(cwd: string, sessionId: string): Promise<string | null>

  /** 清理超过 maxAgeMs 未更新的会话，返回删除条数。 */
  cleanupExpired(cwd: string, maxAgeMs: number): Promise<number>

  /** 列出所有含会话的项目。 */
  listProjects(): Promise<ProjectMeta[]>

  /** 重建可供 TUI 回显的 transcript；不存在返回 null。 */
  loadTranscript(cwd: string, sessionId: string): Promise<PersistedTranscriptEntry[] | null>

  /** 追加 snip 边界事件。 */
  appendSnipBoundary(
    cwd: string,
    sessionId: string,
    boundaryMessage: Extract<ChatMessage, { role: 'snip_boundary' }>,
  ): Promise<void>

  /** 追加 context collapse span。 */
  appendContextCollapseSpan(cwd: string, sessionId: string, span: CollapseSpan): Promise<void>

  /** 追加 compact 边界（含摘要与保留消息）。 */
  appendCompactBoundary(
    cwd: string,
    sessionId: string,
    summaryText: string,
    trigger: 'auto' | 'manual',
    preTokens: number,
    postTokens: number,
    retainedMessages?: ChatMessage[],
  ): Promise<void>

  /** 读取 context collapse 状态；无 span 返回 null。 */
  loadContextCollapseState(cwd: string, sessionId: string): Promise<ContextCollapseState | null>
}

export type { PersistedTranscriptEntry, ProjectMeta, SessionMeta, SnipBoundaryMetadata }
