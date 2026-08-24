/**
 * 本地可观测性：将 agent 运行指标以追加式事件写入 SQLite（默认开启，
 * 设 LITE_AI_METRICS=0 可关闭）。
 *
 * 参考 Langfuse 的维度映射：
 *   - llm_calls  ≈ Generation  ：每次模型调用的 token / 时延 / stop_reason
 *   - tool_calls ≈ Span        ：每次工具调用的成败 / 匹配 / 时延
 *   - turns      ≈ Trace       ：每个 agent 回合的步数 / 空转 / 上下文利用率
 *
 * 设计约束：采集失败必须静默降级，绝不影响主流程。
 */

import crypto from 'node:crypto'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const ENABLED = process.env.LITE_AI_METRICS !== '0'

let db: Database.Database | null = null

export type LlmCallRecord = {
  model?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  latencyMs?: number
  stopReason?: string
  error?: string
}

export type ToolCallRecord = {
  toolName: string
  ok: boolean
  latencyMs?: number
  /** 'unknown' = 模型请求了不存在的工具；'schema' = 参数校验失败。 */
  mismatch?: 'unknown' | 'schema'
  error?: string
}

export type TurnRecord = {
  model?: string
  steps: number
  toolCalls: number
  toolErrors: number
  emptyResponses: number
  thinkingRetries: number
  midtaskContinuations: number
  contextUtilization: number
  maxStepsHit: boolean
  durationMs: number
  error?: string
}

/** 调用时解析 DB 路径：跟随当前 process.env.LITE_AI_HOME，便于测试切换到隔离库。 */
export function metricsDbPath(): string {
  const home = process.env.LITE_AI_HOME?.trim()
    ? path.resolve(process.env.LITE_AI_HOME)
    : path.join(os.homedir(), '.lite-ai')
  return path.join(home, 'metrics.db')
}

