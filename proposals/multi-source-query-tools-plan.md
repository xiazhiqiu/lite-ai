# 多数据源只读查询工具 —— 实现计划（Plan）

> 状态：待批准实施
> 上游提案：[multi-source-query-tools.md](./multi-source-query-tools.md)
> 调研依据：HolmesGPT（CNCF SRE agent）源码、K8sGPT MCP、Keep（keephq/keep）Provider 模式

## 1. 目标

把"让模型拼 `run_command + curl` 查数据源"改为**按数据源类型提供结构化只读工具**，从根上消除 curl 审批弹窗、非交互取不到数、诊断无法收敛的问题。

数据源远不止 ES/Prometheus 两种：GitLab（CI/CD、仓库）、SkyWalking（APM、链路追踪）、Jaeger、Loki、Datadog、MySQL 等都是 SRE 常查的源。因此本计划按**数据源复杂度分三层接入，零代码优先**（详见 §4 顶层设计）：

- **第 1 层 · MCP（零代码，纯配置，推荐）**：任何暴露 MCP server 的数据源，在 settings/mcp.json 加一条 `mcpServers` 即可，工具自动出现（`mcp__server__tool`）。LiteAI 已支持该机制，**本期不改动**，作为"加数据源不改代码"的标准路径。
- **第 2 层 · 声明式 HTTP 只读工具（零代码，纯配置）**：简单 REST 源（如 GitLab API）在 settings 里声明 `method/path/参数白名单/分页/上限`，由内置通用执行器跑，类似 HolmesGPT YAML toolset / Keep provider `with:`。
- **第 3 层 · 原生适配器（写代码，按需）**：仅当查询语义复杂（ES DSL、PromQL step 计算）或需强结构约束时才写模块——HolmesGPT/Keep 也是这么做的，这一层任何项目都逃不掉。

- 首期交付：第 3 层的 `es_query` / `prom_query` / `kubectl_query` 三个工具集 + `DataSourceConfig` 扩展（`type`/`headers`）+ 适配器注册表骨架 + 提示词引导 + 测试。
- 扩展路径：第 1 层 MCP 立即可用（零代码）；第 2 层与 GitLab / SkyWalking 第 3 层按 §8 模式后续接入。

## 2. 调研结论 → 落地决策

| 开源做法 | 本项目决策 |
| --- | --- |
| HolmesGPT `Tool` 结构声明只读 → 免审批 | 三个工具 `isReadOnly: true` + `isParallelSafe: () => true`，**不进 `PermissionManager.ensureCommand`** |
| HolmesGPT / Keep 均直连数据源原生 REST API，不开 shell | ES/Prometheus 用 Node `fetch`；kubectl 用 `execFile('kubectl', argsArray)` 数组参数不开 shell |
| Keep `Provider` 配置模型（`type` + 认证字段，密钥引用式注入）| **`DataSourceConfig` 新增可选 `type` 与 `headers`**，`type` 优先精确定位，未配置时回退 name/hint 关键词匹配 |
| HolmesGPT `adjust_step_for_max_points`、Keep `max_data_points` | `prom_query` 采样点 `<= PROM_MAX_POINTS=5000`，超限自动调大 step |
| HolmesGPT token 计数 → 超限降级摘要 | 本期用 `clampToolOutput`（`MAX_TOOL_OUTPUT=200_000`）截断兜底，摘要降级列为后续项 |
| HolmesGPT `JsonFilterMixin` | 本期不做（见 §10） |

## 3. 变更清单

| # | 文件 | 内容 |
| --- | --- | --- |
| 1 | `src/config.ts` | `DataSourceConfig` 增加 `type?`、`headers?`；导出 `DataSourceType`、`resolveHeaderValue` |
| 2 | `src/tools/data-sources/types.ts`（新增） | `DataSourceToolset` 类型、`DATA_SOURCE_TOOLSETS` 注册表、`dataSourceToolsetsFor(sources)` 动态注册、`matchByDataSource`、`clampToolOutput`、`__hooks` 共享工具 |
| 3 | `src/tools/data-sources/elasticsearch.ts`（新增） | `elasticsearchToolset`：`es_query` |
| 4 | `src/tools/data-sources/prometheus.ts`（新增） | `prometheusToolset`：`prom_query` |
| 5 | `src/tools/data-sources/kubernetes.ts`（新增） | `kubernetesToolset`：`kubectl_query`（复用 tail-logs 的 `__hooks.kubectlExec` 模式） |
| 6 | `src/tools/index.ts` | `createDefaultToolRegistry` 接入 `dataSourceToolsetsFor(loadDataSources())`；三个工具 `isReadOnly: true`、`isParallelSafe: () => true`，**不进 `PermissionManager.ensureCommand`** |
| 7 | `src/prompt.ts` | 数据源段落改为引导优先使用 `es_query`/`prom_query`/`kubectl_query`；保留 run_command 兜底 |
| 8 | `test/data-source-tools.test.ts`（新增） | 覆盖：只读标记、注册表按 type 动态注册、type 路由/关键词回退、URL 构造、分页/截断、kubectl 白名单 |
| 9 | `test/data-sources-prompt.test.ts`（更新） | 断言提示词引导使用新工具 |

