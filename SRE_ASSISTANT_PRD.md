# SRE 事故诊断助手 — 产品需求文档（PRD）

> 版本：v2.1 · 2026-08-17（P1 完成，M1 达成）
> 基于 SRE_ASSISTANT_DESIGN.md v1.0 + 竞品调研 + 终端 agent 设计调研 + RE2-SS 测试集分析
> 分支：`feat/data-ops-assistant`

---

## 一、产品定位与场景

### 1.1 一句话定位

**终端原生、MCP 开放、单会话可审计、可 resume/fork 的 SRE 事故诊断 Agent。**

对标 Datadog Bits AI 的 Investigation 能力、Dynatrace Davis 的因果分析能力，但以**终端 agent 形态**交付，不依赖平台侧多租户基础设施，适配 SSH/jumpbox/气隔环境/值班机等 SRE 真实工作流。

### 1.2 目标用户

- **SRE/DevOps 值班人员**：事故发生时快速诊断、跨班交接、复盘报告
- **平台工程团队**：维护内部可观测系统，需要统一诊断入口
- **合规审计团队**：需要可追溯的排查轨迹（金融/政务场景）

### 1.3 与非终端诊断工具的核心差异

| 维度 | Datadog/Dynatrace | HolmesGPT/k8sgpt | LiteAI SRE 助手 |
|---|---|---|---|
| 数据面 | 平台内全量 telemetry | 外部 MCP 接入 | kubectl/curl 直连 + MCP 接入 |
| 交付形态 | SaaS Web GUI | CLI 单次排查 | 终端 agent（会话持久化） |
| 审计合规 | 平台内封闭 | 终端输出 | 可导出会话 JSONL，可 fork |
| 交互模式 | 对话+看板双视图 | 命令行问答 | 对话 + 假设树 + 时间线 |
| 跨班交接 | 平台内共享 | 无 | 会话 resume + fork |
| 场景依赖 | 需 APM/全链路插桩 | 不限 | 不限（kubectl/curl 兜底） |

---

## 二、竞品调研核心结论

### 2.1 商业 AIOps 根因分析工作流范式

**所有商业产品（Datadog/Dynatrace/New Relic/ServiceNow）共享一个根因分析工作流：**

```
异常检测/告警 → 上下文收集（runbook/历史/拓扑）→ 生成/排序候选根因假设
→ 多源 telemetry 验证假设（证据链）→ 判定（confirmed/refuted/inconclusive）
→ 给出影响范围与建议动作 → 人工确认或自动化修复 → 沉淀为反馈与记忆
```

**核心设计原则：**
1. **假设-验证外壳**：先出假设列表，逐条验证，每条标注状态。这是 agent 推理最可信任的设计模式。
2. **证据必须可追溯**：每一条结论必须附带原始数据引用，用户可点查。
3. **结论分级**：validated / invalidated / inconclusive，让用户知道该信什么、还缺什么。
4. **人工确认（HITL）**：建议动作默认需人工点确认，不擅自执行。

### 2.2 开源/学术 RCA 工具现状

| 工具 | 编排模式 | 信号 | 评测协议 | 可借鉴点 |
|---|---|---|---|---|
| k8sgpt | scanner/analyzer 规则型 | K8s 对象状态 | 无 | MCP 输出 |
| HolmesGPT | ReAct agent loop | 全量 telemetry | 无 | 30+ toolset，MCP 全面支持 |
| MicroRCA | 因果图 | 指标相关性 | 无 | 无埋点定位 |
| RCAgent | PwR planning + 自一致性 | 日志+指标 | 准确率 | 规划+轨迹自一致性 |
| AIOpsLab | Orchestrator 编排 | 多模态 | 检测/定位/分析/缓解四类任务 | 评测框架设计 |

### 2.3 RE2-SS 测试集分析

**来源**：RE2-SS 是 RCAEval 基准的变体，SS = Sock Shop（微服务 demo），RE2 推测为 RCAEval 缩写。