function getDb(): Database.Database | null {
  if (!ENABLED) return null
  if (db) return db
  const dbPath = metricsDbPath()
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    // 跨进程（interactive 会话与 --webhook 自动诊断）可能同时写库；
    // 设忙等超时避免 SQLITE_BUSY 导致指标静默丢失。
    db.pragma('busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_calls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        turn_id       TEXT,
        model         TEXT,
        provider      TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        total_tokens  INTEGER,
        latency_ms    INTEGER,
        stop_reason   TEXT,
        error         TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        turn_id    TEXT,
        tool_name  TEXT NOT NULL,
        ok         INTEGER NOT NULL,
        latency_ms INTEGER,
        mismatch   TEXT,
        error      TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                   INTEGER NOT NULL,
        turn_id              TEXT UNIQUE,
        model                TEXT,
        steps                INTEGER NOT NULL,
        tool_calls           INTEGER NOT NULL,
        tool_errors          INTEGER NOT NULL,
        empty_responses      INTEGER NOT NULL,
        thinking_retries     INTEGER NOT NULL,
        midtask_continuations INTEGER NOT NULL,
        context_utilization  REAL,
        max_steps_hit        INTEGER NOT NULL,
        duration_ms          INTEGER NOT NULL,
        error                TEXT
      );
    `)
    migrate(db)
    return db
  } catch {
    // 观测层不可用（如 better-sqlite3 原生模块加载失败）→ 静默关闭。
    db = null
    return null
  }
}

/**
 * 为既有库补 turn_id 列（CREATE TABLE IF NOT EXISTS 不会给已存在表加列）。
 * turns 走 UNIQUE 索引退化方案，兼容带历史行的旧库。
 */
function migrate(database: Database.Database): void {
  const cols = (table: string): string[] =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
  if (!cols('llm_calls').includes('turn_id')) {
    database.exec('ALTER TABLE llm_calls ADD COLUMN turn_id TEXT')
  }
  if (!cols('tool_calls').includes('turn_id')) {
    database.exec('ALTER TABLE tool_calls ADD COLUMN turn_id TEXT')
  }
  if (!cols('turns').includes('turn_id')) {
    try {
      database.exec('ALTER TABLE turns ADD COLUMN turn_id TEXT UNIQUE')
    } catch {
      // 对带历史行的库直接加 UNIQUE 列可能失败 → 退化为普通列 + 唯一索引（仅对非 NULL 生效）。
      database.exec('ALTER TABLE turns ADD COLUMN turn_id TEXT')
      database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_turn_id ON turns(turn_id) WHERE turn_id IS NOT NULL')
    }
  }
}

/**
 * 可观测性指标集合（回合级收集器）。
 *
 * 一个 agent 回合创建一个 scope：回合内模型调用 / 工具执行只 push 到内存，
 * 回合结束时 flush() 在一个 SQLite 事务里一次性写入本回合的全部 llm + tool + turn 行。
 * 所有行共享同一 turn_id，便于按回合回溯调用链（Langfuse Trace 语义）。
 */
export type TurnScope = {
  turnId: string
  pushLlm(record: LlmCallRecord): void
  pushTool(record: ToolCallRecord): void
  flush(turn: TurnRecord): void
}

type Row = { ts: number }

type Batch = {
  turnId?: string
  llm: (LlmCallRecord & Row)[]
  tool: (ToolCallRecord & Row)[]
  turn?: (TurnRecord & Row)
}

function toNull<T>(v: T | undefined): T | null {
  return v ?? null
}

/** 把一批指标（llm + tool + turn）在单个事务内写入。任一失败静默吞掉。 */
function writeBatch(batch: Batch): void {
  const database = getDb()
  if (!database) return
  try {
    const insertLlm = database.prepare(
      `INSERT INTO llm_calls
         (ts, turn_id, model, provider, input_tokens, output_tokens, total_tokens, latency_ms, stop_reason, error)
       VALUES
         (@ts, @turnId, @model, @provider, @inputTokens, @outputTokens, @totalTokens, @latencyMs, @stopReason, @error)`,
    )
    const insertTool = database.prepare(
      `INSERT INTO tool_calls (ts, turn_id, tool_name, ok, latency_ms, mismatch, error)
       VALUES (@ts, @turnId, @toolName, @ok, @latencyMs, @mismatch, @error)`,
    )
    const insertTurn = database.prepare(
      `INSERT INTO turns
         (ts, turn_id, model, steps, tool_calls, tool_errors, empty_responses, thinking_retries,
          midtask_continuations, context_utilization, max_steps_hit, duration_ms, error)
       VALUES
         (@ts, @turnId, @model, @steps, @toolCalls, @toolErrors, @emptyResponses, @thinkingRetries,
          @midtaskContinuations, @contextUtilization, @maxStepsHit, @durationMs, @error)`,
    )
    const turnId = batch.turnId ?? null
    database.transaction(() => {
      for (const r of batch.llm) {
        insertLlm.run({
          ts: r.ts,
          turnId,
          model: toNull(r.model),
          provider: toNull(r.provider),
          inputTokens: toNull(r.inputTokens),
          outputTokens: toNull(r.outputTokens),
          totalTokens: toNull(r.totalTokens),
          latencyMs: toNull(r.latencyMs),
          stopReason: toNull(r.stopReason),
          error: toNull(r.error),
        })
      }
      for (const r of batch.tool) {
        insertTool.run({
          ts: r.ts,
          turnId,
          toolName: r.toolName,
          ok: r.ok ? 1 : 0,
          latencyMs: toNull(r.latencyMs),
          mismatch: toNull(r.mismatch),
          error: toNull(r.error),
        })
      }
      if (batch.turn) {
        insertTurn.run({
          ts: batch.turn.ts,
          turnId,
          model: toNull(batch.turn.model),
          steps: batch.turn.steps,
          toolCalls: batch.turn.toolCalls,
          toolErrors: batch.turn.toolErrors,
          emptyResponses: batch.turn.emptyResponses,
          thinkingRetries: batch.turn.thinkingRetries,
          midtaskContinuations: batch.turn.midtaskContinuations,
          contextUtilization: batch.turn.contextUtilization,
          maxStepsHit: batch.turn.maxStepsHit ? 1 : 0,
          durationMs: batch.turn.durationMs,
          error: toNull(batch.turn.error),
        })
      }
    })()
  } catch {
    // ignore
  }
}

/** 回合级收集器工厂。flush 幂等：只落盘一次，之后 push/flush 均忽略。 */
export function createTurnScope(): TurnScope {
  const turnId = crypto.randomUUID()
  let llm: (LlmCallRecord & Row)[] = []
  let tool: (ToolCallRecord & Row)[] = []
  let flushed = false
  return {
    turnId,
    pushLlm(record) {
      if (flushed) return
      llm.push({ ts: Date.now(), ...record })
    },
    pushTool(record) {
      if (flushed) return
      tool.push({ ts: Date.now(), ...record })
    },
    flush(turn) {
      if (flushed) return
      flushed = true
      const pendingLlm = llm
      const pendingTool = tool
      llm = []
      tool = []
      writeBatch({
        turnId,
        llm: pendingLlm,
        tool: pendingTool,
        turn: { ts: Date.now(), ...turn },
      })
    },
  }
}

export function recordLlmCall(record: LlmCallRecord): void {
  writeBatch({ llm: [{ ts: Date.now(), ...record }], tool: [] })
}

export function recordToolCall(record: ToolCallRecord): void {
  writeBatch({ llm: [], tool: [{ ts: Date.now(), ...record }] })
}

export function recordTurn(record: TurnRecord): void {
  writeBatch({ llm: [], tool: [], turn: { ts: Date.now(), ...record } })
}

/** 测试钩子：清空模块内缓存的 db 连接，使下次写入用最新 LITE_AI_HOME 重建。 */
export function _resetMetricsForTest(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // ignore
    }
    db = null
  }
}

/** 供 /metrics 类命令查看最近记录条数（可选）。 */
export function metricsEnabled(): boolean {
  return ENABLED
}
