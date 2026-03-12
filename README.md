# AI 简历名片应用

## 目录结构

- `frontend/`：Vue 3 + Vite 前端
- `backend/`：Deno 后端（API + 生产静态托管）
- `data/`：简历数据源（`resume.json`）

## 运行模式

- 开发模式（前后端分离）
  - 前端：`http://localhost:5173`
  - 后端 API：`http://localhost:8000`
- 生产模式
  - 后端直接托管 `frontend/dist`
  - 同时提供 `/api/*`

## 环境变量

后端会自动加载 `.env` / `.env.local`，示例见 `.env.example`。

常用变量：
- `MOONSHOT_API_KEY`
- `MOONSHOT_BASE_URL`
- `MOONSHOT_MODEL`
- `ZHIPU_API_KEY`
- `ZHIPU_BASE_URL`
- `ZHIPU_MODEL`
- `CHAT_PROVIDER`
- `API_HOST`
- `API_PORT`
- `ALLOWED_ORIGIN`
- `CHAT_STREAM_FIRST_TOKEN_MAX_LATENCY_MS`
- `CHAT_STREAM_MIN_TOKEN_EVENTS`

## 常用命令（Deno）

开发（前后端一起启动）：

```powershell
deno task dev
```

仅启动后端 API：

```powershell
deno task dev:api
```

构建前端：

```powershell
deno task build
```

生产启动（托管 `frontend/dist` + API）：

```powershell
deno task start
```

Docker 本地构建：

```powershell
docker build -t resume-app:local .
```

Docker 本地运行：

```powershell
docker run --rm -p 8000:8000 -e API_PORT=8000 resume-app:local
```

本地防护仿真：

```powershell
deno task simulate:guard
```

## API

- `GET /api/profile`
- `POST /api/chat`
- `POST /api/chat/stream`（SSE 流式）

## Provider 路由

后端支持两个 OpenAI 兼容提供方：
- `kimi`（默认）
- `zhipu`（默认模型 `GLM-4.7-Flash`）

选择优先级：
1. 请求体里的 `provider`
2. 环境变量 `CHAT_PROVIDER`
3. 默认回退 `kimi`

请求示例：

```json
{
  "message": "请介绍一下候选人的项目经验",
  "history": [],
  "provider": "zhipu"
}
```

## 流式模式与观测

`POST /api/chat/stream` 现在采用统一适配层，默认策略为：
- provider `native` 流式优先
- 初始化失败时自动 fallback 到 `compatible` 流式

后端会输出结构化日志（`STREAM_QUALITY`）用于判断是否“真流式”，关键字段：
- `request_id`
- `provider` / `model`
- `provider_mode`（`native` / `compatible`）
- `fallback_reason`
- `first_token_latency_ms`
- `token_event_count`
- `token_gap_ms_p95`
- `stream_duration_ms`
- `degraded_streaming`

当出现以下任一条件时会标记 `degraded_streaming=true`：
- `token_event_count <= CHAT_STREAM_MIN_TOKEN_EVENTS`
- `first_token_latency_ms > CHAT_STREAM_FIRST_TOKEN_MAX_LATENCY_MS`

## 流式验收脚本

可使用 `curl --no-buffer` 脚本做端到端冒烟：

```bash
bash scripts/stream-smoke.sh
```

常用参数：
- `API_BASE_URL`（默认 `http://localhost:8000`）
- `PROVIDER`（`kimi` / `zhipu`）
- `MESSAGE`

## 排障建议

1. 若首 token 很慢或只出现 1 个 token 事件，先看 `STREAM_QUALITY` 中 `provider_mode` 与 `fallback_reason`。
2. 若部署在 Nginx，确认已关闭缓冲：`proxy_buffering off;`，并保留响应头 `X-Accel-Buffering: no`。
3. 用 `scripts/stream-smoke.sh` 分别对 `kimi`、`zhipu` 重复采样，比较 `first_token_latency_ms` 与 `token_event_count`。

## GHCR 发布（Tag 驱动）

- 工作流文件：`.github/workflows/ghcr-release.yml`
- 触发条件：推送 tag `v*`（例如 `v1.2.3`）
- 镜像地址：`ghcr.io/<owner>/<repo>`
- 标签规则：
  - 原始 tag：`v1.2.3`
  - 语义化 tag：`1.2.3`（自动去掉 `v` 前缀）
  - 稳定 tag：`latest`（当 tag 不包含 `-` 预发布后缀时）

示例发布：

```bash
git tag v1.2.3
git push origin v1.2.3
```

拉取示例：

```bash
docker pull ghcr.io/<owner>/<repo>:v1.2.3
docker pull ghcr.io/<owner>/<repo>:1.2.3
```

## 防护仿真输出说明

执行 `deno task simulate:guard` 后，重点看这几行：
- `phase=staging-loose`：低流量场景，用于观察误伤率是否足够低。
- `phase=prod-stage-1/2/3`：逐步收紧阈值后，`allowed` 应持续下降。
- 出现 `simulation=passed` 表示本地仿真通过。