**核心规格**：
- 微服务：payment / carts / catalogue / orders / user（5 个 Sock Shop 服务）
- 故障类型：cpu / mem / disk / socket / delay / loss（6 种）
- 故障注入位置：每个服务 × 每个故障类型 = 30 个场景，各 3 次重复余下 90 个实例
- 多模态数据：聚合指标（simple_metrics.csv）、原始日志（logs.csv）、日志模板聚类（cluster_info.json）、Pod→Node 拓扑（pod-node-*.csv）
- 真值标注：inject_time.txt（故障注入时刻，用于时间窗对齐）

**评测协议（RCAEval 标准）**：
- 输入：故障实例的遥测数据（指标 + 日志 + 拓扑）
- 预期输出：**根因服务排序列表**（top-k candidates）
- 打分：**AC@k**（Accuracy at k，前 k 个候选含真实根因的比例）
- 统计稳定性：每类 3 次重复，多次运行求均值

### 2.4 终端 agent 设计调研

| 设计模式 | 代表 | 对 SRE 场景的价值 | 当前状态 |
|---|---|---|---|
| 只读模式（Plan/Act） | Claude Code Plan / Cline | 诊断天然只读，防误写扩大事故 | 已实现（P0-1 只读白名单） |
| 假设-验证链 | Bits AI Investigation Steps | 结构化推理，证据可追溯 | 设计文档已定义，待实现 |
| 会话 resume/fork | Claude Code --resume | 跨班交接刚需 | 已实现 |
| 事故检查点 | /rewind / checkpoint | 每阶段可回滚重放 | 待实现 |
| 事故事实层 compact | 通用 compact 改造 | 压缩时保活现象/时间线/假设 | 待实现 |
| 状态栏进度 | Claude Code status bar | 诊断阶段/已排除假设数 | 已完成（agent 状态栏） |

---

## 三、能力矩阵（现状 vs 目标）

### 3.1 已实现（P0 完成）

| 能力 | 交付物 | 验收 |
|---|---|---|
| SRE 只读命令白名单 | run-command.ts: kubectl/docker/curl 子命令级白名单 + 写操作识别 | 288/288 测试全绿 |
| 子 agent MCP 支持 | tool.ts: subsetForSubAgent + mcp.ts: annotations.readOnlyHint | 288/288 测试全绿 |
| System prompt 身份切换 | prompt.ts: 从编码助手→SRE 诊断助手 | 288/288 测试全绿 |
| 工具并发执行 | tool-parallel.ts: 只读命令并行 | 已有 |
| 权限审批 | permissions.ts: classifyDangerousCommand | 已有 |
| 会话持久化 | session.ts: resume/fork/rename | 已有 |
| 上下文压缩 | compact/ | 已有 |
| 子 agent 并行 | agents/manager.ts | 已有 |

### 3.2 待实现（P1 已完成 + P2 + 新发现）

按优先级排列（基于调研中新发现的差异化设计）：

```
P1（必须，验证可用性）✅ 已完成，355/355 测试通过，M1 达成
  ├── P1-1: 流式日志 tail                         [tail-logs.ts] ✅
  ├── P1-2: 复盘报告生成（postmortem）              [generate-postmortem.ts] ✅
  ├── P1-3: 假设-验证链呈现 *NEW*                   [hypothesis-tracker.ts] ✅
  ├── P1-4: 事故检查点 + 跨班交接简报 *NEW*          [incident-checkpoint.ts] ✅
  └── P1-5: 事故事实层 compact 保护 *NEW*           [compact/incident-facts.ts] ✅

P2（重要，提升体验）
  ├── P2-1: 评测框架（RE2-SS benchmark 接入）*NEW*  [eval/]
  ├── P2-2: 表格/日志渲染增强
  ├── P2-3: 事故知识库 RAG (sqlite-vec) ✅ [search-incident-kb.ts]
  ├── P2-4: 告警 webhook 接入
  └── P2-5: 只读模式（Plan Mode）会话态

P3（后续，锦上添花）
  └── 日志/指标可视化增强
```

