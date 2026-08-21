# 内置只读数据源 Toolset —— 实现计划

> 状态：待批准实施（v3，工具名对齐 HolmesGPT 原名；在 v2 预置范式基础上把「SQL」database toolset 纳入首期）
> 上游提案：[multi-source-query-tools.md](./multi-source-query-tools.md)
> 调研依据：HolmesGPT（CNCF 推荐 SRE agent）`holmes/plugins/toolsets` 本地源码（prometheus/elasticsearch/kubernetes/database）工具名与参数、官方数据源文档、Keep provider 模式、LiteAI 现有工具/权限系统（src/tool.ts、src/tools/index.ts、src/permissions.ts）

## 0. 为什么 v1 要废弃

v1 的路线是"给 `dataSources[]` 加 `type` 字段，按已配置 type **动态注册**对应工具，只有配置了才注册"。这条路线有三处不符 HolmesGPT 的做法：

1. **方向反了**。HolmesGPT 是**代码预置全部常用 toolset（插头都在），配置只决定 `enabled` 与连接参数**。v1 反过来让"新增数据源"几乎总是要写一个 native 适配器，本质还是"每源写代码"，没有兑现"填配置即用"。
2. **配置模型割裂**。v1 靠 `name`/`hint` 关键词回退匹配数据源实例，脆弱；HolmesGPT 用"按名字覆盖启用 + 独立 toolset 配置"定位，确定性强、支持多实例。
3. **缺状态可见性**。HolmesGPT 让用户能一眼看到每个 toolset 是 enabled 还是 disabled（如 `✓ kubernetes (enabled)` / `✗ prometheus (disabled - no URL configured)`），v1 无此能力。

本 v3 对齐 HolmesGPT：**预置 `prometheus/metrics` / `elasticsearch/data`(+cluster) / `kubernetes/core`(+logs) / `database`(SQL) 四个内置 toolset，用户写 `toolsets: { <name>: {...} }` 启用并填 config 即用；工具名与参数对齐 HolmesGPT 原名**。

---

## 1. 目标

把"让模型拼 shell/curl 查数据源"改为"**预置的、结构上只读的 toolset，配置启用即用**"，从根上消除 curl 审批弹窗、非交互取不到数、诊断无法收敛的问题。

首期交付 4 个内置 toolset（prometheus、elasticsearch、kubernetes、database/SQL）+ 配置系统（`toolsets` 顶层项 + env 占位解析）+ 状态展示 + 提示词引导 + 测试。新增数据源 = 按 §8 模式预置一个（或零代码走 MCP）。

## 2. 核心范式（对照 HolmesGPT）

| HolmesGPT 做法 | 本项目（LiteAI）落地 |
| --- | --- |
| 代码预置全部内置 toolset，`enabled` 默认 false | 预置 `prometheus/metrics`、`elasticsearch/data`(+cluster)、`kubernetes/core`(+logs)、`database` 四个 toolset，不配 config 时不暴露任何工具 |
| 用户 `toolsets: <name>:` 按名字覆盖启用并填 `config` | `settings.json` 顶层新增 `toolsets`，与 `mcpServers` 平级；同名 key 覆盖预置项 |
| `enabled` + `config` 决定是否暴露工具 | 解析后：`enabled` 缺省 true，但 **config 不完整 → prerequisite 判定 disabled** 并提供原因 |
| 多实例：`multi_instance` 包装同 class 多 config | 同一 toolset 可配置多个 `name`（如 `orders-mysql` 与 `analytics-mysql` 同 `type: database`，见 §5.3）|
| config 内 `{{ env.X }}` 占位注入 | 统一 `resolveEnvTemplate` 在解析时替换，密钥不落盘 |
| 工具集启停状态可视化（`/tools`） | TUI 状态栏 / `npm run tools` 展示各 toolset enabled/disabled 及原因 |
| `ToolsetPrerequisite` 预检缺 URL/凭据 | `checkToolset(config): { ok, reason }`，失败则工具不暴露 |
| 内置 toolset 自动只读（Kubernetes 只 get/list/watch；database `read_only` 默认 true） | 本 feature 的所有 toolset 工具一律 `isReadOnly: true` + `isParallelSafe: () => true` |

> "结构上只读即免审批"：本 feature 的所有 toolset 工具**不进 `PermissionManager.ensureCommand`**（不开 shell），故 curl 审批弹窗从根上消失。`run_command` / `sre-whitelist` / `authorizedUrlPrefixes` 仅作通用 shell 兜底保留。

