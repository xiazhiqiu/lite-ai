# 单工具重复调用软提示设计

日期：2026-08-20
状态：待用户 review

## 背景与动机

在 `model → tool → model` 循环中，模型可能因失败重试或决策偏差而**连续重复调用同一工具、同一输入**（例如反复 `run_command` 执行同一条命令、反复 `tail_logs` 读同一日志、反复 `web_search` 同一查询），既不推进任务，也浪费上下文与资源。

项目现有防线：
- 总步数上限 `maxSteps`（agent-loop 循环上限）
- `AbortSignal` 手动中止
- 空响应 / 空思考重试上限
- 多级上下文压缩

但这些都无法对「同一操作被连续反复执行」这一具体模式作出反应。本设计新增一层针对**连续重复调用**的软提示机制。

## 目标

- 检测「同一工具、同一输入」被**连续相邻**重复调用达到阈值。
- **不拦截**，执行照常，仅在工具结果中附加一条建议文本，引导模型自我调整。
- 零误伤：不阻断合法轮询（如 `tail_logs` 读新增日志、`read_file` 读正在生成的文件），也不阻断任何合法多次调用。
- 全量覆盖所有工具。

## 非目标（本次不做）

- 不拦截 / 中止工具调用或回合。
- 不做工具白名单 / 差异化阈值（软提示零误伤，无需豁免）。
- 不做跨回合持久化计数。

## 核心决策

| 项 | 决策 | 理由 |
|---|---|---|
| 判定粒度 | 工具名 + 输入的稳定序列化 key | 区分「读不同文件」与「反复读同一文件」 |
| 重复语义 | **连续相邻**才累计 | 只拦「原地踏步」，不误伤轮询；中间插入任一不同调用即清零 |
| 触发行为 | **仅附加一条建议**，不拦截 | 零误伤、可自我调整，符合「先软引导」的成熟做法 |
| 呈现方式 | 建议附加到该工具**结果字符串前** | 模型必然可见，执行不受影响 |
| 覆盖 | agent-loop 执行循环统一检查 | 所有工具都从该公共路径经过，保证全量覆盖 |
| 作用域 | 每回合（beginTurn 清零） | 复用 PermissionManager 生命周期 |
| 配置 | 环境变量缺省 3 | 简洁、可调 |

## 现状核对

### PermissionManager 实例化点（每会话一个实例）

| 入口 | 实例化 | 生命周期 |
|---|---|---|
| TUI 交互 | `tty-app.ts` | `beginTurn` → `runAgentTurn` → `endTurn`（每用户输入） |
| 无头/API | `index.ts` | 同上 |
| webhook 诊断 | `diagnose.ts` | 单实例单回合，无 `beginTurn` |

webhook 每告警新建实例且只服务一次，等价于每回合一个，计数无需额外重置。

### 工具调用链路确认

`PermissionManager` 经 `ToolContext.permissions` 注入，覆盖面：
- `ensurePathAccess`（workspace.ts「所有文件类工具」）
- `ensureCommand`（run_command）
- `ensureEdit`（file-review「写文件审阅」）

`web_search` / `tail_logs` / `hypothesis_tracker` 等不触发上述 ensure*。因此重复检查**不能**塞进 ensure* 内部，必须放在 agent-loop 执行循环这一公共咽喉点，才能全量覆盖。

## 设计

### 1. 状态与生命周期（并入 PermissionManager）

新增实例字段：

```
turnToolRepeatConsecutive: Map<string, number>  // key → 连续相邻出现次数
```

- 在 `beginTurn()` 中清空（复用现有生命周期）。
- 不落盘（`persist()` 只处理授权记录）。

### 2. 新增方法

```
noticeToolRepeat(toolName: string, input: unknown, noticeAt?: number): string | null
```

- 计算稳定 key（工具名 + 确定性序列化输入）。
- 在 `turnToolRepeatConsecutive` 中累加当前 key 的连续次数。
- 返回文案（当累计达到 `noticeAt` 及以后）或 `null`（未达阈值）。

**清零规则**：在每次对任意工具调用前维护一个「上次 key」。若本次 key ≠ 上次 key，则把上次 key 计数清零、当前 key 置为 1。即只统计「连续相邻」出现的次数；一旦中间插入不同调用，重新计数。

**文案示例**：

```
! 提示：此调用（<tool>：<摘要>）已连续出现 <N> 次，结果未见进展。如非有意轮询，请考虑更换策略、修正输入，或确认任务是否已可结束。
```

### 3. 调用点（agent-loop 执行循环）

在工具实际执行前，对每个 call 调用 `permissions.noticeToolRepeat(...)`（串行批、并行批均检查）。返回非空文案时，将该文案**前置拼接**到该工具的执行结果内容前（`tool_use` + `tool_result` 结构）。执行本身照常进行。

具体拼接位置：保留 `ok` 与 `output` 不变，仅把提示文本插到 `output` 开头（或以独立字段传给渲染层附注）。倾向前者（结果内附注），使模型必然在 `tool_result` 中看到。

注意到上限后，后续每个该 key 的调用都会继续附加提示，直到插入不同调用清零。

### 4. 配置

环境变量 `LITE_AI_TOOL_REPEAT_NOTICE_MAX`（缺省 `3`），在 `runAgentTurn` 读取一次，传入 `noticeToolRepeat`。

## 数据流

```
agent-loop 循环
  └─ for each tool call
       └─ permissions.noticeToolRepeat(toolName, input, noticeMax)
            ├─ 未达阈值 → return null → 正常执行 → 正常结果
            └─ 达阈值 → return 提示文案 → 前置附加到工具结果 → 正常执行
  └─ 每回合 beginTurn() 清空 turnToolRepeatConsecutive
```

## 错误处理与边界

- 输入序列化失败（循环引用等）→ 退化为「按工具名计数」或直接放行，不抛异常。
- 无 `permissions`（子 agent 等场景）→ 跳过检查，行为与现状一致。
- 并行批多个 call 同时检查：以「当前 key」顺序判定相邻性，同一批内按发射序处理；不同 key 相邻仍按清零规则。

## 测试

- 连续同 key 达阈值 → 结果带附加提示；未达阈值 → 无提示。
- 中间插入不同调用 → 计数清零，后续同 key 重新计数。
- 不同 key 各自独立计数、互不干扰。
- 并行批内相邻性判断正确。
- 配置缺省 / 显式设置阈值均生效。
- webhook（单实例单回合）与 TUI（beginTurn 清零）行为符合预期。

## 验收标准

1. 连续重复调用同工具同输入达到配置阈值后，工具结果中出现提示文本，执行不被中断。
2. 合法轮询（`tail_logs` 隔次调用、不同输入多次调用）不触发误拦截 / 不产生烦人提示。
3. 覆盖所有工具（含 `web_search`、`tail_logs`、`hypothesis_tracker` 等非 ensure* 工具）。
4. 通过新增单元测试 + 现有回归测试。

## 附录：市面相关做法调研

- Claude Code 通过 `PreToolUse`/`PostToolUse` hook 让用户自实现拦截或注入反馈（硬/软由用户决定），其 set 级计数不是内建能力。
- OpenAI Codex / Assistants 以 `max_iterations` 硬上限为主，无同输入软提示。
- ReAct 类 loop 方案常见「检测到相同 tool+input N 次 → 向 prompt 注入『请改变策略』观察提示」的做法，即本设计采用的软提示思路。

结论：本设计采用成熟且有先例的「软引导」路径，并与项目既有 `maxSteps`、hook 式 permission 决策链、多级压缩防线互补。