**P1 实现偏差说明**（详见 P1_TASKS.md 末尾"实现偏差汇总"）：
- P1-1：task 要求 spawn 子进程 + background-tasks 复用；实际为一次性读 + 轮询会话（更简单，覆盖 SRE 实际场景）
- P1-2：task 要求 session.ts 加 getToolCallTimeline + 调 model；实际从 evidence 取时间线 + 模板化生成（确定性 + 可单测）
- P1-4：task 要求 session.ts 加 checkpoint_marker 消息；实际用独立 checkpoint-store.ts 落盘（跨 session 可读，不侵入 session 消息流）

---

## 四、P1 新增需求详细设计（已实现 ✅）

### 4.1 P1-3: 假设-验证链呈现（Hypothesis Tracker）✅ 已实现

**竞品对标**：Datadog Bits AI 的 Investigation Steps（实时推理日志）+ Hypothesis Tree（完成后树状总览），Dynatrace 的 Visual Resolution Path。

**问题**：当前 agent 排查只输出文本，根因假设、验证证据、结论全部混在对话流中。SRE 无法快速回顾"哪些假设已排除、哪些待验证、证据在哪"。

**设计**：

新增 `hypothesis_tracker` 工具，维护一个**假设-验证链**的结构化状态。

```
hypothesis_tracker 工具:
  输入:
    action: "add_hypothesis" | "add_evidence" | "update_status" | "get_summary"
    hypothesis_id?: string
    description?: string
    priority?: 1-5
    status?: "pending" | "investigating" | "confirmed" | "refuted" | "inconclusive"
    evidence?: { command, output_summary, data_source, timestamp }
  输出: 当前假设链的完整状态（结构化 JSON）
```

**数据结构**（内存中，贯穿整个会话）：

```typescript
type Hypothesis = {
  id: string
  description: string         // "payment 容器网络丢包导致 /orders 500"
  priority: number            // 1-5
  status: 'pending' | 'investigating' | 'confirmed' | 'refuted' | 'inconclusive'
  created_at: number
  evidence: Evidence[]
  conclusion?: string         // 最终结论
}

type Evidence = {
  command: string             // "kubectl logs payment-xxx"
  output_summary: string      // 输出摘要
  data_source: string         // "K8s logs" / "Prometheus" / "curl"
  timestamp: number
  supports: boolean           // true=支持假设, false=反驳
}
```

**系统 prompt 指令**（添加到 prompt.ts）：

```
使用 hypothesis_tracker 工具管理假设-验证链：
1. 产生候选根因假设时，调用 add_hypothesis 注册，按可能性排序（priority 1=最可能）
2. 每个诊断命令执行后，调用 add_evidence 附着证据，标注 supports=true/false
3. 根据证据确凿程度，调用 update_status 更新假设状态
4. 所有假设都 confirmed/refuted 后，调用 get_summary 输出结论树
5. 不要删除假设——refuted 的假设也是有价值的排查记录
```

**涉及文件**：

| 文件 | 改动 |
|---|---|
| 新增 `src/tools/hypothesis-tracker.ts` | 核心工具 + 内存状态管理 |
| 新增 `src/utils/hypothesis-store.ts` | 假设链的存储与查询 |
| [src/tools/index.ts](src/tools/index.ts) | 注册新工具 |
| [src/prompt.ts](src/prompt.ts) | 加入假设链使用指令 |
| [src/tool.ts](src/tool.ts) | 标记 `isParallelSafe: false`（写状态） |

**验收标准**：
- agent 可注册假设、附着证据、更新状态
- 多个假设可并行存在，各自独立维护证据链
- refuted 假设保留在列表中，不会消失
- 排查结束时 `get_summary` 输出完整结构化假设树
- 测试全绿

---

### 4.2 P1-4: 事故检查点 + 跨班交接简报（Incident Checkpoint）✅ 已实现（偏差：用 checkpoint-store.ts 落盘，非 session.ts）

**竞品对标**：Claude Code 的 /rewind / checkpoint / fork。Datadog 的 Investigation 序列化持久化。

**问题**：当前会话 resume 是恢复整个消息流，没有"事故阶段"的概念。SRE 跨班交接时，需要看一眼就知道"当前事故的现状：已查了什么、已排除什么、还剩什么"。