## 3. 配置模型（src/config.ts）

`LiteAISettings` 新增顶层键（与 `dataSources[]`、`mcpServers` 并存，向下兼容）：

```ts
export type LLMToolSetConfig = {
  /** 启用该 toolset。缺省 true；但 config 不完整时仍按 prerequisite 判 disabled。 */
  enabled?: boolean
  /** 连接参数，随 toolset 而异；支持 {{ env.X }} 占位。 */
  config?: Record<string, unknown>
}

export type LiteAISettings = {
  // ...existing
  dataSources?: DataSourceConfig[]   // 保留：仍注入提示词作"你知道有这些源"
  /** 内置/可扩展 toolset 启用配置，与 mcpServers 平级。name → 配置。 */
  toolsets?: Record<string, LLMToolSetConfig>
}
```

- 解析顺序沿用 `loadEffectiveSettings`（claude settings > 全局 mcp > 项目 mcp > lite-ai settings）。
- 新增 `resolveEnvTemplate(value: unknown, env): unknown`：把 string 中的 `{{ env.NAME }}` 替换为 `env[NAME]`，未命中保留原文；用于 headers/url/凭据等。
- 老配置（无 `toolsets`）不受影响：各内置 toolset 因无 config → prerequisite 判定 disabled，工具不暴露，行为与现状一致。

## 4. 变更清单

| # | 文件 | 内容 |
| --- | --- | --- |
| 1 | `src/config.ts` | 新增 `LLMToolSetConfig`、`LiteAISettings.toolsets`、`resolveEnvTemplate`、`checkToolset`（prerequisite 检查）、`loadResolvedToolsets()` |
| 2 | `src/tools/data-sources/registry.ts`（新增） | `DATA_SOURCE_TOOLSETS` 预置注册表（所有代码预置的 toolset 定义）、`enabledToolsetsFor(settings)` 按配置产出启用集合；工具名对齐 HolmesGPT |
| 3 | `src/tools/data-sources/base.ts`（新增） | `DataSourceTool` 工厂：统一 `isReadOnly:true`、`isParallelSafe:()=>true`、`clampToolOutput`、`matchInstance`（多实例定位）|
| 4 | `src/tools/data-sources/prometheus.ts` | `prometheusToolset`：8 个工具（对齐 HolmesGPT `prometheus/metrics`，见 §6.1）|
| 5 | `src/tools/data-sources/elasticsearch.ts` | `elasticsearchDataToolset` / `elasticsearchClusterToolset`：8 个工具（对齐 `elasticsearch/data` + `elasticsearch/cluster`，见 §6.2）|
| 6 | `src/tools/data-sources/kubernetes.ts` | `kubernetesToolset`：3 个核心工具（对齐 `kubernetes/core`，见 §6.3）|
| 7 | `src/tools/data-sources/database.ts` | `dbToolset`：3 个工具（对齐 HolmesGPT `database`，见 §6.4，SQL 只读白名单）|
| 8 | `src/tools/index.ts` | `createDefaultToolRegistry` 接入 `enabledToolsetsFor(runtime)` 产出的工具；仍早于 `subsetForSubAgent` 注册，`isReadOnly:true` 自动进子 agent 白名单 |
| 9 | `src/tui/*`（状态栏）+ `src/cli-commands.ts` | 展示各 toolset enabled/disabled 及原因（可选 `npm run tools`）|
| 10 | `src/prompt.ts` | 数据源段落改为引导优先用各内置 toolset 工具；仅列已启用 toolset |
| 11 | `test/data-source-tools.test.ts`（新增） | 覆盖 §7 全部用例 |
| 12 | `test/data-sources-prompt.test.ts`（更新） | 断言提示词只引导已启用工具 |

不删除 `run_command`、`sre-whitelist`、`authorizedUrlPrefixes`。

## 5. 预置 toolset 注册表与状态

### 5.1 注册表（src/tools/data-sources/registry.ts）

```ts
export type DataSourceToolset =
  | ({
      /** toolset 类型：区分不同源，配置按 type 匹配。 */
      type: 'prometheus' | 'elasticsearch' | 'kubernetes' | 'database'
    } & {
      /** 需要的 config 字段 + 各自 prerequisite 校验 */
      checkConfig(cfg: Record<string, unknown>): { ok: boolean; reason?: string }
      buildTools(cfg: ResolvedToolsetConfig): ToolDefinition<unknown>[]
    })

/** 代码预置的全部 toolset。新增源 = 在此登记一行。 */
export const DATA_SOURCE_TOOLSETS: DataSourceToolset[] = [
  prometheusToolset, elasticsearchDataToolset, elasticsearchClusterToolset,
  kubernetesToolset, dbToolset,
  // lokiToolset, datadogToolset, ... 后续预置
]
```