不删除 `run_command`、`sre-whitelist`、`authorizedUrlPrefixes`，作为通用 shell 兜底保留。

## 4. 顶层设计：三层接入 + `DataSourceConfig` 扩展 + 适配器注册表

### 顶层设计：三层接入（零代码优先）

| 层 | 方式 | 是否改代码 | 适用场景 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | **MCP 接入**：settings/mcp.json 加 `mcpServers`，工具自动暴露 `mcp__server__tool` | 否 | 任何有官方/社区 MCP server 的源（ES、GitLab、SkyWalking 等均有） | ✅ 已支持，本期不改 |
| 2 | **声明式 HTTP 只读工具**：settings 里声明 `method/path/参数白名单/分页/上限`，内置通用执行器跑 | 否 | 简单 REST 源（GitLab API、普通 HTTP 端点） | ⚠️ 待做（§8 后续批次） |
| 3 | **原生适配器**：按 §4.3 注册表写模块 | 是 | 复杂查询语义（ES DSL、PromQL step）+ 强安全约束 | 本期实现 3 个内置源 |

**原则**：优先第 1/2 层零代码接入；只有语义复杂才走第 3 层写代码。第 3 层并非"加数据源"的唯一入口，只是内置一等公民数据源的实现方式。

### `DataSourceConfig` 扩展（src/config.ts）

```ts
/**
 * 数据源类型：内置值 + 开放扩展。
 * 内置类型命中注册表路由；未注册/自定义类型不报错，仅无法用结构化工具（可 hint 提示）。
 * 设计对齐 Keep `Provider` 模型：一个类型 = 一类工具集，type 是路由键。
 */
export type DataSourceType =
  | 'elasticsearch'
  | 'prometheus'
  | 'kubernetes'
  | 'gitlab'          // 后续批次（§8）
  | 'skywalking'      // 后续批次（§8）
  | (string & {})     // 开放扩展：自定义类型无需改本文件

export type DataSourceConfig = {
  name: string
  baseUrl: string
  hint?: string
  /** 数据源类型：优先精确路由到对应工具集；缺省时按 name/hint 关键词回退匹配 */
  type?: DataSourceType
  /** 请求头（认证/自定义），值支持 {{ env.NAME }} 引用环境变量，密钥不落盘 */
  headers?: Record<string, string>
}
```

- `loadDataSources()` 的过滤保持向后兼容（type/headers 均为可选），老 settings.json 不受影响。
- 新增 `resolveHeaderValue(value: string): string`：替换 `{{ env.NAME }}` 为 `process.env[NAME]`，未命中保留原文。

### 适配器注册表（第 3 层 · 原生适配器的基础设施）

```ts
// src/tools/data-sources/types.ts —— 注册表入口
export type DataSourceToolset = {
  type: DataSourceType
  /** 定位该类型数据源实例（type 精确优先，name/hint 关键词回退） */
  match: (sources: DataSourceConfig[]) => DataSourceConfig[]
  tools: ToolDefinition<unknown>[]
}

// 按 type 聚合各模块，新增源 = 新增模块 + 在此登记一行
export const DATA_SOURCE_TOOLSETS: DataSourceToolset[] = [
  elasticsearchToolset,   // src/tools/data-sources/elasticsearch.ts
  prometheusToolset,      // src/tools/data-sources/prometheus.ts
  kubernetesToolset,      // src/tools/data-sources/kubernetes.ts
  // gitlabToolset, skywalkingToolset, ... 后续接入
]

export function dataSourceToolsetsFor(sources: DataSourceConfig[]): ToolDefinition<unknown>[] {
  // 按已配置数据源的 type（或关键词回退命中）只注册对应工具集；
  // 无对应数据源时不注册，避免空转工具暴露给模型
}
```

关键点：

1. **新增源不改主干**：新类型（如 gitlab）只需写一个模块（`match` + 若干只读工具），在注册表登记一行，`createDefaultToolRegistry` 自动按已配置的 `type` 注册。
2. **按配置动态注册**：`dataSourceToolsetsFor(sources)` 只把"当前 settings 里配了该类型"的工具集挂到注册表 → 模型只会看到可用的工具，工具 `run` 内再按 `type` 定位实例。
3. **多实例消歧**：每个工具增加可选 `source?: string` 参数（数据源 `name`，缺省取第一个命中），对齐 Keep `{{ provider.xxx }}` 引用语义。