**设计**：

新增 `incident_checkpoint` 工具，在会话中创建命名检查点，并支持生成交接简报。

```
incident_checkpoint 工具:
  输入:
    action: "create" | "list" | "switch_to" | "generate_handover"
    checkpoint_name?: string
    incident_title?: string
    severity?: "SEV1" | "SEV2" | "SEV3"
  输出:
    checkpoint_id (创建时)
    检查点列表（list 时）
    交接简报 Markdown（generate_handover 时）
```

**交接简报模板**：

```
## 事故简报：{title}

### 严重级别
{severity}

### 现象
{事故原始描述}

### 时间线（关键事件）
| 时间 | 事件 |
|---|---|
| {timestamp} | {事件} |

### 已排除的假设
{hypothesis 中 status=refuted 的列表}

### 待验证的假设
{hypothesis 中 status=pending/investigating 的列表}

### 已执行的命令
{工具调用历史摘要}

### 推荐的下一步
{根 agent 的建议}
```

**检查点实现**（复用现有 session 机制）：
- `create`：在 session.messages 中插入一个 `checkpoint_marker` 消息，记录当前时刻的消息索引
- `list`：查询所有 `checkpoint_marker` 消息
- `switch_to`：截断消息到指定检查点位置（类似 /rewind）
- `generate_handover`：从检查点 + 假设链 + 工具调用历史生成简报

**涉及文件**：

| 文件 | 改动 |
|---|---|
| 新增 `src/tools/incident-checkpoint.ts` | 检查点工具 |
| [src/session.ts](src/session.ts) | 新增 `insertCheckpoint()` / `getCheckpoints()` / `truncateToCheckpoint()` |
| [src/tools/index.ts](src/tools/index.ts) | 注册新工具 |
| [src/prompt.ts](src/prompt.ts) | 加入检查点使用指令 |

**验收标准**：
- 可创建命名检查点、列出所有检查点
- 可切换到指定检查点（截断消息）
- 可生成结构化交接简报（含假设链状态）
- 测试全绿

---

### 4.3 P1-5: 事故事实层 compact 保护（Incident Fact Layer）✅ 已实现

**竞品对标**：Claude Code 的 CLAUDE.md 在 compact 后存活。不同的是，SRE 场景需要保活的是"事故事实"而非"代码规则"。

**问题**：当前 auto-compact 是按 token 用量触发的通用摘要，压缩后事故现象、时间线、假设状态、已排除证据等关键事实可能被丢弃。SRE 长排查（100+ 消息）下 compact 必然被触发，但通用摘要保不住排查轨迹。

**设计**：

在 compact 时，从 hypothesis_tracker + incident_checkpoint 提取结构化事实，保活到压缩后的系统 prompt 中。

**compact 保活事实**：

```typescript
type IncidentFactSnapshot = {
  incident_title: string
  severity: string
  start_time: number
  hypotheses: {
    active: number       // 待验证假设数
    confirmed: number    // 已确认根因数
    refuted: number      // 已排除数
    summary: string      // 紧凑摘要（每个假设一行）
  }
  key_commands: string[] // 已执行的关键诊断命令（最多 10 条）
  next_steps: string     // 推荐的下一步
}
```

**实现方式**：改造 compact 触发点，在压缩前调用 `hypothesis_tracker.get_summary()` + `incident_checkpoint` 生成快照，注入到压缩后的系统 prompt 末尾。

**涉及文件**：

| 文件 | 改动 |
|---|---|
| [src/compact/auto-compact.ts](src/compact/auto-compact.ts) | 压缩前注入事故快照 |
| [src/compact/index.ts](src/compact/index.ts) | 导出 `IncidentFactSnapshot` 类型 |
| 新增 `src/compact/incident-facts.ts` | 从 hypothesis_tracker + checkpoint 提取快照 |

**验收标准**：
- compact 后事故标题、假设状态、关键命令存活
- 假设状态量化（active/confirmed/refuted 计数）
- 不破坏现有 compact 行为
- 测试全绿

---