- `enabledToolsetsFor(settings)`：遍历 `settings.toolsets`，`name` 命中注册表 → `checkConfig` 通过 → `buildTools`；未命中但类型自定义 → 不报错、提示走 MCP。
- 注册在 `createDefaultToolRegistry` 内（async 已 await）→ 早于 `subsetForSubAgent` → 只读工具自动进子 agent 白名单；CLI 与 webhook 双端生效。

### 5.2 prerequisite（复用 §4 的 `checkToolset`）

对齐 HolmesGPT 展示"缺什么"：

- `prometheus`：缺 `prometheus_url` → `{ ok:false, reason: 'prometheus toolset disabled: missing prometheus_url in settings.toolsets.prometheus.config' }`
- `elasticsearch`：缺 `api_url` → 对应 reason
- `kubernetes`：无需连接参数（继承当前用户 kubeconfig）→ 配不配 `config` 均可启用
- `database`：缺 `connection_url` → 对应 reason

### 5.3 多实例（对齐 HolmesGPT `multi_instance` 与 `type: database`）

同一 database 配置可提供多个实例（与 HolmesGPT `orders-mysql` / `analytics-mysql` 同 type 多 name 一致）：

```json
"toolsets": {
  "orders-mysql":   { "type": "database", "config": { "connection_url": "mysql+pymysql://user:pass@orders.example.com:3306/orders" } },
  "analytics-pg":   { "type": "database", "config": { "connection_url": "postgresql://user:pass@analytics.example.com:5432/analytics" } },
  "es":             { "type": "elasticsearch", "config": { "api_url": "http://localhost:19200" } },
  "es_analytics":   { "type": "elasticsearch", "config": { "api_url": "http://analytics:9200" } }
}
```

- 工具名含前缀：database 工具名 = `{name}_query` / `{name}_list_tables` / `{name}_describe_table`（对齐 HolmesGPT `tool_prefix = re.sub('[^a-zA-Z0-9]+', '_', name)`，故 `orders-mysql` → `orders_mysql_query`）。
- 固定 toolset（prometheus/elasticsearch/kubernetes）工具名不含实例名；多实例通过入参 `inst?: string` 定位（缺省取第一个）。
- 命名去重：`ToolRegistry.addTools` 已跳过重名。后续如跨 type 冲突再引入实例后缀。

## 6. 工具接口（src/tools/data-sources/*.ts，工具名对齐 HolmesGPT）

统一由 `DataSourceTool` 工厂产出：`isReadOnly: true`、`isParallelSafe: () => true`、`run` 内先定位实例再发请求、输出过 `clampToolOutput`（`MAX_TOOL_OUTPUT=200_000`）。

### 6.1 prometheus/metrics（8 个工具，对齐 `holmes/plugins/toolsets/prometheus/prometheus.py`）

| 工具名 | 入参 | 端点 |
| --- | --- | --- |
| `list_prometheus_rules` | `type?`(alert/record), `rule_name?`, `rule_group?`, `file?` | `GET /api/v1/rules` |
| `get_metric_names` | `metric?`, `start?`, `end?` | `/api/v1/label/__name__/values` |
| `get_label_values` | `label`, `match?`, `start?`, `end?` | `/api/v1/label/{label}/values` |
| `get_all_labels` | `match?`, `start?`, `end?` | `/api/v1/labels` |
| `get_series` | `match`(可多值), `start?`, `end?` | `/api/v1/series` |
| `get_metric_metadata` | `metric?`, `limit?` | `/api/v1/metadata` |
| `execute_prometheus_instant_query` | `query`, `description`, `timeout?` | `GET /api/v1/query` |
| `execute_prometheus_range_query` | `query`, `description`, `start`, `end`, `step`, `output_type?`(matrix/vector), `timeout?`, `max_points?` | `GET /api/v1/query_range` |

