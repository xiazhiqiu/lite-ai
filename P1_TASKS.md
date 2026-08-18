# P1 实施任务清单（轻量 OpenSpec）

> 来源：SRE_ASSISTANT_PRD.md v2.0
> 机制：每个 spec 有验收标准（Acceptance），任务按顺序勾选，勾选驱动进度。
> 执行顺序 = 依赖顺序。每个 task 完成后跑一次 `npm test`。

## 执行顺序（依赖图）

```
P1-3 假设-验证链 ──┬──► P1-4 事故检查点+交接简报
                   └──► P1-5 事故事实层 compact 保护
P1-1 流式日志 tail（独立）
P1-2 复盘报告生成（独立，依赖 P1-3 的假设链做证据源）
```

---

## Spec 1：P1-3 假设-验证链（Hypothesis Tracker）

**依赖**：无
**验收标准（Acceptance）**
- [x] `hypothesis_tracker` 工具注册到 tools/index.ts，schema 校验 action 枚举
- [x] 支持 4 个 action：`add_hypothesis` / `add_evidence` / `update_status` / `get_summary`
- [x] 假设对象含：id / description / priority(1-5) / status / created_at / evidence[] / conclusion
- [x] 证据对象含：command / output_summary / data_source / timestamp / supports
- [x] status 枚举：`pending` / `investigating` / `confirmed` / `refuted` / `inconclusive`
- [x] refuted 假设保留在列表中（不删除）
- [x] `get_summary` 返回完整结构化假设树（JSON）
- [x] 标记 `isParallelSafe: false`（写状态）
- [x] prompt.ts 加入假设链使用指令
- [x] 测试：`test/hypothesis-tracker.test.ts` 全绿

**任务清单（Tasks）**
- [x] T1.3.1 新建 `src/utils/hypothesis-store.ts`：定义类型 + 内存 store（增/查/更新/汇总）
- [x] T1.3.2 新建 `src/tools/hypothesis-tracker.ts`：实现 4 个 action + zod schema
- [x] T1.3.3 在 `src/tools/index.ts` 注册 `hypothesis_tracker`
- [x] T1.3.4 在 `src/prompt.ts` 加入假设链使用指令
- [x] T1.3.5 新建 `test/hypothesis-tracker.test.ts` 并跑通

---

## Spec 2：P1-4 事故检查点 + 跨班交接简报（Incident Checkpoint）

**依赖**：Spec 1（简报引用假设链状态）
**验收标准（Acceptance）**
- [x] `incident_checkpoint` 工具注册到 tools/index.ts
- [x] 支持 4 个 action：`create` / `list` / `switch_to` / `generate_handover`
- [x] ~~session.ts 新增 `insertCheckpoint()` / `getCheckpoints()` / `truncateToCheckpoint()`~~ **【偏差】改用独立的 `src/utils/checkpoint-store.ts` 落盘到 LITE_AI_HOME/checkpoints/，不基于 session checkpoint_marker 消息**
- [x] 最大检查点 5 个，超限自动合并最旧点
- [x] `generate_handover` 输出 Markdown 简报，含：严重级别 / 现象 / 时间线 / 已排除假设 / 待验证假设 / 已执行命令 / 推荐下一步
- [x] prompt.ts 加入检查点使用指令
- [x] 测试：`test/incident-checkpoint.test.ts` 全绿

**任务清单（Tasks）**
- [x] T1.4.1 ~~在 `src/session.ts` 增加 checkpoint 三方法~~ **【偏差】新建 `src/utils/checkpoint-store.ts`：IncidentCheckpoint 类型 + readCheckpoints/saveCheckpoints/enforceCheckpointLimit**
- [x] T1.4.2 新建 `src/tools/incident-checkpoint.ts`：4 个 action + 简报模板
- [x] T1.4.3 在 `src/tools/index.ts` 注册 `incident_checkpoint`
- [x] T1.4.4 在 `src/prompt.ts` 加入检查点使用指令
- [x] T1.4.5 新建 `test/incident-checkpoint.test.ts` 并跑通

---

## Spec 3：P1-5 事故事实层 compact 保护（Incident Fact Layer）

**依赖**：Spec 1（从假设链提取事实快照）
**验收标准（Acceptance）**
- [x] 新增 `src/compact/incident-facts.ts`：`extractIncidentFactSnapshot()` 函数
- [x] 快照含：incident_title / severity / start_time / hypotheses(active/confirmed/refuted/summary) / key_commands(≤10) / next_steps
- [x] auto-compact 压缩前注入快照到压缩后 prompt 末尾
- [x] 不破坏现有 compact 行为（已有 compact 测试仍通过）
- [x] 假设链为空时不注入（无事故场景降级为原行为）
- [x] 测试：`test/incident-facts.test.ts` 全绿

**任务清单（Tasks）**
- [x] T1.5.1 新建 `src/compact/incident-facts.ts`：快照类型 + 提取函数
- [x] T1.5.2 改造 `src/compact/compact.ts`（含 `auto-compact.ts` / `manual-compact.ts` 透传 cwd）：压缩前调提取函数并注入
- [x] T1.5.3 新建 `test/incident-facts.test.ts` 并跑通
- [x] T1.5.4 跑全量测试确认现有 compact 测试未回归

---

## Spec 4：P1-1 流式日志 tail（独立）