## 五、评测协议（RE2-SS Benchmark）

### 5.1 评测目标

基于 RE2-SS 测试集，量化评估 SRE 诊断助手在**根因定位准确率**和**诊断效率**上的表现。

### 5.2 评测指标

| 指标 | 定义 | 计算方式 |
|---|---|---|
| **AC@1** | 首次根因假设就命中的比例 | 根因假设列表中 priority=1 的假设是否匹配真实故障服务 |
| **AC@3** | 前 3 个假设包含根因的比例 | 前 3 个 priority 的假设是否含真实故障服务 |
| **Steps** | 定位根因所需的工具调用次数 | 从第一个工具调用到 confirmed 假设的步数 |
| **Evidence Rate** | 根因结论附带证据的比例 | 有 evidence 记录的 confirmed 假设 / 总 confirmed 假设 |
| **False Positive** | 错误排除真实根因的案例数 | 真实故障服务被标记为 refuted 的次数 |

### 5.3 评测流程

```
输入：RE2-SS 实例目录（如 dataset/RE2-SS/RE2-SS/payment_loss/1/）
输出：诊断报告（含根因服务、假设链、证据列表）

评估步骤：
1. agent 读取 simple_metrics.csv + logs.csv + cluster_info.json
2. agent 开始诊断（记录工具调用步数）
3. agent 提交根因假设（标记为 confirmed）
4. 对比真实故障（目录名 {service}_{fault}）
5. 计算 AC@1 / AC@3 / Steps / Evidence Rate / False Positive
6. 每类 3 次重复取均值
```

### 5.4 评测工具（P2-1）

新增 `eval/` 目录，包含：

```
eval/
├── runner.ts          # 评测运行器：遍历 RE2-SS 实例，调用 agent 诊断
├── scorer.ts          # 评分器：对比输出与真值，计算指标
├── report.ts          # 报告生成器：输出评测结果 CSV/JSON
├── fixtures/          # 测试用例定义
│   └── re2ss.ts       # RE2-SS 实例路径映射 + 真值表
└── README.md
```

### 5.5 评测触发方式

```
npm run eval:re2ss          # 跑全量 RE2-SS 评测
npm run eval:re2ss -- --filter=payment_loss  # 只跑指定故障类型
```

---

## 六、实施路线图（更新版）

```
P0 ✅（已完成，290 测试全绿）
  ├── P0-1: run_command SRE 只读白名单
  ├── P0-2: 子 agent 支持 MCP 工具（annotations.readOnlyHint）
  └── system prompt 改造

P1 ✅ 已完成（355/355 测试通过，M1 达成）
  ├── P1-1: 流式日志 tail                     [tail-logs.ts] ✅
  ├── P1-2: 复盘报告生成                      [generate-postmortem.ts] ✅
  ├── P1-3: 假设-验证链呈现 *NEW*              [hypothesis-tracker.ts] ✅
  ├── P1-4: 事故检查点 + 交接简报 *NEW*         [incident-checkpoint.ts] ✅
  └── P1-5: 事故事实层 compact 保护 *NEW*      [compact/incident-facts.ts] ✅

P2（后续，约 2-3 个工作日）
  ├── P2-1: RE2-SS 评测框架                    [eval/]
  ├── P2-2: 表格/日志渲染增强
  └── P2-3: 事故知识库 RAG (sqlite-vec) ✅ [search-incident-kb.ts]

P3（后续，锦上添花）
  ├── 日志/指标可视化增强
  ├── 告警 webhook 接入
  └── 只读模式（Plan Mode）会话态
```

---

## 七、M3 场景验证（端到端演示）

**场景**：Pod CrashLoopBackOff 事故，端到端跑通诊断→处置→复盘。

