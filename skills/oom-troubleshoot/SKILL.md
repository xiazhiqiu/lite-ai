# oom-troubleshoot

k8s OOM/反复重启故障域排查 SOP：适用于 OOMKilled、内存 limit 触发、Pod CrashLoopBackOff、容器反复重启、HighMemoryUsage 等告警。

## 适用告警特征

- 告警标题/标签含 OOM、OOMKilled、memory limit、CrashLoopBackOff、restart、OutOfMemory
- 现象：Pod 反复重启、容器启动后很快被杀、内存使用率接近/超过 limit

## 取证顺序

1. **检索历史**：先 search_incident_kb 用「服务名 + OOM/内存」查相似事故，命中则参考其根因与处置。
2. **看 Pod 状态与重启次数**：`kubectl get pods -n <ns> -o wide`，定位处于 CrashLoopBackOff / Running 但重启多次的 Pod。
3. **看容器最后状态**：`kubectl describe pod <pod> -n <ns>`，检查 lastState.terminated.reason 是否为 OOMKilled、restartCount 趋势、以及容器的 requests/limits 配置。
4. **看内存指标**：查询容器内存工作集 vs limit（如 Prometheus `container_memory_working_set_bytes` 与 limits），确认是"缓慢逼近上限"还是"瞬时突刺"。
5. **看 OOM 前日志**：用 tail_logs 或 `kubectl logs <pod> -n <ns> --previous` 拿崩溃前的最后输出，判断是正常业务日志还是异常堆栈。
6. **核对部署配置**：`kubectl get deploy <name> -n <ns> -o yaml` 检查 resources.limits.memory 是否过小、是否存在单副本无副本数兜底。

## 典型根因模式与判断依据

- **limit 配置过小**：内存指标长期贴着 limit 缓慢上涨后 OOM，调整 limit/request 后稳定。判断依据：历史内存曲线平稳但接近上限。
- **内存泄漏**：内存持续单调增长直至 OOM，重启后再次缓慢攀升。判断依据：多次 OOM 间隔稳定、内存曲线只升不降。需进一步看堆/线程/连接数是否泄漏。
- **突发流量/大请求**：OOM 前 QPS/并发瞬时上升，内存出现突刺。判断依据：OOM 时间点与流量尖峰重合。
- **依赖缓存/响应体过大**：上游返回超大响应体、缓存无界增长。判断依据：内存与特定依赖调用量强相关。

## 易踩坑点

- 不要只看当前 `get pods`，重启过的 Pod 必须看 `--previous` 或 describe 的 lastState 才能拿到 OOM 现场。
- OOMKilled 不一定代表容器内进程异常——limit 设太小也会触发，先核对 limit 与实际占用再下结论。
- 反复重启但非 OOMKilled（如探针失败、启动崩溃）不属于本技能范围，按启动失败方向排查。
- mock/离线环境指标可能缺失：若 Prometheus 查不到内存曲线，用 describe 的 restartCount + 日志时间线推断。
