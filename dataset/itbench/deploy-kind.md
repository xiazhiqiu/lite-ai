# 方案 A：本地 Kind 集群部署（ITBench 评测）

> 本文档是 LiteAI ITBench 评测（方案 A）的完整落地步骤。核心改动 vs 早期草稿：
> - **链路用 Grafana Tempo 而非 Jaeger**——现有 `tempo` toolset（TraceQL）直接可用，无需新写 Jaeger 适配。
> - **新增 `loki` toolset**（已实现）承接日志查询，`settings.json` 用 `type: loki`。

涉及 5 个真实数据源，全部以容器跑在 kind 集群里：

| 数据源 | 集群内组件 | LiteAI toolset | 说明 |
|---|---|---|---|
| Metrics + Alerts | Prometheus + Alertmanager | `prometheus` | 指标查询、告警规则 |
| Traces | **Grafana Tempo** | `tempo` | TraceQL 搜索 / 明细 / 指标 |
| Logs | **Loki** | `loki` | LogQL 日志查询 |
| K8s 对象 + Events | Kubernetes API Server | `kubernetes` | Pod / Deployment / Service / Events |
| 被测应用 | OpenTelemetry Demo | — | 产生真实流量与故障的靶子应用 |

---

## Step 1：创建 kind 集群（带端口映射）

kind 需 `NODE_PORT` 段（配置 nodePort 时），用 kind 的 `NodePort` 服务即可从宿主访问。下面用 NodePort 暴露 5 个服务端口：

```bash
cat <<EOF | kind create cluster --name itbench --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
EOF
```

> 说明：Tempo/Loki/Prometheus 用 NodePort（kind 自带）暴露到宿主机，无需 `extraPortMappings` 直接开容器端口。端口固定为 `309xx` 段避免冲突。

---

## Step 2：添加 Helm 仓库

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
```

---

## Step 3：Prometheus + Alertmanager + Grafana

```bash
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set prometheus.service.type=NodePort \
  --set prometheus.service.nodePort=30909 \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=30930 \
  --set alertmanager.service.type=NodePort \
  --set alertmanager.service.nodePort=30903
```

> ⚠️ 版本注意：新一代 kube-prometheus-stack 的 `prometheus.service.nodePort` 值路径可能因 chart 版本变化，装完用
> `kubectl -n monitoring get svc` 核实实际 NodePort，必要时手动 `kubectl -n monitoring edit svc prometheus-kube-prometheus-prometheus` 改 `spec.ports[].nodePort`。

---

## Step 4：Grafana Tempo（链路，TraceQL）

部署单二进制 Tempo（all-in-one），暴露 HTTP `:3200`：

```bash
kubectl -n monitoring create deploy tempo --image=grafana/tempo:latest --port=3200
kubectl -n monitoring apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: tempo
  namespace: monitoring
spec:
  type: NodePort
  selector:
    app: tempo
  ports:
    - name: http
      port: 3200
      targetPort: 3200
      nodePort: 30932
EOF
```

> Grafana Tempo 的 HTTP 查询 API 默认监听 `:3200`，提供 TraceQL `/api/search`、`/api/v2/traces/{id}` 等端点——正是现有 `tempo` toolset 所对接的。Tempo 也可用 helm（`grafana/tempo`）或 `grafana/tempo` 社区 chart 部署；单二进制 deployment + NodePort 服务最简单。

---

## Step 5：Loki（日志，LogQL，单二进制单节点）

```bash
helm install loki grafana/loki \
  --namespace monitoring \
  --set loki.auth_enabled=false \
  --set singleBinary.replicas=1 \
  --set singleBinary.persistence.enabled=true \
  --set singleBinary.persistence.size=10Gi \
  --set service.type=NodePort \
  --set service.nodePort=31000
```

> ⚠️ 版本注意：`singleBinary.*` 参数仅在 Loki helm chart（2.x）有效。若用 3.x chart 用默认分布式配置，或改用 `--set gateway...`。装完核实 `kubectl -n monitoring get svc loki` 的 NodePort。

---

## Step 6：被测应用（OpenTelemetry Demo）

```bash
helm install otel-demo open-telemetry/opentelemetry-demo \
  --namespace demo --create-namespace
```

otel-demo 默认会把 traces/metrics 导出到自带的 collector；要让数据进入上面的 Tempo/Loki，需在部署时配置 OTLP endpoint 指向集群内的 `tempo`/`loki` 服务（或接入后 unset collector）。简化起见可用 kube-prometheus 默认抓取 demo 的 `/metrics`。

---

## Step 7：配置 LiteAI 连接本地数据源

编辑 `~/.lite-ai/settings.json`：

```json
{
  "toolsets": {
    "prometheus": {
      "type": "prometheus",
      "config": { "prometheus_url": "http://localhost:30909" }
    },
    "kubernetes": {
      "type": "kubernetes",
      "config": { "kubeconfig_path": "~/.kube/config" }
    },
    "tempo": {
      "type": "tempo",
      "config": { "api_url": "http://localhost:30932" }
    },
    "loki": {
      "type": "loki",
      "config": { "api_url": "http://localhost:31000" }
    }
  }
}
```

> ⚠️ 关键：Loki 必须 `type: loki`（走 LogQL），Tempo 必须 `type: tempo`（走 TraceQL）。二者 API 不兼容，不能互替换。

---

## Step 8：故障注入并评估

**手动注入单个故障**（验证链路）：

```bash
# 例：调低 paymentservice 的 CPU limit 制造"变慢"
kubectl patch deployment paymentservice -n demo --type='json' \
  -p='[{"op": "replace","path":"/spec/template/spec/containers/0/resources/limits/cpu","value":"50m"}]'
```

**自动化（推荐）**：在 `dataset/itbench/manifest.jsonl` 为场景声明 `faultInjection`，runner 用 `--live` 自动编排：

```jsonl
{ "id": "sre_task_003", "name": "paymentservice 变慢", "description": "告警：payment 请求延迟升高，请定位根因",
  "namespace": "demo", "keyMetrics": ["http_server_duration_seconds"],
  "groundTruth": { "entities": ["paymentservice"] },
  "faultInjection": {
    "setup": ["kubectl patch deployment paymentservice -n demo --type=json -p='[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/resources/limits/cpu\",\"value\":\"50m\"}]'"],
    "setupWaitSeconds": 15,
    "teardown": ["kubectl patch deployment paymentservice -n demo --type=json -p='[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/resources/limits/cpu\",\"value\":\"2\"}]'"],
    "teardownWaitSeconds": 10
  } }
```

```bash
npm run eval:itbench -- --live --filter=payment
```

Agent 会真实调用：
- `prometheus_*`：查 payment 服务的 CPU / 延迟指标趋势
- `kubernetes_*`：看 Pod 状态、资源、事件
- `tempo_*`：查 payment 的慢 trace
- `loki_query_logs`：读 payment 应用日志报错

---

## 一句话总结

在本地 kind 集群跑 Prometheus + Tempo + Loki + K8s + OpenTelemetry Demo，5 个真实数据源通过标准 API 暴露给 LiteAI；agent 调真工具、查真数据，`--live` 模式自动注入/恢复故障串行跑全量场景。零云成本，全部在本地容器里。

## 相关

- 数据集格式详解：[ITBench-AA-guide.md](ITBench-AA-guide.md)