**流程**：
1. 用户描述："payment 服务全部 500，帮我排查"
2. agent 自动调用 `kubectl get pods -n sock-shop` 发现 payment CrashLoopBackOff
3. agent 注册假设（hypothesis_tracker: "payment 容器崩溃"）
4. agent 调 `kubectl logs payment-xxx --previous` 获取崩溃前日志
5. agent 附着证据（hypothesis_tracker: add_evidence）
6. agent 发现 OOMKilled，更新假设为 confirmed
7. agent 建议：`kubectl describe pod` 查看资源限制，建议增加 memory limit
8. 用户确认后，agent 调 `kubectl patch deployment payment -p '{"spec":{"template":{"spec":{"containers":[{"name":"payment","resources":{"limits":{"memory":"512Mi"}}}]}}}}'`（需要审批）
9. 事故结束后，用户调 `generate_postmortem` 生成复盘报告
10. 报告包含假设链、时间线、证据引用、处置记录

---

## 八、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 假设链状态在 compact 后丢失 | 排查轨迹不完整 | P1-5 事故事实层保护 |
| 检查点过多导致上下文膨胀 | 性能下降 | 限制最大检查点 5 个，超限自动合并旧点 |
| LLM 跳过 hypothesis_tracker 直接输出 | 结构化假设链缺失 | system prompt 强制 + 降级为纯文本记录 |
| RE2-SS 评测环境差异 | 评测结果不可比 | 固定 seed、固定模型版本、固定重试次数 |
| MCP annotations 不普及 | 子 agent 工具受限 | 多数据源优先用 kubectl/curl 直连，MCP 作为增强 |

---

## 九、验收里程碑

| 里程碑 | 条件 | 状态 |
|---|---|---|
| **M1 P1 代码完成** | P1-1~P1-5 全部实现 + 测试全绿 | ✅ 达成（355/355 通过） |
| **M2 评测框架就绪** | P2-1 可运行 RE2-SS 全量评测，输出 AC@1/AC@3 指标 | ⬜ 待开始 |
| **M3 场景验证** | Pod CrashLoopBackOff 端到端跑通，含假设链+检查点+复盘报告 | ✅ 达成（payment_mem/1 全链路跑通：诊断→假设链→检查点→交接简报→postmortem 落盘，135s/40 步；payment_loss/1 + carts_mem/1 之前已跑通；orders_delay 跳过） |
| **M4 基线评测** | 在 RE2-SS 全量 90 实例上跑出 AC@1/AC@3 基线分数 | ⬜ 待开始 |

---

## 十、附录：竞品调研摘要

### 10.1 商业 AIOps 根因分析工作流

所有商业产品（Datadog Bits AI、Dynatrace Davis、New Relic AI、ServiceNow AIOps）共享的根因分析工作流：

```
异常检测/告警 → 上下文收集 → 候选根因假设生成
→ 多源 telemetry 验证 → 判定（confirmed/refuted/inconclusive）
→ 影响范围 → 人工确认 → 自动化修复/沉淀记忆
```

### 10.2 终端 agent 设计模式总结

| 类别 | 优秀设计 | 本项目中 |
|---|---|---|
| 确认/审批 | 6 级权限 + 热切换 | ✅ 权限审批 + SRE 只读白名单 |
| 只读模式 | Plan/Act 分离 | ⚠️ 设计需增强 |
| 假设-验证 | 假设树 + 证据链 + 状态分级 | ✅ P1-3 已实现 |
| 会话恢复 | resume/checkpoint/fork | ✅ 已实现 |
| 上下文管理 | 事故事实 compact 保活 | ✅ P1-5 已实现 |
| 进度语义 | 诊断阶段/置信度 | ⚠️ 需适配 |
| 交接 | 自动生成事故简报 | ✅ P1-4 已实现 |

### 10.3 RE2-SS 评测协议

| 维度 | 规格 |
|---|---|
| 微服务 | payment / carts / catalogue / orders / user |
| 故障类型 | cpu / mem / disk / socket / delay / loss |
| 实例数 | 30 场景 × 3 重复 = 90 实例 |
| 多模态数据 | 聚合指标 + 原始日志 + 日志模板 + Pod 拓扑 |
| 真值标注 | inject_time.txt（故障注入时刻） |
| 评测指标 | AC@1 / AC@3 / Steps / Evidence Rate / False Positive |
| 评测协议 | 输入 telemetry → 输出根因排序 → 按 AC@k 打分 |