# AI 简历名片应用

## 目录结构

- `frontend/`: Vue 3 + Vite 前端
- `backend/`: Deno 后端（API + 生产静态托管）
- `data/`: 简历数据源（`resume.json`）

## 运行模式

- 开发模式：前后端分离运行
- 前端：`http://localhost:5173`
- 后端 API：`http://localhost:8000`
- 生产模式：后端直接托管 `frontend/dist`，并提供 `/api/*`

## 环境变量

支持 `.env` / `.env.local`（后端自动加载），示例见 `.env.example`。

关键变量：

- `MOONSHOT_API_KEY`
- `MOONSHOT_BASE_URL`
- `MOONSHOT_MODEL`
- `API_HOST`
- `API_PORT`
- `ALLOWED_ORIGIN`

## 根目录统一命令（Deno）

### 开发（前后端分离）

```powershell
deno task dev
```

### 仅启动后端 API（开发）

```powershell
deno task dev:api
```

### 构建前端

```powershell
deno task build
```

会在 `frontend/dist` 生成构建产物。

### 生产启动（托管 frontend/dist + API）

```powershell
deno task start
```

## API

- `GET /api/profile`
- `POST /api/chat`
- `POST /api/chat/stream`（SSE 流式）

## Chat Provider Routing

Backend now supports two OpenAI-compatible providers:
- `kimi` (default)
- `zhipu` (default model `GLM-4.7-Flash`)

Provider selection priority:
1. request body `provider`
2. env `CHAT_PROVIDER`
3. fallback `kimi`

Request example:

```json
{
  "message": "请介绍一下候选人的项目经验",
  "history": [],
  "provider": "zhipu"
}
```

New environment variables:
- `ZHIPU_API_KEY`
- `ZHIPU_BASE_URL` (default: `https://open.bigmodel.cn/api/paas/v4`)
- `ZHIPU_MODEL` (default: `GLM-4.7-Flash`)
- `CHAT_PROVIDER` (`kimi` or `zhipu`)
