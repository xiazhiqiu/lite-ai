# LiteAI

<p align="center">
  <img src="./docs/logo.svg" alt="LiteAI Logo" width="180" />
</p>

<h3 align="center">轻量级终端 AI 编码助手</h3>

<p align="center">
  A lightweight, terminal-first coding assistant. Built for speed, designed for simplicity.
</p>

---

LiteAI 是一个轻量级终端编码助手，提供了类似 Claude Code 的编码工作流，但实现更小、更易读，适合学习、实验和定制。

## 核心能力

- `model -> tool -> model` 多步工具执行闭环
- 全屏终端 UI，支持输入历史、会话滚动、slash 命令菜单与审批流程
- 按项目持久化会话，支持 resume / rename / fork / compact
- 基于 provider usage 的上下文统计，配套自动压缩、context collapse 与 snip compact
- 内置文件、搜索、编辑、命令执行、网页抓取/搜索等工具
- 通过 `SKILL.md` 发现本地技能，支持 MCP 工具/资源/prompt（stdio 或远程 HTTP）
- 写文件前先审阅 diff，并做路径与命令权限校验

## 安装

```bash
cd lite-ai
npm install
npm run install-local
```

安装器会询问模型名、`ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`。配置保存在：

- `~/.lite-ai/settings.json`
- `~/.lite-ai/mcp.json`

可用 `LITE_AI_HOME` 覆盖配置目录，用 `LITE_AI_BIN_DIR` 覆盖启动器目录。

## 快速开始

```bash
# 运行已安装的启动器
lite-ai

# 开发模式
npm run dev

# 离线演示模式
LITE_AI_MODEL_MODE=mock npm run dev
```

## 常用命令

- `/help` 交互式帮助
- `/tools` 查看可用工具
- `/skills` 查看已发现技能
- `/mcp` 查看 MCP 连接状态
- `/status` 查看会话与上下文状态
- `/init` 为当前项目初始化 `.lite-ai/` 与 `LITE.md`
- `/resume` 打开会话选择器
- `/compact` 手动压缩上下文

管理命令包括 `lite-ai mcp ...` 与 `lite-ai skills ...`。

## 开发

```bash
npm run check
npm test
```

LiteAI 刻意保持小巧务实，目标是让架构清晰、可 hack、易扩展。