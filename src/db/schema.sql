-- lite-ai 服务端 schema（T2）
--
-- 七表分两组：
--   A. 领域模型（lite-ai 特有，HolmesGPT 没有）—— incidents / incident_members / alert_dedupe
--   B. 队列与会话 —— jobs / job_events / sessions / usage_events
--
-- 设计红线（与 src/ingest/pipeline.ts:18-21 一致）：
--   * 聚合/关联**纯规则、零 LLM**；AI 只在末端 diagnose() 参与。
--   * 一个 incident = 一个 sessionId = 一次 RCA。
--
-- 字段语义**逐条对齐现有内存实现的真实行为**（非拍脑袋）：
--   * alert_dedupe  —— 对齐 src/webhook/dedupe.ts:67-118
--       键 = alert.id（fingerprint）；窗口判定 = now - first_seen_at < silence_ms；
--       命中但内容变化 → 'updated'，此时 **first_seen_at 不推进**（dedupe.ts:108），
--       因此本表存 (first_seen_at, content_hash) 两个事实列，**不存 silence_until**
--       （silence 是"用 first_seen_at + 当前时间算出来的"，不是独立状态）。
--   * incidents / incident_members —— 对齐 src/webhook/incident-registry.ts:176-207
--       OpenIncident 的 byId Map。注意 incident_members 需要承载三样在内存里存在、
--       但 plan 首版 schema 漏掉的事实：**到达次数 seen_count**、
--       **关联理由 reasons**、**是否已恢复 resolved_at**。

-- ============================================================
-- A. 领域模型层
-- ============================================================

-- 事件（一个 incident = 一次 RCA 单元）
CREATE TABLE IF NOT EXISTS incidents (
  incident_id       TEXT PRIMARY KEY,
  -- 关联类型：'rule'（规则键/alertId 档）| 'topology'（拓扑簇）
  -- 对齐 incident-registry.ts:178 的 type: IncidentType
  type              TEXT NOT NULL CHECK (type IN ('rule', 'topology')),
  -- 键强度三档：primary / secondary / alertId
  -- 对齐 incident-registry.ts:499-504 strengthOf()
  key_strength      TEXT NOT NULL CHECK (key_strength IN ('primary', 'secondary', 'alertId')),
  -- 命中的维度键名；NULL = 无稳定维度（alertId 档 / 拓扑簇）
  key_name          TEXT,
  group_key         TEXT NOT NULL,
  -- 已积累的维度（跨批次用于兼容判定；newIsSuperset 时只升不降）
  -- 对齐 incident-registry.ts:537 incident.dimensions
  dimensions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 主告警 id（severityEscalated 时可能切换，故可更新）
  primary_alert_id  TEXT NOT NULL,
  severity          TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  last_alert_at     BIGINT NOT NULL,
  created_at        BIGINT NOT NULL,
  -- open / resolved。'resolved' 含两种来源：源侧全部成员恢复、或 TTL 静默超时
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  -- 是否已诊断过（true 时后续新成员触发"增量重分析"）
  diagnosed         BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at         BIGINT,
  updated_at        BIGINT NOT NULL
);

-- 跨批次关联要按 open 状态扫（findOpenByKey / probeMatch 均只在 open 集合里找）
CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (status, updated_at DESC);
-- 按键名 + 分组键精确探测（incident-registry.ts:620-628, 635-654）
CREATE INDEX IF NOT EXISTS incidents_open_key_idx ON incidents (key_name, group_key) WHERE status = 'open';

-- T12 并发守卫：同一 (key_name, group_key) 在 open 状态下**只允许一个事件**。
--
-- 为什么必须有：多实例同时 resolve 时，两个实例可能各拿同一份快照、各自发现
-- "无 open 事件" → 双双创建 → 同一事故被拆成两个 incident（G9 的核心故障）。
-- 内存实现靠"单线程同步临界区"天然避免；PG 必须靠部分唯一索引强制。
--
-- 注意 key_name 可为 NULL（alertId 档 / 拓扑簇），而 SQL 唯一索引把 NULL 视为互不相等
-- → 该档位不受此约束保护（其 group_key 含 alert.id / 簇身份，本身已足够唯一）。
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_unique_idx
  ON incidents (key_name, group_key)
  WHERE status = 'open' AND key_name IS NOT NULL;

-- 事件成员告警
CREATE TABLE IF NOT EXISTS incident_members (
  incident_id   TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  alert_id      TEXT NOT NULL,
  -- 到达次数：内存里是 seen: Map<alertId, count>（incident-registry.ts:188）。
  -- 用于区分"新成员"与"重复到达"（重复到达不重新烧 token）。
  seen_count    INTEGER NOT NULL DEFAULT 1,
  -- 是否主告警
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  -- 该成员的完整告警体（告警本体在内存里是完整对象数组，出库需要还原）
  alert         JSONB NOT NULL,
  -- 源侧恢复时间；NULL = 尚未收到 resolved。对齐 resolvedIds: Set<string> / resolvedAt
  resolved_at   BIGINT,
  -- 该告警被关联进来的理由（可审计 / 可解释红线）
  -- 对齐 incident-registry.ts:206 reasons: Set<CorrelationReason>
  reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at BIGINT NOT NULL,
  PRIMARY KEY (incident_id, alert_id)
);

-- markResolved 需要按 alertId 反查所属 open 事件（incident-registry.ts:440-453）
CREATE INDEX IF NOT EXISTS incident_members_alert_idx ON incident_members (alert_id);
-- 统计"全部成员均已恢复"时需要遍历成员
CREATE INDEX IF NOT EXISTS incident_members_incident_idx ON incident_members (incident_id);