## 5. 工具接口（src/tools/data-sources/*.ts）

统一 `isReadOnly: true`、`isParallelSafe: () => true`；运行期 `loadDataSources()` 按 `type` 定位数据源实例（与 run_command 取 `authorizedUrlPrefixes` 同款模式，注册期无状态）。

**公共参数**：每个工具均带可选 `source?: string`（数据源 `name`，缺省取该类型第一个命中实例）用于多实例消歧。

### `es_query`

```ts
{
  index?: string,   // 缺省取 hint 中索引名或 "sock-shop-logs"
  q?: string,       // LiteQueryString → body.query.query_string
  dsl?: object,     // 提供则原样 POST /{index}/_search
  from?: number, size?: number, sort?: string,
}
```

- 路由：`matchByDataSource(source, 'elasticsearch')`，未命中返回 `ok:false` 并提示在 `hint`/`type` 补标识。
- 请求：`POST {baseUrl}/{index}/_search`，`size` 夹逼 `<= ES_MAX_SIZE=100`，超限取 100 并在输出标注。
- 结构上只发 `_search` 端点，无任何写端点（`_bulk/_delete/_update` 不可达）。
- 认证：`headers` 解析后随请求发送。

### `prom_query`

```ts
{
  query: string,            // PromQL
  instant?: boolean,        // true 或无 start/end → GET /api/v1/query
  start?: number, end?: number, step?: number|string,  // 否则 GET /api/v1/query_range
}
```

- `(end-start)/step <= PROM_MAX_POINTS=5000`，超限自动调大 step（`step = ceil(range/5000)`）并标注。
- 响应统一 `clampToolOutput` 截断。

### `kubectl_query`

```ts
{
  subcommand: 'get'|'describe'|'logs'|'top'|'version'|'explain',
  resource?, name?, namespace?,  // namespace 缺省 "sock-shop"（演示默认，可覆盖）
  output?, tail?,                // logs 默认 --tail=50，夹逼 <= KUBECTL_MAX_TAIL=500
}
```

- 仅白名单子命令，其余返回 `ok:false`；参数数组构造，不开 shell、无注入面。
- 复用 `__hooks.kubectlExec`（与 tail-logs 同款可测性钩子）。

## 6. 提示词更新（src/prompt.ts）

数据源段落改为：

```
## 实时数据源（只读查询，均免审批）
优先使用结构化工具查下列数据源取证（结构上只读，不触发审批）：
- es_query / prom_query / kubectl_query：按数据源名/类型自动定位
- 例外/复杂场景才用 run_command + curl（仅 GET / 检索型 POST）
```

仍保留"不要 Read 数据集原始 CSV""复杂 shell 会被审批"等约束说明。

## 7. 测试计划（test/data-source-tools.test.ts）

1. 三个工具 `isReadOnly === true`、`isParallelSafe` 返回 true。
2. 注册表：`dataSourceToolsetsFor` 只注册已配置 type 的工具集；未配置 ES 时不暴露 `es_query`；含 gitlab 类型时仍不报错（预留）。
3. `es_query`：q 构造 body 命中 `_search`；dsl 原样透传；size 夹逼 100；无 type 时 name 含 "elastic" 可定位；`source` 参数选实例。
4. `prom_query`：instant → `/api/v1/query`；有 start/end → `/api/v1/query_range` 且带 step；采样点超 5000 自动调大 step。
5. `kubectl_query`：白名单子命令通过、非白名单拒绝；logs 默认 tail=50、超 500 夹逼；namespace 缺省 sock-shop。
6. `clampToolOutput` 超 200_000 截断并追加 `[truncated: N chars]`。
7. `resolveHeaderValue`：`{{ env.X }}` 解析、未命中保留原文。
8. 回归：`data-sources-prompt.test.ts`（更新）、`run-command-sre.test.ts`、`tool-parallel.test.ts`。

测试通过 `__hooks` mock fetch / kubectlExec，不依赖真实数据源与网络。

## 8. 扩展路径：新增数据源（零代码优先）

### 第 1 层 · MCP（零代码，立即可用）

