# Context Size / Token 优化 Plan

## 执行结果
- 第 1 步 ✅ 落地：`DEFAULT_OUTPUT_CHARS` 30k→8k（单一来源）；ES search 命中 >50 条截断并标 `_shownOf`；`get_metric_names`/`get_label_values` 用 `summarizeStringList` 压缩为摘要。`npm check`+432 测试全绿。
- 第 2 步 ✅ 落地：新增 `COMPACTABLE_TOOL_PREFIXES`（prometheus_/elasticsearch_/kubernetes_），microcompact 清空数据源旧 tool_result（≥50% 利用率，保留最近 3 条）。database 因实例名动态未列入。
- 第 3 步 ❌ 放弃：thinking 回传被 `openai-adapter.test` / `anthropic-thinking-roundtrip` 刻意锁定 + DeepSeek 硬约束 `passBackReasoning: true`。正如本 plan 预设的退出分支。
- 第 4 步：P1 默认并行已落地，套用为验收参考。

## 背景
单次调用 input 高达 6~7 万 tokens，成本与延迟过高，还可能触发上下文折叠。审计结论：
- 根因不是"一次传入 7 万"，而是 **agent 串行跑 ~69 次工具**，每次调用都全量重发此前所有 `tool_result` + `thinking` 原文。
- 放大因素：单个 ES/Prometheus 返回很肥（clamp 到 30k 字符 ≈ 7.5k tok）；`context_collapse` 折叠力度不足，历史结果仍大量保留。
- 诱因一：P1 未开 sub-agent 前串行查多源（已修）。
- 诱因二：P0 时间窗错位导致空转试错（未修，本节不覆盖，另见提案）。

## 目标（成功判据）
- 单条超大返回（ES search / get_metric_names / indicator 名）体积降低 60%+。
- 单次调用 input token 相比现状（峰值 7 万）明显下降，且多轮后不再线性膨胀（旧 tool_result 折叠后只带摘要）。
- 不破坏：只读语义、结构化工具可用性、现有测试（尤其 anthropic-thinking-roundtrip）。

## 方案（按性价比排序）

### 1. 收紧单条最大输出 + 工具返回瘦身（收益最大、改动最小）
- `src/tools/data-sources/base.ts`：`clampToolOutput` 30k 字符 → 上限收至 ~12k（初值取 8~12k 区间，先 12k 保守）。
- `elasticsearch search`：默认 `size` 引导更小；命中过多时截断到前 N 条 + 输出命中总数，而非整段原文。
- `prometheus_get_metric_names`：全量指标名改为截断/摘要（命中条数 + 前缀采样 + 是否截断标记），避免一次性碎成 5k+ tok。

### 2. 旧 tool_result 改为折叠摘要（次优但持久）
- 定位现有 `context_collapse` 逻辑（注入点与聚合方式）。在不破坏其语义前提下，对**超大 tool_result**（如 > 既定阈值字符）用"seen earlier + 统计摘要"替换原文。
- 关键约束：summary 应能支撑后续推理（保留返回的数量/结构/关键值），但不能保留 25k 字符原文。

### 3. thinking 回传裁剪（省 ~10k，需先确认）
- 确认 `deepseek-v4-flash` / 当前模型是否回传 `reasoning_content`、以及 `anthropic-thinking-roundtrip` 测试依赖全量 thinking 是否**刻意保留**。
- 若可裁剪：只保留最终结论或压缩中间推理。**若测试是刻意的**，则不修改，改为记录为放弃项并说明原因。

### 4. 并行 + 更聚焦（治源头，与 P1 协同，本节不单独开 P0）
- P1 默认并行已落地；P0 时间窗提示另开提案，不在本 plan 内实现。
- 本节动作：仅确认 P1 落地后串行重复查询明显减少即可，作为本 plan 的验收参考之一，不重复实现。

## 验证
- 单测：`data-source-tools.test.ts` 等——断言单条返回体积受上限约束、截断标记存在、摘要不含 25k 原文。
- 全量：`npm run check` + `npm test`（现 432 pass 全绿基线）。
- 手工：连真实 Prometheus/ES 跑一次查询，记录 input token 前后对比（峰值 7 万 → 目标下降）。

## 范围外（本 plan 不实现）
- P0 时间窗提示（另开提案）
- sub-agent 已有改动的收尾提交