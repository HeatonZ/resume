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

## 防护仿真输出说明

执行 `deno task simulate:guard` 后，重点看这几行：
- `phase=staging-loose`：低流量场景，用于观察误伤率是否足够低。
- `phase=prod-stage-1/2/3`：逐步收紧阈值后，`allowed` 应持续下降。
- 出现 `simulation=passed` 表示本地仿真通过。