-- 兜底去重 + 冷却态
-- 对齐 src/webhook/dedupe.ts:67-118 AlertDedupe 的 seen: Map<fingerprint, {hash, firstSeen}>
CREATE TABLE IF NOT EXISTS alert_dedupe (
  -- Alert.id = alertname + labels 的 fingerprint（types.computeAlertId）
  alert_id      TEXT PRIMARY KEY,
  -- 内容哈希：title|severity|summary|description|labels 的 sha1 前 16 位
  -- 内容变化 → 'updated' → 重新诊断（dedupe.ts:77-80）
  content_hash  TEXT NOT NULL,
  -- 静默窗口起点。**updated 时有意不推进**（dedupe.ts:108），
  -- 因此窗口内持续变化会连续放行——这是设计而非缺陷。
  first_seen_at BIGINT NOT NULL
);

-- 过期清理：now - first_seen_at >= silence_ms 的行可删（dedupe.ts:112-117 的 setTimeout 清理）
CREATE INDEX IF NOT EXISTS alert_dedupe_first_seen_idx ON alert_dedupe (first_seen_at);

-- ============================================================
-- B. 队列 / 会话 / 审计
-- ============================================================

-- job 队列（PG 表即队列，对齐 HolmesGPT 思路；不引 Redis/RabbitMQ）
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  -- 服务端工作区路径（见 plan G4：**不是**用户本地目录）
  cwd           TEXT NOT NULL,
  -- 人工对话 / 告警诊断 / 恢复收敛。resolve 类**不走 RCA**（恢复不烧 token）
  kind          TEXT NOT NULL CHECK (kind IN ('chat', 'alert', 'resolve')),
  -- 告警类 job 关联的事件；人工对话为 NULL
  incident_id   TEXT REFERENCES incidents(incident_id) ON DELETE SET NULL,
  -- 续聊目标会话（G2 多轮续接）；NULL = 新建会话
  session_id    TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- 认领该 job 的 worker 标识
  assignee      TEXT,
  -- 乐观并发守卫（对齐 HolmesGPT request_sequence）：reassign/更新时校验
  request_seq   INTEGER NOT NULL DEFAULT 0,
  claimed_at    BIGINT,
  finished_at   BIGINT,
  error         TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- 原子 claim 的主索引：`WHERE status='pending' ORDER BY created_at` 走这条
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, created_at);
-- per-user 隔离（T6）
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id, created_at DESC);
-- stale sweep：`WHERE status='running' AND claimed_at < ?`
CREATE INDEX IF NOT EXISTS jobs_stale_idx ON jobs (status, claimed_at);
-- 按 incident 回查 job
CREATE INDEX IF NOT EXISTS jobs_incident_idx ON jobs (incident_id);
-- 续聊：按 session 回查 job
CREATE INDEX IF NOT EXISTS jobs_session_idx ON jobs (session_id);

-- job 事件流（SSE / 轮询的**唯一**数据源，G5：不能是内存总线）
CREATE TABLE IF NOT EXISTS job_events (
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- 单调递增序号，SSE 的 Last-Event-ID 与 ?after= 增量拉取都基于它
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE INDEX IF NOT EXISTS job_events_job_seq_idx ON job_events (job_id, seq);

-- 会话（T8：从本地 JSONL 迁来；append-only 语义保留）
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL,
  -- 会话作用域（对齐 SessionStore 的 cwd 参数）
  cwd        TEXT NOT NULL,
  user_id    TEXT,
  title      TEXT,
  -- append-only 消息行，seq 递增；与 JSONL 逐行对应
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (cwd, session_id, seq)
);

CREATE INDEX IF NOT EXISTS sessions_scope_idx ON sessions (cwd, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, created_at DESC);

-- 审计用量事件（T7：银行合规"谁在何时跑了什么"）
CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  job_id      TEXT,
  session_id  TEXT,
  trace_id    TEXT,
  model       TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  status      TEXT,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_job_idx ON usage_events (job_id);

-- ============================================================
-- 原子 claim（`FOR UPDATE SKIP LOCKED`）
-- ============================================================
--
-- 语义对齐 HolmesGPT `claim_n_pending_conversations`（supabase_dal.py:1020），
-- 但用原生 SQL 而非 Supabase RPC。
--
-- 为什么必须是单条语句：`SELECT ... FOR UPDATE SKIP LOCKED` 与 `UPDATE` 必须在
-- **同一语句**里，否则两者之间有窗口期，两个 worker 会读到同一批 pending。
-- 用 CTE 把选取与更新合成一条原子语句。
CREATE OR REPLACE FUNCTION claim_jobs(
  p_assignee TEXT,
  p_limit    INTEGER DEFAULT 1
) RETURNS SETOF jobs AS $$
  WITH candidates AS (
    SELECT id
      FROM jobs
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE jobs j
     SET status     = 'running',
         assignee   = p_assignee,
         claimed_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
         updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
         request_seq = j.request_seq + 1
    FROM candidates c
   WHERE j.id = c.id
  RETURNING j.*;
$$ LANGUAGE sql;

-- stale 回收：把租约过期的 running job 打回 pending（故障转移）
--
-- 注意 **assignee 与 claimed_at 要保留**，不要清空：
-- 保留 assignee 便于排查"是哪个实例挂了"；claimed_at 供下一次 sweep 判断。
-- 真正重新认领时 claim_jobs 会覆盖 assignee 并刷新 claimed_at。
CREATE OR REPLACE FUNCTION reassign_stale_jobs(
  p_lease_ms BIGINT
) RETURNS SETOF jobs AS $$
  UPDATE jobs
     SET status     = 'pending',
         updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
   WHERE status = 'running'
     AND claimed_at IS NOT NULL
     AND claimed_at < (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint - p_lease_ms
  RETURNING *;
$$ LANGUAGE sql;
