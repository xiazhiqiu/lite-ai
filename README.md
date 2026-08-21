<div align="center">
  <img src="./docs/logo.jpg" alt="LiteAI Logo" width="120" />
  <h1 align="center">LiteAI</h1>
  <p align="center">
    <strong>终端原生、轻量可 hack、面向 SRE 故障处置的事故诊断 Agent</strong><br/>
    <a href="#安装"><strong>安装</strong></a> |
    <a href="#快速开始"><strong>快速开始</strong></a> |
    <a href="#配置数据源工具集"><strong>数据源工具集</strong></a> |
    <a href="https://github.com/LiuMengxuan04/MiniCode"><strong>上游 MiniCode</strong></a>
  </p>
</div>

LiteAI 是一个开源的 AI agent，用于调查生产事故、定位根因并生成复盘。它在 `model → tool → model` 的 agent 内核之上，沉淀了面向故障定位的完整闭环：**告警响应 → 多源并行取证 → 假设-验证 → 检查点交接 → 复盘归档 → 事故知识库检索**。天然适配 SSH / jumpbox / 气隔 / 值班机等办公网络受限场景，运行状态全程可审计、可 `resume` / `fork`。

> 我们是一个轻量、terminal-first 的实现：核心围绕 `ModelAdapter.next()` 与 `ToolRegistry.execute()` 两个极小接口，易学、易改、易扩展。

## 特色

- **标准 ReAct 循环** — `model → tool → model` 单轮可多步调用工具；超大工具结果自动落盘并在上下文里替换为短预览与文件路径
- **多源事故默认并行子 agent** — 命中 ≥2 个独立数据源 / 服务（如 Prometheus + Elasticsearch + kubectl）时自动并发只读子 agent 各自归口取证，再汇总合并，避免串行拉低定位速度
- **只读数据源工具集（toolset）** — 预置 Prometheus / Elasticsearch / Kubernetes / Database(SQL) 四类只读查询工具，`settings.json` 填 `toolsets` 即启用，无需写胶水代码；更多数据源适配中（Grafana / Loki / Datadog 等）
- **上下文压缩** — 多级压缩（snip / microcompact / collapse / auto-compact）控制长会话体积；microcompact 自动折叠只读工具结果释放上下文
- **假设-验证链** — `hypothesis_tracker` 维护结构化根因假设（pending / investigating / confirmed / refuted / inconclusive），每条结论附带可追溯证据
- **检查点交接** — `incident_checkpoint` 支持创建 / 切换检查点，一键生成跨班交接简报（现象 / 时间线 / 已排除假设 / 待验证假设 / 关键命令）
- **复盘与知识库** — `generate_postmortem` 模板化生成复盘并归档入库；`search_incident_kb` 用 sqlite-vec 本地语义检索相似历史事故
- **流式日志** — `tail_logs` / `follow_logs` / `stop_follow` 按级别着色，支持超大文件与滚动读取
- **告警 webhook** — `lite-ai --webhook [port]` 独立监听进程，接收 Alertmanager 等事件源告警，自动去重、排队诊断并回推通知
- **MCP 与本地技能** — 支持 MCP 工具 / 资源 / prompt（stdio 或远程 HTTP），通过 `SKILL.md` 发现本地技能

## 工作原理

LiteAI 使用 **agentic loop** 实时查询多个数据源的观测数据并定位根因。多源任务优先走并行子 agent 归口，避免串行查询。

```
告警 / 值班触发
  └─ 描述现象（"payment 服务全部 500"）
       ├─ search_incident_kb   检索相似历史事故
       ├─ 多路并行取证（prometheus_* / elasticsearch_* / kubernetes_* / tail_logs）
       ├─ hypothesis_tracker   注册假设 → 附着证据 → 判定状态
       ├─ incident_checkpoint  关键阶段打点 / 生成交接简报
       ├─ 定位根因 → 给出处置建议（写操作需审批）
       └─ generate_postmortem  生成复盘报告并归档入库
```

### 数据源工具集

built-in 只读 toolset，在 `settings.json` 按名字启用与配置：

| toolset | 工具前缀 | 连接字段 | 说明 |
|---|---|---|---|
| `prometheus` | `prometheus_`（8） | `prometheus_url` | 规则 / 指标 / 标签 / 即时与区间查询 |
| `elasticsearch` | `elasticsearch_`（8） | `es_url` | 搜索 / 索引 / 集群健康 / 节点统计 |
| `kubernetes` | `kubernetes_`（3） | 无（继承 kubeconfig） | pods / nodes / jq 读取 |
| `database` | `{实例名}_`（每实例 3） | `connection_url` | 仅只读 SQL（SELECT/SHOW/DESCRIBE） |

多个 database 实例用不同名字即可（如 `orders_db_query`）。新增数据源遵循同一模式在 `src/tools/data-sources/registry.ts` 登记即可。

## 安装

```bash
cd lite-ai
npm install
npm run install-local
```

