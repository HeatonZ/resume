# AI 简历名片应用

一个基于 Vue 3 + Vite 的对话应用，用于基于结构化简历数据回答候选人相关问题。

## 技术栈

- 前端：Vue 3、Pinia、Naive UI、@vueuse/motion、Vite
- 后端：Node.js（原生 http）
- 模型：OpenAI Chat Completions API

## 环境要求

- Node.js 18+

## 环境变量

```powershell
$env:OPENAI_API_KEY="你的OpenAIKey"
$env:OPENAI_MODEL="gpt-4.1-mini"
```

`OPENAI_MODEL` 可选，默认 `gpt-4.1-mini`。

## 运行方式

### 开发模式

```powershell
npm run dev
```

- 前端地址：`http://localhost:5173`
- API 地址：`http://localhost:3000`

### 构建

```powershell
npm run build
```

构建产物输出到 `dist/`。

### 生产启动

```powershell
npm run start
```

服务地址：`http://localhost:3000`（由 `server.js` 托管 `dist` 与 `/api/*`）。

## 数据来源

- 唯一数据源：`data/resume.json`

`resume.md` 已移除，运行时不再支持 Markdown 数据源。
