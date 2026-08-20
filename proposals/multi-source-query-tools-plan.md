# 多数据源只读查询工具 —— 实现计划（Plan）

> 状态：待批准实施
> 上游提案：[multi-source-query-tools.md](./multi-source-query-tools.md)
> 调研依据：HolmesGPT（CNCF SRE agent）源码、K8sGPT MCP、Keep（keephq/keep）Provider 模式

## 1. 目标

把"让模型拼 `run_command + curl` 查数据源"改为**一数据源一个结构化只读工具**，从根上消除 curl 审批弹窗、非交互取不到数、诊断无法收敛的问题。

交付：`es_query`、`prom_query`、`kubectl_query` 三个工具 + `DataSourceConfig` 扩展 + 提示词引导 + 测试。

## 2. 调研结论 → 落地决策

| 开源做法 | 本项目决策 |
| --- | --- |
| HolmesGPT `Tool` 结构声明只读 → 免审批 | 三个工具 `isReadOnly: true` + `isParallelSafe: () => true`，**不进 `PermissionManager.ensureCommand`** |
| HolmesGPT / Keep 均直连数据源原生 REST API，不开 shell | ES/Prometheus 用 Node `fetch`；kubectl 用 `execFile('kubectl', argsArray)` 数组参数不开 shell |
| Keep `Provider` 配置模型（`type` + 认证字段，密钥引用式注入）| **`DataSourceConfig` 新增可选 `type` 与 `headers`**，`type` 优先精确定位，未配置时回退 name/hint 关键词匹配 |
| HolmesGPT `adjust_step_for_max_points`、Keep `max_data_points` | `prom_query` 采样点 `<= PROM_MAX_POINTS=5000`，超限自动调大 step |
| HolmesGPT token 计数 → 超限降级摘要 | 本期用 `clampToolOutput`（`MAX_TOOL_OUTPUT=200_000`）截断兜底，摘要降级列为后续项 |
| HolmesGPT `JsonFilterMixin` | 本期不做（见 §8） |

## 3. 变更清单

| # | 文件 | 内容 |
| --- | --- | --- |
| 1 | `src/config.ts` | `DataSourceConfig` 增加 `type?`、`headers?`；导出 `DataSourceType` 与密钥解析辅助 |
| 2 | `src/tools/data-source-query.ts`（新增） | `esQueryTool` / `promQueryTool` / `kubectlQueryTool` + `matchByDataSource` + `clampToolOutput` + 常量 + `__hooks`（fetch/kubectlExec，便于测试） |
| 3 | `src/tools/index.ts` | 注册三个工具（`isReadOnly: true`、`isParallelSafe: () => true`） |
| 4 | `src/prompt.ts` | 数据源段落改为引导优先使用 `es_query`/`prom_query`/`kubectl_query`；保留 run_command 兜底 |
| 5 | `test/data-source-tools.test.ts`（新增） | 覆盖：只读标记、type 路由/关键词回退、URL 构造、分页/截断、kubectl 白名单 |
| 6 | `test/data-sources-prompt.test.ts`（更新） | 断言提示词引导使用新工具 |

不删除 `run_command`、`sre-whitelist`、`authorizedUrlPrefixes`，作为通用 shell 兜底保留。

## 4. `DataSourceConfig` 扩展（src/config.ts）

```ts
export type DataSourceType = 'elasticsearch' | 'prometheus'

export type DataSourceConfig = {
  name: string
  baseUrl: string
  hint?: string
  /** 数据源类型：优先精确路由到 es_query / prom_query；缺省时按 name/hint 关键词回退 */
  type?: DataSourceType
  /** 请求头（认证/自定义），值支持 {{ env.NAME }} 引用环境变量，密钥不落盘 */
  headers?: Record<string, string>
}
```

- `loadDataSources()` 的过滤保持向后兼容（type/headers 均为可选）。
- 新增 `resolveHeaderValue(value: string): string`：替换 `{{ env.NAME }}` 为 `process.env[NAME]`，未命中保留原文。置于 config.ts 供工具使用。
- `type` 为可选：已配置的老 settings.json 不受影响（回退关键词匹配）。

## 5. 工具接口（src/tools/data-source-query.ts）

统一 `isReadOnly: true`、`isParallelSafe: () => true`；运行期 `loadDataSources()` 定位数据源（与 run_command 取 `authorizedUrlPrefixes` 同款模式，注册期无状态）。

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
2. `es_query`：q 构造 body 命中 `_search`；dsl 原样透传；size 夹逼 100；无 type 时 name 含 "elastic" 可定位。
3. `prom_query`：instant → `/api/v1/query`；有 start/end → `/api/v1/query_range` 且带 step；采样点超 5000 自动调大 step。
4. `kubectl_query`：白名单子命令通过、非白名单拒绝；logs 默认 tail=50、超 500 夹逼；namespace 缺省 sock-shop。
5. `clampToolOutput` 超 200_000 截断并追加 `[truncated: N chars]`。
6. `matchByDataSource`：type 优先、关键词回退、不命中返回提示。
7. 回归：`data-sources-prompt.test.ts`（更新）、`run-command-sre.test.ts`、`tool-parallel.test.ts`。

测试通过 `__hooks` mock fetch / kubectlExec，不依赖真实数据源与网络。

## 8. 验证步骤

1. `npm run check`（tsc --noEmit）通过。
2. `node --test test/data-source-tools.test.ts` 通过。
3. `node --test test/data-sources-prompt.test.ts test/run-command-sre.test.ts test/tool-parallel.test.ts` 回归通过。
4. `npm test` 全量通过。

## 9. 本期不做

- ES `scroll`/`search_after` 深分页（有状态游标，超出当前需求）。
- token 计数 → 摘要降级（HolmesGPT `data_summary` 模式）与 `JsonFilterMixin`：截断兜底已够本期用，列为后续。
- 其他数据源（PostgreSQL、Datadog、Grafana 等）：沿用"一源一只读工具 + type 路由"模式扩展。
- kubectl `follow`（长驻进程）与写子命令。