安装器会引导配置模型名、base URL 与认证 token，写入 `~/.lite-ai/settings.json`，并生成 `lite-ai` 启动器到 `~/.local/bin`（可用 `LITE_AI_BIN_DIR` 覆盖）。

其他配置位置：

- `~/.lite-ai/settings.json` — 主配置
- `~/.lite-ai/mcp.json` / 项目下 `.mcp.json` — MCP server 配置
- `~/.claude/settings.json` — Claude Code 兼容回退

可用 `LITE_AI_HOME` 覆盖整个配置 / 数据目录。

### 连接的 LLM Provider

- **OpenAI 兼容**：`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`（默认 provider）
- **Anthropic**：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`
- **离线演示**：`LITE_AI_MODEL_MODE=mock` 无需任何 API Key

## 快速开始

```bash
# 运行已安装的启动器
lite-ai

# 开发模式
npm run dev

# 离线演示模式（无需任何 API Key）
LITE_AI_MODEL_MODE=mock npm run dev

# 恢复 / 派生历史会话
lite-ai --resume [session-id]
lite-ai --fork <session-id>

# 启动告警 webhook 监听进程
lite-ai --webhook 8787
```

常用入口点：`/help` `/tools` `/status` `/model [name]` `/config-paths` `/skills` `/mcp` `/alerts`；
会话管理：`/resume` `/rename` `/fork` `/new`；上下文：`/compact` `/collapse` `/snip`；
项目管理：`/memory` `/init` `/permissions`；诊断：`/cmd <shell 命令>`（仅放行只读命令）。

## 配置数据源工具集

在 `settings.json` 顶层新增 `toolsets`：

```json
{
  "toolsets": {
    "prometheus": {
      "type": "prometheus",
      "config": { "prometheus_url": "http://localhost:19090" }
    },
    "elasticsearch": {
      "type": "elasticsearch",
      "config": { "es_url": "http://localhost:19200" }
    },
    "kubernetes": { "type": "kubernetes", "config": {} },
    "orders-db": {
      "type": "database",
      "config": { "connection_url": "mysql://user:pass@localhost:13306/orders" }
    }
  }
}
```

其他配置参数与环境变量（模型、输出 token、embedding 维度、各路径覆盖）见下表：

| 变量 | 说明 |
|---|---|
| `LITE_AI_PROVIDER` | `openai`（默认）/ `anthropic` |
| `LITE_AI_MODEL` | 当前模型名 |
| `LITE_AI_MAX_OUTPUT_TOKENS` | 最大输出 token 数 |
| `LITE_AI_EMBED_DIMENSION` | 知识库 embedding 维度（默认 384，改动需重建知识库） |
| `LITE_AI_HOME` | 覆盖配置 / 数据目录 |
| `LITE_AI_BIN_DIR` | 覆盖启动器安装目录 |

数据 / 产物落盘于 `LITE_AI_HOME`：会话（`projects/`）、权限（`permissions.json`）、webhook 记录（`webhook/alerts.jsonl`）、复盘报告（`postmortems/`）、事故知识库（`incident-kb/kb.db`）。

## 告警 webhook

通过 `settings.json` 的 `webhook` 字段配置，`lite-ai --webhook [port]` 启动：

```json
{
  "webhook": {
    "port": 8787,
    "host": "127.0.0.1",
    "secret": "可选校验 token",
    "autoDiagnose": true,
    "notifyUrl": "https://example.com/hook",
    "notifyHeaders": { "Authorization": "Bearer ..." }
  }
}
```

事件源支持按 payload 自动路由（告警去重 → 截断 → 串行队列自动诊断 → 存会话 → 通知），详见 `src/webhook/sources/`。

## 只读安全边界

LiteAI 默认**只读优先**，放心用于生产排查：

- 数据源工具统一 `isReadOnly: true`，自动进入子 agent 白名单与上下文压缩范围
- `run_command` 仅放行 SRE 只读诊断命令；kubectl / docker / curl 等按子命令级白名单拦截写操作（`kubectl delete`、`curl -X POST` 等一律拒绝）
- 通用文件工具默认不暴露给 agent，避免越权读取敏感数据

## 评测

```bash
# 全量 RE2-SS 评测
npm run eval:re2ss

# 仅指定故障类型
npm run eval:re2ss -- --filter=payment_loss
```

## 开发

```bash
npm run check   # tsc 类型检查
npm run lint    # eslint
npm test        # 测试（node test/run-tests.mjs）
npm run dev     # 开发模式
```

架构分层清晰、接口极小（核心围绕 `ModelAdapter.next()` 与 `ToolRegistry.execute()`），事故诊断领域能力集中在 `src/webhook/`、`src/tools/`（SRE 工具与数据源 toolset）与知识库工具链中。

## 致谢 / 上游

LiteAI 基于 [MiniCode](https://github.com/LiuMengxuan04/MiniCode) 二次开发，感谢其终端 agent 内核的出色工作。

## License

Distributed under the [MIT License](./LICENSE).