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
- [ ] `hypothesis_tracker` 工具注册到 tools/index.ts，schema 校验 action 枚举
- [ ] 支持 4 个 action：`add_hypothesis` / `add_evidence` / `update_status` / `get_summary`
- [ ] 假设对象含：id / description / priority(1-5) / status / created_at / evidence[] / conclusion
- [ ] 证据对象含：command / output_summary / data_source / timestamp / supports
- [ ] status 枚举：`pending` / `investigating` / `confirmed` / `refuted` / `inconclusive`
- [ ] refuted 假设保留在列表中（不删除）
- [ ] `get_summary` 返回完整结构化假设树（JSON）
- [ ] 标记 `isParallelSafe: false`（写状态）
- [ ] prompt.ts 加入假设链使用指令
- [ ] 测试：`test/hypothesis-tracker.test.ts` 全绿

**任务清单（Tasks）**
- [ ] T1.3.1 新建 `src/utils/hypothesis-store.ts`：定义类型 + 内存 store（增/查/更新/汇总）
- [ ] T1.3.2 新建 `src/tools/hypothesis-tracker.ts`：实现 4 个 action + zod schema
- [ ] T1.3.3 在 `src/tools/index.ts` 注册 `hypothesis_tracker`
- [ ] T1.3.4 在 `src/prompt.ts` 加入假设链使用指令
- [ ] T1.3.5 新建 `test/hypothesis-tracker.test.ts` 并跑通

---

## Spec 2：P1-4 事故检查点 + 跨班交接简报（Incident Checkpoint）

**依赖**：Spec 1（简报引用假设链状态）
**验收标准（Acceptance）**
- [ ] `incident_checkpoint` 工具注册到 tools/index.ts
- [ ] 支持 4 个 action：`create` / `list` / `switch_to` / `generate_handover`
- [ ] session.ts 新增 `insertCheckpoint()` / `getCheckpoints()` / `truncateToCheckpoint()`
- [ ] 最大检查点 5 个，超限自动合并最旧点
- [ ] `generate_handover` 输出 Markdown 简报，含：严重级别 / 现象 / 时间线 / 已排除假设 / 待验证假设 / 已执行命令 / 推荐下一步
- [ ] prompt.ts 加入检查点使用指令
- [ ] 测试：`test/incident-checkpoint.test.ts` 全绿

**任务清单（Tasks）**
- [ ] T1.4.1 在 `src/session.ts` 增加 checkpoint 三方法（基于 checkpoint_marker 消息）
- [ ] T1.4.2 新建 `src/tools/incident-checkpoint.ts`：4 个 action + 简报模板
- [ ] T1.4.3 在 `src/tools/index.ts` 注册 `incident_checkpoint`
- [ ] T1.4.4 在 `src/prompt.ts` 加入检查点使用指令
- [ ] T1.4.5 新建 `test/incident-checkpoint.test.ts` 并跑通

---

## Spec 3：P1-5 事故事实层 compact 保护（Incident Fact Layer）

**依赖**：Spec 1（从假设链提取事实快照）
**验收标准（Acceptance）**
- [ ] 新增 `src/compact/incident-facts.ts`：`extractIncidentFactSnapshot()` 函数
- [ ] 快照含：incident_title / severity / start_time / hypotheses(active/confirmed/refuted/summary) / key_commands(≤10) / next_steps
- [ ] auto-compact 压缩前注入快照到压缩后 prompt 末尾
- [ ] 不破坏现有 compact 行为（已有 compact 测试仍通过）
- [ ] 假设链为空时不注入（无事故场景降级为原行为）
- [ ] 测试：`test/incident-facts.test.ts` 全绿

**任务清单（Tasks）**
- [ ] T1.5.1 新建 `src/compact/incident-facts.ts`：快照类型 + 提取函数
- [ ] T1.5.2 改造 `src/compact/auto-compact.ts`：压缩前调提取函数并注入
- [ ] T1.5.3 新建 `test/incident-facts.test.ts` 并跑通
- [ ] T1.5.4 跑全量测试确认现有 compact 测试未回归

---

## Spec 4：P1-1 流式日志 tail（独立）

**依赖**：无
**验收标准（Acceptance）**
- [ ] `tail_logs` 工具：spawn 子进程，流式收集 stdout 到环形缓冲区
- [ ] `read_tail_output` 工具：读取最近 N 行 + 是否已结束
- [ ] `stop_tail` 工具：终止流式任务
- [ ] 复用 `background-tasks.ts` 的 BackgroundTaskRecord，扩展 stdoutBuffer
- [ ] command 必须是 P0-1 只读白名单命令（复用 `isSreReadOnlyCommand`）
- [ ] duration_sec 上限 120s，超时自动 kill
- [ ] 单次返回最多 500 行，超出截断 + 提示用 read_tail_output 翻页
- [ ] `tail_logs` / `read_tail_output` 标记 `isParallelSafe: true`
- [ ] 测试：`test/tail-logs.test.ts` 全绿

**任务清单（Tasks）**
- [ ] T1.1.1 扩展 `src/background-tasks.ts`：BackgroundTaskRecord 加 stdoutBuffer（环形，上限 1000 行）
- [ ] T1.1.2 新建 `src/tools/tail-logs.ts`：3 个工具 + 只读命令校验 + 截断
- [ ] T1.1.3 在 `src/tools/index.ts` 注册 3 个工具
- [ ] T1.1.4 新建 `test/tail-logs.test.ts` 并跑通

---

## Spec 5：P1-2 复盘报告生成（postmortem）

**依赖**：Spec 1（假设链作为证据源）
**验收标准（Acceptance）**
- [ ] `generate_postmortem` 工具注册到 tools/index.ts
- [ ] session.ts 新增 `getToolCallTimeline()`：提取工具调用时间线
- [ ] 输出 Markdown 报告含：概述 / 影响范围 / 时间线（含证据引用）/ 根因分析 / 缓解措施 / 改进项
- [ ] 时间线每条可追溯到具体工具调用
- [ ] 报告可直接配合 `write_file` 落盘
- [ ] 测试：`test/generate-postmortem.test.ts` 全绿

**任务清单（Tasks）**
- [ ] T1.2.1 在 `src/session.ts` 新增 `getToolCallTimeline()`
- [ ] T1.2.2 新建 `src/tools/generate-postmortem.ts`：读时间线 + 构造 prompt + 调 model
- [ ] T1.2.3 在 `src/tools/index.ts` 注册 `generate_postmortem`
- [ ] T1.2.4 新建 `test/generate-postmortem.test.ts` 并跑通

---

## 最终验证

- [ ] `npm test` 全量通过（含既有 288 项 + 新增）
- [ ] P1 里程碑 M1 达成：P1-1 ~ P1-5 全部实现
- [ ] 更新 SRE_ASSISTANT_PRD.md 的实施路线图：P1 勾选完成