- 端点只读，无写面。认证：`additional_headers`（经 `resolveEnvTemplate`）或 `additional_labels` 惰性注入。
- 对齐关键：instant/range 拆分为两个独立工具（v1 用 `prom_query` + `instant/range` 布尔合并，改为 HolmesGPT 拆分模型）；采样点以 `max_points` 兜底（软限 `MAX_GRAPH_POINTS`、硬限 `HARD_LIMIT`），超限自动调大 `step` 并标注。

> 注：`execute_prometheus_instant_query`/`execute_prometheus_range_query` 的 `query` + `description` 均在 HolmesGPT 中为 required。

### 6.2 elasticsearch/data + elasticsearch/cluster（8 个工具，对齐 `elasticsearch.py`）

`elasticsearch/data`（索引级只读，3 个）：

| 工具名 | 入参 | 端点 |
| --- | --- | --- |
| `elasticsearch_search` | `index`, `dsl`, `size?`(default 50, clamp `<=100`), `sort?`, `from?` | `POST {api_url}/{index}/_search` |
| `elasticsearch_mappings` | `index` | `GET {api_url}/{index}/_mapping` |
| `elasticsearch_list_indices` | `pattern?` | `GET {api_url}/_cat/indices/{pattern}?format=json` |

`elasticsearch/cluster`（集群级只读，5 个）：

| 工具名 | 入参 | 端点 |
| --- | --- | --- |
| `elasticsearch_cat` | `endpoint`(indices/shards/nodes/...), `format?` | `GET {api_url}/_cat/{endpoint}` |
| `elasticsearch_cluster_health` | `index?` | `GET {api_url}/_cluster/health` |
| `elasticsearch_index_stats` | `index` | `GET {api_url}/{index}/_stats` |
| `elasticsearch_allocation_explain` | `index?` | `POST {api_url}/_cluster/allocation/explain` |
| `elasticsearch_nodes_stats` | `metric?` | `GET {api_url}/_nodes/stats` |

- **只发可枚举的只读端点白名单**，`_bulk/_delete/_update/_reindex` 不可达。
- 认证：`api_key`（`Authorization: ApiKey`）/ `username`+`password`（basic）/ `client_cert`+`client_key`（mTLS，本期可选），经 `resolveEnvTemplate` 解析。

### 6.3 kubernetes/core（3 个工具，对齐 `kubernetes.yaml` 声明式 toolset）

| 工具名 | 入参 | 实现 |
| --- | --- | --- |
| `kubernetes_jq_query` | `kind`(复数), `jq_expr`, `namespace?` | `kubectl get --raw <api_path>?limit=500&continue=...` + jq 过滤，分页聚合，返回 `{total_items_processed, matches_found, results, stderr}` |
| `kubernetes_tabular_query` | `kind`, `fields`, `filter?`, `namespace?`, `label_selector?` | 仅取所需字段，内存高效大集群查询 |
| `kubernetes_count` | `kind`, `filter?`, `namespace?` | 返回匹配 `{count}` |

- 对齐 HolmesGPT 关键点：**用 `kubernetes_jq_query`（kubectl --raw + jq 分页）替代 v1 的 `kubectl_query` 白名单子命令**——它天然可测（复用 tail-logs 的 `__hooks.kubectlExec`）、无命令拼接注入面。只读，无 `follow`、无写子命令。
- 实现不依赖外部 `jq` 二进制，用 Node `JSON` 解析 + 轻量过滤，避免新增系统依赖。

### 6.4 database（SQL，3 个工具，对齐 `database.py`，`read_only` 默认 true）

| 工具 | 入参 | 实现 |
| --- | --- | --- |
| `{name}_query` | `sql` | 执行只读 SQL；结果 `{columns, rows, row_count, truncated}`（对齐 HolmesGPT 返回结构）|
| `{name}_list_tables` | `schema?` | `SELECT` information_schema 列表 |
| `{name}_describe_table` | `table_name`, `schema?` | 返回列/PK/FK/索引结构 |

- **只读白名单（对齐 `_READONLY_PATTERN`）**：仅允许 `SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH` 开头；`_WRITE_PATTERN` 前缀与 `_WRITE_ANYWHERE_PATTERN` 任意位置写关键词（INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/REPLACE/MERGE/GRANT/REVOKE/VACUUM）一律拒绝。
- `max_rows` 夹逼（默认 200，`<=10000`），超限 `truncated: true`。`timeout_seconds` 默认 60。
- **无 SQLAlchemy 的落地差异**：LiteAI 是 TypeScript，不引入 Python/SQLAlchemy。用 Node 驱动按 `connection_url` scheme 分流——`mysql/`（`mysql2`）、`postgresql/`（`pg`）、`sqlite:`（`node:sqlite`，内置零依赖）为首期三类；`mssql`/`clickhouse` 列为后续。`connection_url` 直接复用 HolmesGPT 格式（含 `sqlite+pysqlite://` 之类仅首段 scheme 判定）。

