# LiteAI — SRE 事故诊断助手

<p align="center">
  <img src="./docs/logo.jpg" alt="LiteAI Logo" width="180" />
</p>

<p align="center">
  <b>终端原生、轻量可 hack、面向 SRE 故障处置的事故诊断 Agent。</b>
</p>

<p align="center">
  <b>告警响应 · 根因定位 · 交接与复盘 · 事故知识库</b><br/>
  在 `model → tool → model` 编码工作流之上，围绕故障定位闭环沉淀了假设-验证、检查点交接、复盘归档与本地知识库检索，适配 SSH / jumpbox / 气隔 / 值班机等办公网络受限场景。
</p>

---

LiteAI 是一个**轻量、终端优先（terminal-first）**的 AI 助手：完整包含从 ReAct 循环、工具模型、会话管理到 TUI 的 agent 内核，并在此基础上实现了面向事故诊断的领域能力，运行状态全程可审计、可 resume/fork。实现紧凑、接口极小，易学、易改、易扩展。

## 核心能力

- **标准 ReAct 循环** —— `model → tool → model` 单轮内可多步调用工具；超大工具结果自动落盘并在上下文里替换为短预览与文件路径
- **全屏终端 TUI** —— 输入历史、会话滚动、斜杠命令菜单与审批流程
- **并发子 agent** —— 最多 3 个并发**只读**子 agent，共享模型与工具子集，可并行搜证
- **会话管理** —— 按项目持久化，支持 `resume` / `rename` / `fork` / `new`
- **上下文压缩** —— 多级压缩（snip / microcompact / collapse / auto-compact），长会话可追踪
- **内置工具集** —— 文件读写（写前审阅 diff）、搜索、命令执行、网页抓取/搜索、提问澄清；通过 `SKILL.md` 发现本地技能，支持 MCP 工具/资源/prompt（stdio 或远程 HTTP）
- **假设-验证链** —— `hypothesis_tracker` 维护结构化根因假设（pending / investigating / confirmed / refuted / inconclusive），每条结论附带可追溯证据
- **检查点与交接简报** —— `incident_checkpoint` 支持创建/切换检查点，一键生成跨班交接简报（现象 / 时间线 / 已排除假设 / 待验证假设 / 关键命令）
- **复盘报告生成** —— `generate_postmortem` 从证据链提取时间线，模板化生成 Markdown 复盘并落盘归档与入库
- **事故知识库 RAG** —— `search_incident_kb` 用 sqlite-vec 做本地语义检索（离线 embedding，`models/` 按需下载），排查前先召回相似历史事故
- **流式日志** —— `tail_logs` / `follow_logs` / `stop_follow` 按级别着色，支持超大文件与滚动读取
- **告警 webhook** —— `lite-ai --webhook [port]` 独立监听进程，接收 Alertmanager 等事件源告警，自动去重、排队诊断并回推通知
- **只读安全白名单** —— kubectl / docker / curl 等子命令级白名单，写操作（`kubectl delete`、`curl -X POST` 等）一律拦截
- **评测基准** —— 内置 RE2-SS 评测框架，量化根因定位准确率（AC@1 / AC@3 / Steps / Evidence Rate）

## 安装

```bash
cd lite-ai
npm install
npm run install-local
```

安装器会引导配置模型名、base URL 与认证 token，写入 `~/.lite-ai/settings.json`，并生成 `lite-ai` 启动器到 `~/.local/bin`（可用 `LITE_AI_BIN_DIR` 覆盖）。

其他配置位置：

- `~/.lite-ai/settings.json` —— 主配置
- `~/.lite-ai/mcp.json` / 项目下 `.mcp.json` —— MCP server 配置
- `~/.claude/settings.json` —— Claude Code 兼容回退

可用 `LITE_AI_HOME` 覆盖整个配置/数据目录。

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

## 典型诊断流程

```
告警 / 值班触发
  └─ 描述现象（"payment 服务全部 500"）
       ├─ search_incident_kb   检索相似历史事故
       ├─ 诊断取证（kubectl / Prometheus / ES / tail_logs）
       ├─ hypothesis_tracker   注册假设 → 附着证据 → 判定状态
       ├─ incident_checkpoint  关键阶段打点 / 生成交接简报
       ├─ 定位根因 → 给出处置建议（写操作需审批）
       └─ generate_postmortem  生成复盘报告并归档入库
```

## 常用入口点

- `/help` 查看可用命令
- `/tools` 列出可用工具与快捷方式
- `/status` 查看当前模型、provider 与配置来源
- `/model [name]` 查看或持久化切换模型
- `/config-paths` 显示各配置路径
- `/skills` 查看已发现技能
- `/mcp` 查看 MCP 连接状态
- `/alerts` 列出最近由 webhook 诊断的告警及其 resume 命令
- `/resume` / `/rename` / `/fork` / `/new` 会话管理
- `/compact` / `/collapse` / `/snip` 手动压缩上下文
- `/memory` 查看加载进系统提示的说明文件
- `/init` 为当前项目初始化 `.lite-ai/`、`.gitignore` 条目与 `LITE.md`
- `/permissions` 查看权限存储路径
- 快捷编辑：`/ls` `/grep` `/read` `/write` `/modify` `/edit` `/patch` `/cmd`

管理命令：`lite-ai mcp [list|add|remove|login|logout] [--project] ...`、
`lite-ai skills [list|add|remove] ...`，完整用法见 `lite-ai help`。

## 配置

模型与运行参数按以下优先级解析：`~/.lite-ai/settings.json` > `~/.claude/settings.json` > 环境变量。可用环境变量：

| 变量 | 说明 |
|---|---|
| `LITE_AI_PROVIDER` | `openai`（默认）/ `anthropic` |
| `LITE_AI_MODEL` | 当前模型名 |
| `LITE_AI_MAX_OUTPUT_TOKENS` | 最大输出 token 数 |
| `LITE_AI_MODEL_MODE=mock` | 离线演示模式，无需 API Key |
| `LITE_AI_EMBED_DIMENSION` | 知识库 embedding 维度（默认 384，`models/` 自备模型时可覆盖；改动需重建知识库） |
| `LITE_AI_HOME` | 覆盖配置/数据目录 |
| `LITE_AI_BIN_DIR` | 覆盖启动器安装目录 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI 兼容 provider |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic provider |

数据/产物落盘于 `LITE_AI_HOME`：会话（`projects/`）、权限（`permissions.json`）、webhook 记录（`webhook/alerts.jsonl`）、复盘报告（`postmortems/`）、事故知识库（`incident-kb/kb.db`）。

## 告警 webhook

通过 `~/.lite-ai/settings.json` 的 `webhook` 字段配置，`lite-ai --webhook [port]` 启动：

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

## 评测

```bash
# 全量 RE2-SS 评测
npm run eval:re2ss

# 仅指定故障类型
npm run eval:re2ss -- --filter=payment_loss
```

## 开发

```bash
npm run check       # tsc 类型检查
npm run lint        # eslint
npm test            # 测试（node test/run-tests.mjs）
npm run dev         # 开发模式
```

架构分层清晰、接口极小化（核心围绕 `ModelAdapter.next()` 与 `ToolRegistry.execute()`），事故诊断领域能力集中在 `src/webhook/`、`src/tools/`（SRE 工具）与知识库工具链中。

## 致谢

LiteAI 是基于 [MiniCode](https://github.com/LiuMengxuan04/MiniCode) 的二次开发。感谢 MiniCode 及其作者在终端 agent 内核上的出色工作。