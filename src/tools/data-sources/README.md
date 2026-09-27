# data-sources 工具集（只读数据源 toolset）

本目录提供一组**配置驱动、默认只读、fail-closed** 的结构化数据源工具，从 `main` 分支原样移植
（`base.ts` / `registry.ts` / `prometheus.ts` / `loki.ts` / `elasticsearch.ts` / `kubernetes.ts` /
`database.ts` / `tempo.ts`），并新增 `gitlab.ts`（参考 HolmesGPT 的 git 类工具范式补上的只读 GitLab 工具）。

所有工具均为只读 `GET`/查询，密钥不落盘（通过 `{{ env.NAME }}` 占位在运行时注入），缺配置则**完全不产生工具**。

## 启用机制（配置驱动 + fail-closed）

工具集通过 `settings.json` 的 `toolsets` 字段启用，核心逻辑在 `src/config.ts`：

- `LiteAISettings.toolsets?: Record<string, LLMToolSetConfig>`（`src/config.ts:35`）。
- `loadResolvedToolsets()`（`src/config.ts:256`）：读取已生效设置 → 遍历 `toolsets`
  → 用 `resolveEnvTemplate` 把 `{{ env.NAME }}` 替换为环境变量（密钥不落盘）→ 剔除 `enabled:false`。
- `registry.ts` 的 `buildEnabledTools()`（`src/tools/data-sources/registry.ts:76`）：按 `type`
  匹配 `BUILTIN_TOOLSETS`，先 `check*` 判 prerequisite（config 不完整则 `enabled:false`），
  再 `build*` 生成工具，注入主工具注册表（`src/tools/index.ts`）。

设置文件位置：`$LITE_AI_HOME/settings.json`（默认 `.lite-ai/settings.json`），可用 `LITE_AI_HOME`
环境变量覆盖；与 `CLAUDE_SETTINGS_PATH` 合并，生效优先级 `LITE_AI > CLAUDE > process.env`。

> fail-closed 语义：未配置、或 config 必填项缺失的 toolset，**不产生任何工具**，绝不会带着空连接去执行。

## settings.json 配置示例

```json
{
  "toolsets": {
    "prometheus": {
      "type": "prometheus",
      "config": { "prometheus_url": "{{ env.PROMETHEUS_URL }}" }
    },
    "elasticsearch": {
      "type": "elasticsearch",
      "config": { "es_url": "{{ env.ES_URL }}" }
    },
    "kubernetes": {
      "type": "kubernetes"
    },
    "database": {
      "type": "database",
      "config": { "connection_url": "{{ env.DB_CONNECTION_URL }}" }
    },
    "tempo": {
      "type": "tempo",
      "config": {
        "api_url": "{{ env.TEMPO_URL }}",
        "api_key": "{{ env.TEMPO_API_KEY }}"
      }
    },
    "loki": {
      "type": "loki",
      "config": {
        "api_url": "{{ env.LOKI_URL }}",
        "api_key": "{{ env.LOKI_API_KEY }}"
      }
    },
    "gitlab": {
      "type": "gitlab",
      "config": {
        "gitlab_url": "{{ env.GITLAB_URL }}",
        "gitlab_token": "{{ env.GITLAB_TOKEN }}"
      }
    }
  }
}
```

只列用到的 toolset 即可；未列出的不加载，缺必填项的自动跳过（不会报错）。

## 内置 toolset 清单

| type（=配置 key） | 必填 config | 可选 config | 说明 |
|---|---|---|---|
| `prometheus` | `prometheus_url` | — | Prometheus 指标查询 |
| `elasticsearch` | `es_url` | — | ES 索引/文档查询 |
| `kubernetes` | —（继承当前 kubeconfig） | — | `kubectl get` 只读资源查询 |
| `database` | `connection_url` | — | 只读 SQL 查询 |
| `tempo` | `api_url` | `api_key` / `grafana_datasource_uid` / `username` / `password` / `additional_headers` / `timeout_seconds` / `labels` | 链路追踪查询 |
| `loki` | `api_url` | `api_key` / `grafana_datasource_uid` / `username` / `password` / `additional_headers` / `timeout_seconds` | 日志查询 |
| `gitlab` | `gitlab_url` | `gitlab_token` | GitLab REST v4 只读工具（见下） |

`check*` 判据（源码）：`prometheus.ts:20`、`elasticsearch.ts:14`、`database.ts:48`、
`tempo.ts:30`、`loki.ts:30`、`gitlab.ts:33` 均对必填 URL 做 `typeof === 'string' && length>0` 校验，
不通过则 `enabled:false`；`kubernetes.ts:17` 无必填项，恒 `enabled:true`。

## GitLab toolset（新增，参考 HolmesGPT 范式）

文件：`src/tools/data-sources/gitlab.ts`。路由对齐 HolmesGPT 的 git 类工具：
`gitlab_url` + `gitlab_token`（以 `PRIVATE-TOKEN` 头发送）。全部为只读 `GET`，`isReadOnly: true`。

`baseUrl` 由 `gitlab_url` 追加 `/api/v4` 得到（`gitlab.ts:118`）。`project_id` 支持数字 ID 或
`group/project` 形式（`gitlab.ts:45` 正则校验）。

| 工具名 | 端点 | 说明 |
|---|---|---|
| `gitlab_list_merge_requests` | `GET /projects/:id/merge_requests` | 列出 MR，可按 `state` / `target_branch` 过滤 |
| `gitlab_get_merge_request` | `GET /projects/:id/merge_requests/:iid` | 单个 MR 详情 |
| `gitlab_list_pipelines` | `GET /projects/:id/pipelines` | 列出 CI 流水线，可按 `ref` / `status` 过滤 |
| `gitlab_get_pipeline` | `GET /projects/:id/pipelines/:id` | 流水线详情 + 附带 jobs 列表 |
| `gitlab_get_commit` | `GET /projects/:id/repository/commits/:sha` | 单个 commit 详情（含 message 与 stats） |

> 注：HolmesGPT 本身**没有** gitlab toolset（仅有 github via MCP、argocd 等），这里"参考 holmesgpt"
> 指套用其「配置驱动 + 只读 GET + fail-closed」的范式，而非直接搬运文件。

## 设计约定

- 工具统一经 `base.ts` 的 `httpGet`（`isReadOnly` 封装、`clampToolOutput` 截断输出）。
- `inputSchema` 由 zod 4 的 `z.toJSONSchema(schema)` 生成（`gitlab.ts:105` 等）。
- 新增 toolset 三步：① 在 `base.ts` 之外的独立文件实现 `check*` + `build*`；
  ② 在 `registry.ts` 的 `BUILTIN_TOOLSETS` 注册（`registry.ts:34`）；
  ③ 在 `settings.json` 用 `type` 匹配启用。
