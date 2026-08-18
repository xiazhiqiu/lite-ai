# LiteAI — SRE 事故诊断助手

<p align="center">
  <b>终端原生、MCP 开放、单会话可审计、可 resume/fork 的 SRE 事故诊断 Agent。</b>
</p>

<p align="center">
  对标 Datadog Bits AI 的调查能力与 Dynatrace Davis 的因果分析，但以 <b>终端 agent</b> 形态交付 ——<br/>
  不依赖平台侧多租户基础设施，适配 SSH / jumpbox / 气隔环境 / 值班机等 SRE 真实工作流。
</p>

---

LiteAI 是一个**轻量、终端优先（terminal-first）**的 AI 助手：底层是类似 Claude Code 的 `model → tool → model` 编码工作流，上层沉淀了一套面向事故诊断的领域能力（假设-验证链、检查点、复盘、知识库 RAG、告警 webhook）。实现小而可读，适合学习、实验与二次开发。

## 核心能力

### 事故诊断（SRE 领域能力）

- **假设-验证链** —— 通过 `hypothesis_tracker` 工具维护结构化根因假设（pending / investigating / confirmed / refuted / inconclusive），每条结论附带可追溯证据
- **事故检查点与交接简报** —— `incident_checkpoint` 支持创建/切换检查点，一键生成跨班交接简报（现象 / 时间线 / 已排除假设 / 待验证假设 / 关键命令）
- **复盘报告生成** —— `generate_postmortem` 从证据链提取时间线，模板化生成 Markdown 复盘，并自动索引进知识库
- **事故知识库 RAG** —— `search_incident_kb` 用 sqlite-vec 做本地语义检索（离线 ONNX embedding，无外部依赖），排查前先召回相似历史事故
- **流式日志** —— `tail_logs` / `follow_logs` / `stop_follow` 按级别着色、支持超大文件与滚动读取
- **告警 webhook** —— `lite-ai --webhook [port]` 启动独立监听进程，接收 Alertmanager 告警后自动去重、诊断并回推通知
- **只读安全白名单** —— kubectl / docker / curl 子命令级白名单，写操作（`kubectl delete`、`curl -X POST` 等）一律拦截，杜绝诊断误写扩大事故
- **评测框架** —— 内置 RE2-SS 基准接入，量化根因定位准确率（AC@1 / AC@3 / Steps / Evidence Rate）

### 终端 agent 基础能力

- 全屏终端 TUI，支持输入历史、会话滚动、slash 命令菜单与审批流程
- 按项目持久化会话，支持 `resume` / `fork` / `rename` / `compact`
- 四级上下文压缩（snip / microcompact / collapse / auto-compact），长会话可追溯
- 内置文件读写、搜索、命令执行、网页抓取/搜索等工具；写文件前先审阅 diff
- 通过 `SKILL.md` 发现本地技能，支持 MCP 工具/资源/prompt（stdio 或远程 HTTP）

## 安装

```bash
cd lite-ai
npm install
npm run install-local
```

安装器会引导配置模型 provider、base URL 与认证 token，保存在：

- `~/.lite-ai/settings.json`
- `~/.lite-ai/mcp.json`

可用 `LITE_AI_HOME` 覆盖配置目录，用 `LITE_AI_BIN_DIR` 覆盖启动器目录。

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
       ├─ search_incident_kb  检索相似历史事故
       ├─ 诊断取证（kubectl / Prometheus / ES / tail_logs）
       ├─ hypothesis_tracker  注册假设 → 附着证据 → 判定状态
       ├─ incident_checkpoint 关键阶段打点 / 生成交接简报
       ├─ 定位根因 → 给出处置建议（写操作需审批）
       └─ generate_postmortem 生成复盘报告并入库
```

## 常用命令

- `/help` 交互式帮助
- `/tools` 查看可用工具与快捷方式
- `/status` 查看当前模型与配置来源
- `/skills` 查看已发现技能
- `/mcp` 查看 MCP 连接状态
- `/resume` 打开会话选择器
- `/fork` 派生当前会话
- `/compact` / `/collapse` / `/snip` 手动压缩上下文
- `/init` 为当前项目初始化 `.lite-ai/` 与 `LITE.md`
- `/permissions` 查看权限存储路径

管理命令包括 `lite-ai mcp ...` 与 `lite-ai skills ...`。

## 告警 webhook 配置

webhook 可用环境变量或 `~/.lite-ai/settings.json` 的 `webhook` 字段配置：

| 配置 | 环境变量 | 默认值 |
|---|---|---|
| 监听端口 | `LITE_AI_WEBHOOK_PORT` | `8787` |
| 监听地址 | `LITE_AI_WEBHOOK_HOST` | `127.0.0.1` |
| 校验 token | `LITE_AI_WEBHOOK_SECRET` | — |
| 自动诊断 | `LITE_AI_WEBHOOK_AUTO_DIAGNOSE` | `true` |
| 通知回调 | `LITE_AI_WEBHOOK_NOTIFY_URL` | — |

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
```

LiteAI 刻意保持小巧务实：架构分层清晰、接口极小化（核心只围绕 `ModelAdapter.next()` 与 `ToolRegistry.execute()` 两个接口），目标是易 hack、易扩展。