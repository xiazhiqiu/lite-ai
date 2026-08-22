# ITBench-AA 数据集介绍与使用教程

> 本文档基于对 HuggingFace 数据集 `ArtificialAnalysis/ITBench-AA` 的实际调研整理。内容以调研时点（2026-08）仓库/数据集实际内容为准，未经验证的判断会明确标注。

---

## 1. 这是什么

`ITBench-AA` 是 **Artificial Analysis** 对 **IBM ITBench** 的 SRE（站点可靠性工程）评测子集的重发布，用于 Artificial Analysis 的 ITBench-AA 排行榜。许可：`cc-by-4.0`。

核心定位：**离线根因定位（root-cause localization）评测**。给 agent 一份"故障已发生"的离线快照（指标/告警/日志/链路/k8s 对象），让它在不接触真实集群的前提下，从快照中定位故障**根因实体**。

> 官方用词：agent "given access to an offline snapshot" —— agent 读取的是**导出为普通文件的快照**，而非连接真实的 Prometheus / Elasticsearch / Jaeger 服务。

---

## 2. 数据规模与结构

- 总规模约 **6.3GB**，数千个文件
- `sre` config 只含 `source_split: public` 的 **40 个公开场景**（官方共 59 个，其余 19 个为私有 held-out，未公开）

顶层结构：

```
ArtificialAnalysis/ITBench-AA/
├── sre/
│   ├── data.jsonl                  # 185KB, 40 行（场景元数据 + 真值）
│   └── Scenario-<N>/               # 40 个场景目录，每个含离线快照文件
```

---

## 3. `sre/data.jsonl` 字段

每行一个场景，共 **6 个字段**：

| 字段 | 说明 | 示例 |
|---|---|---|
| `id_aa` | 全局唯一 id | `it-bench-sre-public-scenario-1` |
| `scenario_id` | 场景标识 | `Scenario-1` |
| `category` | 场景类别 | `sre` |
| `source_split` | 数据划分 | `public` |
| `scenario_root` | 官方运行时的根路径 | `/home/user` |
| `ground_truth_yaml` | **内嵌的完整 YAML 字符串**（真值定义） | 见下 |

---

## 4. `ground_truth_yaml` 详解

40 个场景中：**31 个**为扁平格式（顶层直接是 `fault/alerts/groups/...`），**9 个**为带 `apiVersion: itbench.io/v1, kind: GroundTruth, spec:` 的封装格式（内容结构相同）。

各字段出现频率：`groups`(40) > `fault`(31) = `alerts`(31) = `recommended_actions`(31) > `propagations`(30) > `aliases`(24)。

> ⚠️ **注意：没有独立的 `entities` 字段**。真值实体组织在 `groups` 里。

| 字段 | 含义 | 关键子字段 |
|---|---|---|
| **`groups`** | 实体组列表（**真值实体在这里**，其中恰一个标 `root_cause: true`） | `{ id, kind(Deployment/Pod/Service/ConfigMap), namespace, filter:[<正则>], root_cause? }` |
| **`fault`** | 被注入的故障 | `entity{name, group_id, kind}`, `condition`, `category`(Change/Infrastructure 等), `fault_mechanism`(如 custom、command_injection) |
| **`alerts`** | 该场景相关告警 | `{ id(RequestErrorRate/RequestLatency/PodCrashLoopBackOff...), group_id, metadata.description }` |
| **`aliases`** | 别名：把不同 kind 的实体聚到同一 "contributing-factor" 语义（服务↔pod 视为同一实体），用于匹配容错 | —— |
| **`propagations`** | 故障传播有向图，描述根因如何传导到症状 | `{ source, target, condition, effect }` |
| **`recommended_actions`** | 推荐修复方案 | `solution: { id, actions: [...] }` |

示例（Scene-105 的根因实体描法：`product-catalog-deployment`，filter `product-catalog-.*`，`root_cause: true`）。

**评分真值 = 标了 `root_cause: true` 的实体组**，经 `aliases` 聚合 + `filter` 正则解析到具体实体。

---

## 5. 快照数据源格式（每个 `Scenario-<N>/` 目录）

定义快照文件的字段、格式和文件类型。

