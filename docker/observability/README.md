# docker/observability —— Langfuse 自托管栈

给 lite-ai 的 **B 轨**（OTel span → OTLP → Langfuse）做本地真实联调用。

```bash
cd docker/observability
cp .env.example .env          # 改掉三个 CHANGEME（NEXTAUTH_SECRET / SALT / USER_PASSWORD）
docker compose up -d
docker compose ps             # 5 个服务都 healthy 后再往下走
```

然后把 `.env` 里的 `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `..._SECRET_KEY`
抄进 lite-ai 的运行环境，再起 serve：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-... \
LANGFUSE_SECRET_KEY=sk-lf-... \
LANGFUSE_BASE_URL=http://localhost:3000 \
npx tsx src/index.ts --serve
```

启动日志里出现 `[tracing] Langfuse 已启用（baseUrl=...）` 只说明**凭据被解析出来了**，
不代表 span 真的上去了。要证明接得通，跑一次自检（它自己起 sink、打一组 span、
再用 Langfuse 公开 API 捞回来核对字段，不碰数据库）：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... \
LANGFUSE_BASE_URL=http://localhost:3000 \
npm run check:tracing        # 8 项断言；失败时会告诉你去翻哪几条日志
```

没接上时启动日志会打印 noop 的**原因**，`GET /info` 的
`capabilities.tracingReason` 是同一个值 —— 不必翻日志。

## 为什么要这份文件，而不是照抄上游

上游 `langfuse/langfuse` 仓库根的 compose 在**国内网络跑不起来**，两处硬伤：

| 上游写法 | 问题 | 本文件 |
|---|---|---|
| `docker.langfuse.com/langfuse/langfuse:4` | 该域名是**纯 307 重定向**到 `registry-1.docker.io`；Docker Desktop 的 `registry-mirrors` 只作用于 `docker.io`，于是直连 `Client.Timeout` | 改回 Docker Hub 的 `langfuse/langfuse:4`（走加速器） |
| `cgr.dev/chainguard/minio` | Chainguard 私有 registry，国内可达性不稳定 | 换上游 `minio/minio`（`mc ready local` 健康检查同样可用） |

另去掉 in-app agent / AI evaluator 那一整块环境变量（本联调只用 OTLP 摄入）。

## 三个容易踩的点

1. **凭据在 `.env` 里就是确定的**：`LANGFUSE_INIT_*` 会在首次启动建好
   org / project / user，并把那对 key 直接设成项目 API key。所以不必点 UI 拿 key，
   联调可以脚本化。`.env` 已被根 `.gitignore` 覆盖，不会入库。
2. **`5432` 是通用端口**：本机若已有 Postgres 占用，改 compose 里 postgres 的
   映射或删掉该行。lite-ai 自己的 `DATABASE_URL` 也可以直接借用这个实例
   （另建一个 database 即可，别往 Langfuse 的库写表）。
3. **别拿 Langfuse 当实时数据源**：它走异步 OTLP 导出，可见性有**分钟级**延迟
   （其 OpenAPI 原话：其他公开 API 端点延迟约 10 分钟）。值班台的实时流永远是
   `job_events` / SSE；跨轨对账走 `GET /trace/:jobId`（见 `src/server/http.ts`
   的 `handleGetTrace`）。

## 起不来 / 起来了但没数据 —— 按这张表查

| 现象 | 真因 | 处置 |
|---|---|---|
| `docker.langfuse.com` 拉取超时 | 该域名是**纯 307 重定向**到 `registry-1.docker.io`；Docker Desktop 的 `registry-mirrors` 只作用于 `docker.io`，不会接管它 | 用 Docker Hub 的 `langfuse/langfuse:4`（本文件已改） |
| 启动日志写着"Langfuse 已启用"，但 Langfuse 里**一条都没有** | 摄入端 500：事件 JSON 要先落 S3/MinIO 才进队列，**S3 凭据不对就整条链路断**。典型报错 `The Access Key Id you provided does not exist in our records.` | 见下一条；用 `npm run check:tracing` 复现 |
| S3/MinIO 凭据两边不一致 | Compose 的取值优先级是 **shell 环境变量 > `.env`**。官方 compose 把 Langfuse 侧的 key 硬编码成 `minio`，而 minio 服务读 `${MINIO_ROOT_USER:-minio}` —— 本机 shell 里一旦有同名变量（实测 `MINIO_ROOT_USER=root`），两边就会**静默错开** | 本文件已改为**同源派生**（Langfuse 侧也读 `${MINIO_ROOT_USER}`）。若你从官方 compose 抄，记得一并改 |
| `GET /api/public/traces` 报 `events_only mode` | Langfuse **v4** 下线了 legacy 的 traces/observations 读取端点 | 改用 `GET /api/public/v2/observations`（记得 `fields=core,basic,model,usage`，默认只回 `core,basic`）；或直接查 ClickHouse 的 `default.events_core` |

排查顺序：`npm run check:tracing` 会自己把上面这些串起来跑一遍，并打印该看哪些日志。