任何数据源有 MCP server 时，**直接加配置即可，完全不用改代码**（settings.json / `mcp.json` / 项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "gitlab": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gitlab"], "env": { "GITLAB_PERSONAL_ACCESS_TOKEN": "{{ env.GITLAB_TOKEN }}" } },
    "elasticsearch": { "command": "docker", "args": ["run", "--rm", "-i", "-e", "ES_URL", "-e", "ES_API_KEY", "docker.elastic.co/mcp/elasticsearch", "stdio"], "env": { "ES_URL": "...", "ES_API_KEY": "..." } }
  }
}
```

> 注：Elastic 官方 MCP server 为 `@elastic/mcp-server-elasticsearch`（npm 包已废弃，现行用 Docker 镜像 `docker.elastic.co/mcp/elasticsearch` 或 Elastic Agent Builder，见 [Elastic 官方仓库](https://github.com/elastic/mcp-server-elasticsearch)）。其 `search` 工具的 `queryBody` 接受完整 ES DSL，**可在 DSL 里写 `from`/`size` 做分页**，但受 `index.max_result_window`（默认 10000）限制；另有一个 Go 版社区 server（sonirico/mcp-elasticsearch）`search` 只暴露 `query/size/sort/aggs`，**没有 `from`，不支持分页**。选型时需甄别。

工具自动以 `mcp__gitlab__xxx` 形式出现在工具列表（见 prompt.ts 的 MCP 段落）。这是"加数据源不改代码"的标准路径。

### 第 2 层 · 声明式 HTTP 只读工具（零代码，待做）

settings 里声明只读 HTTP 查询（内置通用执行器，类似 HolmesGPT YAML toolset / Keep `with:`）：

```json
{
  "dataSources": [
    {
      "name": "gitlab",
      "type": "gitlab",
      "baseUrl": "https://gitlab.example.com",
      "headers": { "PRIVATE-TOKEN": "{{ env.GITLAB_TOKEN }}" },
      "hint": "GitLab API，可用于查项目/流水线/Job 日志",
      "tools": [
        { "name": "gitlab_list_pipelines", "method": "GET", "path": "/api/v4/projects/{project_id}/pipelines", "params": ["status", "per_page"] },
        { "name": "gitlab_get_job_logs", "method": "GET", "path": "/api/v4/projects/{project_id}/jobs/{job_id}/trace" }
      ]
    }
  ]
}
```

安全约束：仅 `GET`/检索型 `POST`、`path` 只支持预置变量占位、参数白名单、`per_page` 等数量参数夹逼、结果 `clampToolOutput`。本期不做，列为后续批次。

### 第 3 层 · 原生适配器（写代码，仅复杂语义）

仅当查询语义复杂（ES DSL、PromQL step 计算）或需强结构约束时新建模块 + 注册表登记一行，主干零改动。GitLab / SkyWalking 的两个计划接入原生适配器及其只读 API 锚点（实施时再核对具体版本）：

**`gitlab`（CI/CD / 仓库）** — `src/tools/data-sources/gitlab.ts`
- 认证：`headers: { 'PRIVATE-TOKEN': '{{ env.GITLAB_TOKEN }}' }` 或 `Authorization: Bearer`。
- 工具草案：`gitlab_list_projects`（`GET /api/v4/projects?membership=true&simple=true`）、`gitlab_list_pipelines`（`GET .../pipelines?status=&per_page=`）、`gitlab_get_pipeline` / `gitlab_get_job_logs`（trace 只返回最新一屏）。
- 只读面：仅 `GET`；`per_page` 夹逼 `<= 100`；结果 `clampToolOutput`。

**`skywalking`（APM / 链路追踪）** — `src/tools/data-sources/skywalking.ts`
- SkyWalking 查询走只读 GraphQL/REST 接口（v9 起 REST 风格，v8 为 `/graphql`）。
- 工具草案：`skywalking_search_traces`（按 service / 时间段 / 错误状态搜 trace）、`skywalking_get_trace`（按 traceId 拉单条链路 segment 明细）。
- 只读面：仅查询端点；时间范围参数校验防超长拉取；结果 `clampToolOutput`。

**接入决策顺序**：先看有没有 MCP server（第 1 层，零代码）→ 简单 REST 用声明式 HTTP（第 2 层，零代码）→ 语义复杂才写原生适配器（第 3 层，写代码）。

## 9. 验证步骤

1. `npm run check`（tsc --noEmit）通过。
2. `node --test test/data-source-tools.test.ts` 通过。
3. `node --test test/data-sources-prompt.test.ts test/run-command-sre.test.ts test/tool-parallel.test.ts` 回归通过。
4. `npm test` 全量通过。

## 10. 本期不做

- 第 2 层 · 声明式 HTTP 只读工具（settings 声明 method/path/参数白名单）：本期只落地第 3 层 3 个内置源与第 1 层 MCP 说明，第 2 层列为后续批次。
- ES `scroll`/`search_after` 深分页（有状态游标，超出当前需求）。
- token 计数 → 摘要降级（HolmesGPT `data_summary` 模式）与 `JsonFilterMixin`：截断兜底已够本期用，列为后续。
- GitLab / SkyWalking 本期仅完成注册表预留与类型定义（`gitlab`/`skywalking` 已在 `DataSourceType` 声明），工具实现按 §8 后续批次接入。
- PostgreSQL、Datadog、Grafana、Jaeger、Loki 等其他源：优先走第 1/2 层零代码接入，需要时再写第 3 层适配器。
- kubectl `follow`（长驻进程）与写子命令。