## 7. 测试计划（test/data-source-tools.test.ts）

1. 四个 toolset 产出工具 `isReadOnly === true`、`isParallelSafe` true。
2. `enabledToolsetsFor`：无 config → 对应工具不暴露；config 完整 → 暴露；缺 `api_url` 的 elasticsearch / 缺 `connection_url` 的 database → 不暴露；自定义未识别 type 不报错。
3. 多实例：`orders-mysql` 与 `analytics-pg` 均暴露各自的 `{name}_query`，`toolsets` 定位正确。
4. 子 agent：`enabledToolsetsFor` 产物经 `subsetForSubAgent` 后仍可见。
5. `elasticsearch_search`：dsl 透传 `_search`；size 夹逼 100；auth 头随请求。
6. `execute_prometheus_instant_query` → `/api/v1/query`；`execute_prometheus_range_query` start/end → `query_range` 带 step；`max_points` 超限自动调大 step。
7. `kubernetes_jq_query`：`kind`+`jq_expr` 拼 `kubectl get --raw`，分页聚合返回四字段结构；`kubernetes_count` 计数。
8. database：只读 SQL（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）放行；写语句（INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/REPLACE/MERGE/GRANT/REVOKE/VACUUM，含 WITH ... DELETE 等任意位置）拒绝；`max_rows` 夹逼截断。
9. `clampToolOutput` 超 200_000 截断并 `[truncated: N chars]`。
10. `resolveEnvTemplate`：`{{ env.X }}` 解析、未命中保留原文。
11. 回归：`data-sources-prompt.test.ts`（更新）、`run-command-sre.test.ts`、`tool-parallel.test.ts`。

测试通过 `__hooks` mock fetch / kubectlExec / SQL driver，不依赖真实数据源与网络。

## 8. 扩展路径：新增数据源（预置优先，MCP 兜底）

- **预置 toolset（写一次代码，之后即装即用）**：常用源（grafana-loki、datadog、confluence、http 等）按 §5 注册表登记一个 toolset（`checkConfig` + `buildTools`），用户在 `toolsets` 里填配置即用——**复用 HolmesGPT 现成 toolset 集合按 LiteAI 语言逐个移植**。这是新增源的标准路径。
- **MCP（零代码，立即可用）**：任意有官方/社区 MCP server 的源，`mcp.json` 加 `mcpServers` 即暴露 `mcp__server__tool`（LiteAI 已支持，本期不改）。`elasticsearch_search` 优于 ES MCP 的核心理由仍是：MCP 的 `from/size` 分页受 `index.max_result_window`（默认 10000）限制且部分社区版无 `from`；原生 `elasticsearch_search` 把 `from/size` 当一等参数并夹逼。
- **声明式 HTTP（后续批次）**：简单 REST 源用通用 `http` toolset（method/path/参数白名单），对齐 HolmesGPT `HttpToolset`，本期不做。

## 9. 验证步骤

1. `npm run check`（tsc --noEmit）通过。
2. `node --test test/data-source-tools.test.ts` 通过。
3. `node --test test/data-sources-prompt.test.ts test/run-command-sre.test.ts test/tool-parallel.test.ts` 回归通过。
4. `npm test` 全量通过。

## 10. 本期不做

- ES `scroll`/`search_after` 深分页（有状态游标，超出需求）；mTLS `client_cert`/`client_key`（OpenShift 专属，列为可选）。
- token 计数 → 摘要降级（HolmesGPT `data_summary` 模式）与 `JsonFilterMixin`：`clampToolOutput` 截断兜底够用，列为后续。
- 声明式 HTTP toolset（第 2 层）；grafana-loki、datadog、confluence 等更多内置 toolset：按 §8 预置模式后续移植。
- database 的 `mssql`/`clickhouse` 驱动与 `read_only: false` 写模式：只读 SQL 为首期，写操作不开放。
- `kubernetes/logs`、`kubernetes/live-metrics`、`kube-prometheus-stack` 等子 toolset；kubectl `follow` 与写子命令。
- 远程跨集群 toolcall / `expose_remotely`：集成到本地 CLI，暂不作 cross-cluster 路由。