# 多数据源只读查询工具 —— 实现计划（Plan）

> 状态：待批准实施
> 上游提案：[multi-source-query-tools.md](./multi-source-query-tools.md)
> 调研依据：HolmesGPT（CNCF SRE agent）源码、K8sGPT MCP、Keep（keephq/keep）Provider 模式

## 1. 目标

把"让模型拼 `run_command + curl` 查数据源"改为**按数据源类型提供结构化只读工具集**，从根上消除 curl 审批弹窗、非交互取不到数、诊断无法收敛的问题。

数据源远不止 ES/Prometheus 两种：GitLab（CI/CD、仓库）、SkyWalking（APM、链路追踪）、Jaeger、Loki、Datadog、MySQL 等都是 SRE 常查的源。因此本计划的核心是**一套可扩展的"数据源适配器注册表"**：每种数据源类型 = 一个独立模块（一类型一工具集），按 `type` 注册路由，新增源只加模块、不改主干。

- 首期交付：`es_query` / `prom_query` / `kubectl_query` 三个工具集 + `DataSourceConfig` 扩展（`type`/`headers`）+ 适配器注册表骨架 + 提示词引导 + 测试。
- 扩展路径：GitLab / SkyWalking 等按 §8 的模式逐个接入。

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

## 4. `DataSourceConfig` 扩展与类型注册表（src/config.ts）

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

### 适配器注册表（核心扩展机制）

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

## 8. 扩展路径：GitLab / SkyWalking（后续批次）

新增数据源类型 = 新建一个模块 + 注册表登记一行，主干零改动。下面是两个计划接入的源及其只读 API 锚点（实施时再核对具体版本）：

**`gitlab`（CI/CD / 仓库）** — `src/tools/data-sources/gitlab.ts`
- 认证：`headers: { 'PRIVATE-TOKEN': '{{ env.GITLAB_TOKEN }}' }` 或 `Authorization: Bearer`。
- 工具草案：
  - `gitlab_list_projects`：`GET {baseUrl}/api/v4/projects?membership=true&simple=true`（简单列表，不含仓库详情）
  - `gitlab_list_pipelines`：`GET /api/v4/projects/{project_id}/pipelines?status=&per_page=`（只读）
  - `gitlab_get_pipeline` / `gitlab_get_job_logs`：`GET .../pipelines/{id}`、`GET .../jobs/{id}/trace`（trace 只返回最新一屏，避免超大输出）
- 只读面：仅 `GET`；`per_page` 夹逼 `<= 100`；结果 `clampToolOutput`。

**`skywalking`（APM / 链路追踪）** — `src/tools/data-sources/skywalking.ts`
- SkyWalking 查询走只读 GraphQL/REST 接口（v9 起 REST 风格，v8 为 `/graphql`）。
- 工具草案：
  - `skywalking_search_traces`：按 service / 时间段 / 错误状态搜 trace（只读查询，无写入）
  - `skywalking_get_trace`：按 traceId 拉单条链路 segment 明细
- 只读面：仅查询端点；时间范围参数校验防超长拉取；结果 `clampToolOutput`。

接入流程（供后续批次复用）：写 `match`（type 精确 + 关键词回退）→ 实现只读工具（直连 REST、GET/查询端点、数量与大小上限）→ 注册表登记 → 补测试 → 更新提示词清单。

## 9. 验证步骤

1. `npm run check`（tsc --noEmit）通过。
2. `node --test test/data-source-tools.test.ts` 通过。
3. `node --test test/data-sources-prompt.test.ts test/run-command-sre.test.ts test/tool-parallel.test.ts` 回归通过。
4. `npm test` 全量通过。

## 10. 本期不做

- ES `scroll`/`search_after` 深分页（有状态游标，超出当前需求）。
- token 计数 → 摘要降级（HolmesGPT `data_summary` 模式）与 `JsonFilterMixin`：截断兜底已够本期用，列为后续。
- GitLab / SkyWalking 本期仅完成注册表预留与类型定义（`gitlab`/`skywalking` 已在 `DataSourceType` 声明），工具实现按 §8 后续批次接入。
- PostgreSQL、Datadog、Grafana、Jaeger、Loki 等其他源：沿用"一类型一工具集 + type 路由"模式扩展。
- kubectl `follow`（长驻进程）与写子命令。