**依赖**：无
**验收标准（Acceptance）**
- [x] ~~`tail_logs` 工具：spawn 子进程，流式收集 stdout 到环形缓冲区~~ **【偏差】改为一次性读取末尾 N 行（file）或 kubectl logs --tail=N（kubectl），非 spawn 子进程流式**
- [x] ~~`read_tail_output` 工具：读取最近 N 行 + 是否已结束~~ **【偏差】改为 `follow_logs` 工具：创建会话后轮询增量行（首次返回尾部，后续返回自上次以来新增行）**
- [x] ~~`stop_tail` 工具：终止流式任务~~ **【偏差】改为 `stop_follow` 工具：释放 follow 会话**
- [x] ~~复用 `background-tasks.ts` 的 BackgroundTaskRecord，扩展 stdoutBuffer~~ **【偏差】改为模块级内存 Map 管理 follow 会话（ephemeral，重启丢失，符合 tail -f 语义）**
- [x] ~~command 必须是 P0-1 只读白名单命令（复用 `isSreReadOnlyCommand`）~~ **【偏差】改为只支持 file / kubectl 两种数据源，kubectl 直接调 `kubectl logs`（受 P0-1 白名单约束）**
- [x] ~~duration_sec 上限 120s，超时自动 kill~~ **【偏差】轮询模型无长时间运行进程，不需要超时 kill**
- [x] 单次返回最多 500 行，超出截断 + 提示用 follow_logs 翻页
- [x] `tail_logs` 标记 `isParallelSafe: true`；`follow_logs` / `stop_follow` 标记 `isParallelSafe: false`
- [x] 测试：`test/tail-logs.test.ts` 全绿（22 测试，含 kubectl mock / 大文件截断 / 日志轮转）

**任务清单（Tasks）**
- [x] T1.1.1 ~~扩展 `src/background-tasks.ts`：BackgroundTaskRecord 加 stdoutBuffer~~ **【偏差】新建 `src/tools/tail-logs.ts` 内部会话 Map（FollowSession 类型）**
- [x] T1.1.2 新建 `src/tools/tail-logs.ts`：3 个工具（tail_logs / follow_logs / stop_follow）+ 截断
- [x] T1.1.3 在 `src/tools/index.ts` 注册 3 个工具
- [x] T1.1.4 新建 `test/tail-logs.test.ts` 并跑通

---

## Spec 5：P1-2 复盘报告生成（postmortem）

**依赖**：Spec 1（假设链作为证据源）
**验收标准（Acceptance）**
- [x] `generate_postmortem` 工具注册到 tools/index.ts
- [x] ~~session.ts 新增 `getToolCallTimeline()`：提取工具调用时间线~~ **【偏差】改为从 hypothesis-store 的 evidence 按 timestamp 排序生成时间线（更贴近 RCA 证据时间线语义）**
- [x] 输出 Markdown 报告含：概述 / 影响范围 / 时间线（含证据引用）/ 根因分析 / ~~缓解措施~~ 处置记录 / 改进项（经验教训）
- [x] 时间线每条可追溯到具体工具调用（evidence.command）
- [x] 报告可直接配合 ~~`write_file` 落盘~~ **【偏差】工具内部直接落盘到 LITE_AI_HOME/postmortems/{project}-{checkpoint_id}.md**
- [x] 测试：`test/generate-postmortem.test.ts` 全绿（9 测试，含活动检查点回退）

**任务清单（Tasks）**
- [x] T1.2.1 ~~在 `src/session.ts` 新增 `getToolCallTimeline()`~~ **【偏差】在 `src/tools/generate-postmortem.ts` 内实现 `buildTimeline()`：从 hypothesis-store evidence 提取**
- [x] T1.2.2 新建 `src/tools/generate-postmortem.ts`：读时间线 + ~~构造 prompt + 调 model~~ **【偏差】模板化生成报告（确定性 + 可单测，不调 model）**
- [x] T1.2.3 在 `src/tools/index.ts` 注册 `generate_postmortem`
- [x] T1.2.4 新建 `test/generate-postmortem.test.ts` 并跑通

---

## 最终验证

- [x] `npm test` 全量通过（含既有 288 项 + 新增）—— **当前 355/355 通过**
- [x] P1 里程碑 M1 达成：P1-1 ~ P1-5 全部实现
- [x] 更新 SRE_ASSISTANT_PRD.md 的实施路线图：P1 勾选完成

---

## 实现偏差汇总（M1 达成，但 3 个 Spec 与原 task 描述有偏差）

| Spec | 偏差 | 原因 | 影响 |
|---|---|---|---|
| **P1-1 流式日志 tail** | task 要求 spawn 子进程 + background-tasks 复用 + 120s 超时；实际是一次性读 + 轮询会话 | 轮询模型更简单，覆盖 SRE 实际场景（tail -f 一个会持续输出的 pod 日志）；真实流式 + background-tasks 复用复杂度高 | 失去"真实流式"和"超时 kill"语义；对间歇性日志输出，轮询间隔需 agent 自行把控 |
| **P1-2 postmortem** | task 要求 session.ts 加 getToolCallTimeline + 调 model 生成；实际从 evidence 取时间线 + 模板化生成 | 模板化保证确定性 + 可单测；evidence 时间线比 session tool call 更贴近 RCA 语义 | 报告叙述不如 LLM 生成自然；如需自然叙述可后续加 model-enhanced 版本 |
| **P1-4 检查点** | task 要求 session.ts 加 checkpoint_marker 消息三方法；实际用独立 checkpoint-store.ts 落盘 | 独立 store 更简单，跨 session 可读（resume/fork 时检查点不丢）；不侵入 session 消息流 | 与 session 机制解耦，switch_to 不截断消息流（如需回滚消息需另实现） |

**测试覆盖**：355 测试全绿（P1-1: 22 / P1-2: 9 / P1-3: 见 hypothesis-tracker.test.ts / P1-4: 11 / P1-5: 11 + 既有 288）。E2E 验证已跑通 payment_loss/1 + carts_mem/1（orders_delay 超时跳过）。