| 文件 | 内容 | 对应传统数据源 | 格式 |
|---|---|---|---|
| `alerts/alerts_at_*.json` | 周期性告警快照 | Prometheus Alertmanager | JSON（`/api/v1/alerts` 响应）|
| `alerts/alerts_in_alerting_state_*.json` | **触发态**告警快照 | Prometheus Alertmanager | 同上 |
| `metrics/service_<name>_raw.tsv` | service 级指标（**已解析**） | Prometheus | TSV |
| `metrics/pod_<name>_raw.tsv` | pod 级指标 | Prometheus | TSV |
| `otel_logs_raw.tsv` | 应用日志（Envoy/业务） | Elasticsearch（本为 OTLP）| TSV |
| `otel_traces_raw.tsv` | 链路 span | Jaeger（本为 OTLP）| TSV |
| `k8s_events_raw.tsv` | k8s Event | Kubernetes | TSV |
| `k8s_objects_raw.tsv` | 全部 k8s 对象（Deployment/Pod/ConfigMap 等）| Kubernetes 拓扑 | TSV |
| `status.json` / `assertion.json` | 录制侧元数据（仅部分场景，如 Scene-12） | 非评测输入 | JSON |

### 5.1 `alerts/*.json`

即 Alertmanager 的 `/api/v1/alerts` JSON：

```json
{
  "status": "success",
  "data": {
    "alerts": [{
      "activeAt": "...",
      "labels": { "alertname": "RequestErrorRate", "...": "..." },
      "annotations": { "...": "..." },
      "state": "firing",
      "value": "..."
    }]
  }
}
```

`labels.alertname` 与 `ground_truth_yaml` 里 `alerts[].id` 对应。

### 5.2 `metrics/*.tsv`

**注意：Prometheus 数据已被解析/去规范化为 TSV**（不是 remote_write 二进制样本，也不是可查的 PromQL 时序存储）。每行一个时间序列样本。

service 级表头：

```
metric_name, timestamp, value, service_name, namespace, bucket_le, tags, metric_type, status_code
```

pod 级表头：

```
metric_name, timestamp, value, pod_name, namespace, tags
```

- `tags` 列为该样本的完整 Prometheus label 集合（Python dict repr），含 `prometheus=.../prometheus-kube-prometheus-prometheus`、`job`、`instance`、`le` 等
- 每 Service / 每 Pod 一个文件

### 5.3 `otel_*_raw.tsv` / `k8s_*_raw.tsv`

统一是 **OpenTelemetry Collector "file exporter" 的输出**（Tab 分隔，每行一条 telemetry record）。

logs / events / objects 表头：

```
Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes[, EventName]
```

traces 用专门的 traces 表头（含 ParentSpanId / SpanName / SpanKind / SpanAttributes / Duration / StatusCode 等）。

- **logs**：`Body` = Envoy/应用日志行；`ResourceAttributes` 例 `{'k8s.pod.name': ..., 'k8s.namespace.name': 'otel-demo'}`；`LogAttributes` 例 `{'url.path': '/api/recommendations?...', 'event.name': 'proxy.access'}` — **不是 ES 文档**，是 OTLP 导出。
- **traces**：一行一个 span。
- **events / objects**：`Body` 是完整 k8s 对象 JSON 序列化串（Event 或 Deployment/Pod/ConfigMap 等），`LogAttributes` 标 `k8s.resource.name`。**拓扑不是图，而是所有对象的扁平 TSV dump**。

---

## 6. 涉及的"数据源"组件

- **Prometheus**：指标（tsv）+ Alertmanager 告警（json）
- **OpenTelemetry**：logs / traces（WebStoreDemo/otel-demo 应用遥测）
- **Kubernetes API**：objects / events 拓扑 dump
- **内置监控**：kubelet / cAdvisor、Prometheus Operator pod

> 无独立的 Jaeger 文件 —— Jaeger 数据统一落在 OTLP traces TSV。应用栈为 `opentelemetry-demo`。

---

## 7. 评分方式（官方方法）

主指标：**avg-precision-at-full-recall（全召回精度均值）**

- 每轮运行：若 agent **漏掉任一** ground-truth 根因（有 false negative）→ 该轮得 **0**
- 若根因全中 → 得分 = `precision = TP / (TP + FP)`
- 即"**漏一个即失败，多报降精度**"，同时惩罚 FN 与 FP

### agent 输出要求

