# 多数据源只读查询工具集设计

> 状态：待实现提案（Proposal）
> 关联问题：run_command + curl 查数据源触发守卫、需手工审批、非交互模式取不到数据、诊断无法收敛根因

## 1. 背景与问题

当前诊断数据源（Elasticsearch / Prometheus / Kubernetes）依赖 `run_command` 拼 `curl` 文本命令：

- 模型为查数据生成的命令常带 `bash -lc`、`$()`、`python3` 等形态，命中 `hasDangerousToken` → 进入 `PermissionManager.ensureCommand` → **非交互模式默认拒绝**，工具拿不到数据，诊断只能原地规划、无法收敛根因。
- 每条查询都让模型现场拼 URL / 参数，既费令牌又易写错地址。
- "只读"是**事后解析 shell 文本**判定的，安全模型复杂且脆弱。

## 2. 目标

把"让模型拼 shell/curl"改为 **一数据源一个结构化只读工具**，工具结构上只读、天然免审批、不开 shell、不拼 curl：

- `es_query` -- Elasticsearch
- `prom_query` -- Prometheus
- `kubectl_query` -- Kubernetes 只读子命令

等价地复用各数据源各自的原生接口（REST API / CLI），不造查询引擎。

## 3. 设计原则

### 3.1 一源一工具，结构上只读
- 三个工具统一 `isReadOnly: true` + `isParallelSafe: () => true`。
- **只读来自工具结构本身，而非运行期文本判定** → 直接不进 `PermissionManager.ensureCommand`，天然免审批、免授权交互。
- `isReadOnly: true` 会被 `subsetForSubAgent` 自动纳入子 agent 白名单（见 `src/tool.ts`）。

### 3.2 薄封装各数据源原生接口，不用 curl
- Elasticsearch：官方 `mcp-server-elasticsearch`、各类 provider 均用 HTTP 客户端库直连其 REST API（`_search`）。我们用 Node 内置 `fetch`。
- Prometheus：同用 HTTP 客户端库请求 `/api/v1/query` 与 `/api/v1/query_range`。我们用 Node 内置 `fetch`。
- Kubernetes：业界两条路——官方客户端 SDK 或直接调 `kubectl` CLI（kubectl 本身就是 HTTP 客户端）。我们用 `execFile('kubectl', argsArray)`，**数组参数不开 shell、天然免注入**。

> 关键：不开 `curl` 进程、不经 shell，页面上那类 curl 审批弹窗**从根上消失**。

### 3.3 分页与溢出防护
每个工具暴露分页/数量上限参数（均为数据源原生能力透传），并统一对返回做大小截断：

| 工具 | 原生分页/上限参数 | 默认 | 上限 |
| --- | --- | --- | --- |
| `es_query` | `size` / `from` | size=10 | `ES_MAX_SIZE = 100`，超限夹逼；**不上 scroll/search_after**（深分页需游标会话，超出当前需求，保持无状态） |
| `prom_query` | `start` / `end` / `step` | step=30 | 采样点 `(end-start)/step <= PROM_MAX_POINTS = 5000`，超限自动调大 step 或提示拆时间窗 |
| `kubectl_query` | `--tail`（logs） | tail=50 | `KUBECTL_MAX_TAIL = 500`，超限夹逼 |

统一截断辅助 `clampToolOutput(text, MAX_TOOL_OUTPUT=200_000)`：超长截断并追加 `...\n[truncated: <len> chars]` 标记，保证 `ToolResult.output` 有界。

### 3.4 数据源定位：命名约定匹配，不改配置
不给 `DataSourceConfig` 加 `type` 字段、不改 `settings.json`。工具经 `loadDataSources()` 读配置，按数据源 `name`/`hint` 是否含关键词匹配对应数据源：

- `es_query` → 名称/提示词含 `elastic`
- `prom_query` → 名称/提示词含 `prometheus`

（新增私有辅助 `matchByDataSource(source, keywords)`，不命中则返回 `ok:false` 并提示，供用户在 `hint` 里补关键词。）

### 3.5 上下文保护：大数据先委派子 agent
偶尔单个工具截断是最后兜底；**大批量/多源取证第一优先委派 `spawn_agent` 只读子 agent**——子 agent 有自己的消息历史，把大量原始输出浓缩成摘要，主 agent 只经 `wait_agent` 拿回 result，避免撑爆主上下文。二者分级：

1. 子 agent 委派（第一优先，靠 prompt 引导，现状如此，仅强化）
2. `clampToolOutput` 截断（最后兜底）

## 4. 变更清单

| # | 文件 | 内容 |
| --- | --- | --- |
| 1 | `src/tools/data-source-query.ts`（新增） | 实现 `esQueryTool` / `promQueryTool` / `kubectlQueryTool`，含 `matchByDataSource`、`clampToolOutput`、各常量 |
| 2 | `src/tools/index.ts` | 注册三个工具到 `createDefaultToolRegistry` |
| 3 | `src/prompt.ts` | 数据源一节引导优先用 `es_query`/`prom_query`/`kubectl_query`；子 agent 协同一节强化"大数据取证先委派子 agent" |
| 4 | `test/data-source-tools.test.ts`（新增） | 覆盖：三个工具 `isReadOnly === true`；URL/参数构造（instant 与 query_range）；仅命中 `_search` 端点；kubectl 子命令白名单；分页/截断分支 |

不删除既有 `run_command` 与 `sre-whitelist`（`authorizedUrlPrefixes`）机制，作为通用 shell 兜底保留。

## 5. 各工具接口

### `es_query`
```ts
es_query: {
  index?: string,   // 缺省取 hint 中索引名或 "sock-shop-logs"
  q?: string,       // LiteQueryString
  dsl?: object,     // 提供则 POST /<index>/_search
  from?: number, size?: number, sort?: string,
}
```
不发任何写端点（`_bulk` / `_delete` / `_update` 一律封死）。

### `prom_query`
```ts
prom_query: {
  query: string,
  instant?: boolean,  // true 或无 start/end → /api/v1/query
  start?: number, end?: number, step?: number|string,  // 否则 /api/v1/query_range
}
```
超 `PROM_MAX_POINTS` 自动调大 step 或报错提示拆分。

### `kubectl_query`
```ts
kubectl_query: {
  subcommand: 'get'|'describe'|'logs'|'top'|'version'|'explain',
  resource?, name?, namespace?,   // namespace 缺省 "sock-shop"，可覆盖
  output?, tail?,                 // logs 默认 --tail=50
}
```
仅白名单子命令，不实现 `follow`（避免长驻）。

## 6. 验证

1. `npm run check`（tsc --noEmit）通过。
2. `node --test test/data-source-tools.test.ts` 通过（含分页/截断）。
3. 回归 `node --test test/tool-parallel.test.ts test/run-command-sre.test.ts` 通过。
4. `npm test` 全量通过。

## 7. 暂不做（本期范围外）

- Elasticsearch `scroll` / `search_after` 深分页（有状态，超出当前需求，后续有深分页需要再评估）。
- 数据源 `type` 字段：本期用命名约定匹配，不引入配置字段。
- 其他数据源（PostgreSQL、Datadog 等）：沿用本模式，一个源一个只读工具。