- 不是自然语言事后报告，而是**结构化 JSON 根因实体列表**（最小独立根因集合）
- 参考 IBM `ITBench-Evaluations` 的 SRE 模板输出键：
  - `ROOT_CAUSE_ENTITY`
  - `ROOT_CAUSE_REASONING`
  - `PROPAGATION_CHAIN`
  - `FAULT_LOCALIZATION` ...

- 真值 = ground_truth 里 `groups` 中标 `root_cause: true` 的实体组（经 `aliases` 聚合、正则 `filter` 解析到具体实体）
- 在 Stirrup 沙箱内评测（100 轮/task 上限，每 task 跑 3 次）
- 衡量的是"能否在离线快照中定位真因实体"，**不测**实时 on-call / 回滚权限 / 实时修复

---

## 8. 下载与使用

### 8.1 从 HuggingFace 获取

```bash
# 需要安装 git-lfs
git lfs install

# 直接 clone hustle（数据集较大，约 6.3GB，建议只拉 sre 或所需场景）
git clone https://huggingface.co/datasets/ArtificialAnalysis/ITBench-AA

# 若出口网络对 huggingface.co 直连被 SSL 重置，可走镜像（如 hf-mirror.com）
export HF_ENDPOINT=https://hf-mirror.com
git clone https://hf-mirror.com/datasets/ArtificialAnalysis/ITBench-AA
```

> 调研时沙箱直连 huggingface.co 曾出现 `gnutls_handshake failed`，改用 `hf-mirror.com` 镜像逐文件下载可用。网络受限时可走镜像或按需下载 `sre/data.jsonl` + 目标 `Scenario-<N>/`。

### 8.2 使用路径（两种）

**方式 A：按官方语义读快照文件（推荐，轻量）**
- 挂载 `Scenario-<N>/` 目录作为**只读本地快照**，agent 通过只读文件工具查询（grep TSV、解析 alerts JSON、列 k8s objects）
- 无需真实集群 / Prometheus / ES，CPU/内存压力小

**方式 B：把快照灌进现有数据源**
- 写 loader 把 `metrics/*.tsv` 灌入自建 Prometheus、`otel_logs_raw.tsv` 灌入 ES
- 复用现有 HTTP toolset（`prometheus_*` / `elasticsearch_*`），但要处理 TSV→时序/文档的格式换算，多一步灌数逻辑

> 方式 A 更贴近 ITBench-AA 官方形态，也绕开本机 CPU/内存瓶颈（参考：官方活集群方案要求 ≥8 CPU / 16GB）。

---

## 9. 与 LiteAI 项目的对接映射

| ITBench-AA 概念 | LiteAI 对应 |
|---|---|
| 真值 `groups[].root_cause:true` 实体 | `scorer.ts` 的 precision@full-recall 真值实体 |
| 场景快照目录 | `runner.ts` 需挂载的只读数据源 |
| `alerts` ↔ Alertmanager JSON | 可建只读文件工具 / 或灌入 ES |
| `metrics` TSV | 只读文件查询（无需 PromQL）|
| `otel_traces_raw.tsv` | 只读文件查询（无需 Jaeger）|
| `k8s_objects_raw.tsv` 拓扑 | 只读文件查询（无需 k8s API）|

> 结论：ITBench-AA 快照为**文件形态**，当前内置 4 个 HTTP toolset（prometheus/elasticsearch/kubernetes/database）无法直接查询快照文件。若采用方式 A，需为评测场景新增一个**只读本地快照 toolset**（`file://` 只读 + 结构化查询），agent 用其检索快照、再由 `scorer.ts` 判分——无需改动现有 precision@full-recall 逻辑。

---

## 10. 常见问题

- **数据有单独的 `entities` 字段吗？** 无。真值在 `groups` 中通过 `root_cause: true` 标记。
- **能连真实 Prometheus 查吗？** 不能。指标已拍成 TSV，不是 PromQL 可查存储。
- **Jaeger 数据在哪？** 无独立 Jaeger 文件，traces 全在 `otel_traces_raw.tsv`。
- **评测测什么？** 离线根因定位 → 输出结构化根因实体集，比对其真值；不测实时修复/on-call。
- **为什么只有 40 个场景？** `sre` config 只含 `source_split: public`；官方另有 19 个私有 held-out 场景未公开。