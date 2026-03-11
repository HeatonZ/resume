import OpenAI from "npm:openai";
import type { ChatCompletionMessageParam } from "npm:openai/resources/chat/completions";
import { extname, fromFileUrl, join, normalize } from "jsr:@std/path";
import { loadSync } from "jsr:@std/dotenv";

function loadEnvFiles() {
  for (const envPath of [".env.local", ".env"]) {
    try {
      loadSync({ envPath, export: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

function parseMode() {
  const fromArg = Deno.args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
  const fromEnv = Deno.env.get("APP_MODE");
  const mode = String(fromArg || fromEnv || "full").toLowerCase();
  return mode === "api" ? "api" : "full";
}

function getMimeType(filePath: string) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".woff2") return "font/woff2";
  return "text/plain; charset=utf-8";
}

function stripHtml(input: unknown) {
  return String(input || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value: unknown) {
  return String(value || "").trim();
}

function tokenize(text: string) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function isAbortLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("AbortError") || message.includes("cancelled") || message.includes("aborted");
}

loadEnvFiles();

const MODE = parseMode();
const API_HOST = Deno.env.get("API_HOST") || "0.0.0.0";
const API_PORT = Number(Deno.env.get("API_PORT") || "8000");
const MOONSHOT_API_KEY = Deno.env.get("MOONSHOT_API_KEY") || "";
const MOONSHOT_BASE_URL = Deno.env.get("MOONSHOT_BASE_URL") || "https://api.moonshot.cn/v1";
const MOONSHOT_MODEL = Deno.env.get("MOONSHOT_MODEL") || "kimi-k2-0711-preview";
const ZHIPU_API_KEY = Deno.env.get("ZHIPU_API_KEY") || "";
const ZHIPU_BASE_URL = Deno.env.get("ZHIPU_BASE_URL") || "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_MODEL = Deno.env.get("ZHIPU_MODEL") || "GLM-4.7-Flash";
const DEFAULT_CHAT_PROVIDER = (Deno.env.get("CHAT_PROVIDER") || "").trim().toLowerCase();
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const resumeJsonPath = new URL("../data/resume.json", import.meta.url);
const frontendDistFsPath = fromFileUrl(new URL("../frontend/dist/", import.meta.url));
const encoder = new TextEncoder();
const openAIClients = new Map<string, OpenAI>();

type ChatProvider = "kimi" | "zhipu";
type ChatHistoryItem = { role: string; content: string };

type ProviderConfig = {
  provider: ChatProvider;
  apiKey: string;
  baseURL: string;
  model: string;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function errorResponse(reqId: string, status: number, code: string, message: string) {
  return jsonResponse({ error: message, code, requestId: reqId }, status);
}

async function readResumeJson() {
  let raw = "";
  try {
    raw = await Deno.readTextFile(resumeJsonPath);
  } catch {
    const error = new Error("Resume source not found: data/resume.json");
    // @ts-ignore custom runtime code
    error.code = "RESUME_SOURCE_MISSING";
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Resume source is not valid JSON: data/resume.json");
    // @ts-ignore custom runtime code
    error.code = "RESUME_SOURCE_INVALID";
    throw error;
  }
}

function normalizeProfile(resume: any) {
  const basics = resume?.basics || {};
  const summaryRaw = safeText(stripHtml(resume?.summary?.content));
  const sections = resume?.sections || {};
  const skills = Array.isArray(sections?.skills?.items)
    ? sections.skills.items
        .map((item: any) => safeText(item?.name))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const experiences = Array.isArray(sections?.experience?.items) ? sections.experience.items : [];
  const projects = Array.isArray(sections?.projects?.items) ? sections.projects.items : [];
  const highlights = [];

  for (const item of experiences.slice(0, 2)) {
    const value = [safeText(item?.position), safeText(item?.company), safeText(item?.period)]
      .filter(Boolean)
      .join(" | ");
    if (value) highlights.push(value);
  }
  for (const item of projects.slice(0, 2)) {
    const value = [safeText(item?.name), safeText(item?.period)].filter(Boolean).join(" | ");
    if (value) highlights.push(value);
  }

  return {
    name: safeText(basics?.name) || "Candidate",
    headline: safeText(basics?.headline),
    location: safeText(basics?.location),
    email: safeText(basics?.email),
    phone: safeText(basics?.phone),
    summary: summaryRaw,
    skills,
    highlights: highlights.slice(0, 4)
  };
}

function buildResumeChunks(resume: any) {
  const chunks: Array<{ id: number; title: string; text: string }> = [];
  let nextId = 1;

  function pushChunk(title: string, text: string) {
    const cleanTitle = safeText(title);
    const cleanText = safeText(text);
    if (!cleanText) return;
    chunks.push({ id: nextId++, title: cleanTitle || `Section ${nextId - 1}`, text: cleanText });
  }

  const basics = resume?.basics || {};
  pushChunk("Basics", [safeText(basics?.name), safeText(basics?.headline), safeText(basics?.location)].filter(Boolean).join(" | "));
  pushChunk("Summary", stripHtml(resume?.summary?.content || ""));

  const sections = resume?.sections || {};
  const experienceItems = Array.isArray(sections?.experience?.items) ? sections.experience.items : [];
  for (const item of experienceItems) {
    pushChunk(
      `Experience: ${safeText(item?.company) || safeText(item?.position) || "Item"}`,
      [safeText(item?.company), safeText(item?.position), safeText(item?.location), safeText(item?.period), stripHtml(item?.description || "")]
        .filter(Boolean)
        .join("\n")
    );
  }

  const projectItems = Array.isArray(sections?.projects?.items) ? sections.projects.items : [];
  for (const item of projectItems) {
    pushChunk(
      `Project: ${safeText(item?.name) || "Item"}`,
      [safeText(item?.name), safeText(item?.period), stripHtml(item?.description || "")]
        .filter(Boolean)
        .join("\n")
    );
  }

  const educationItems = Array.isArray(sections?.education?.items) ? sections.education.items : [];
  for (const item of educationItems) {
    pushChunk(
      `Education: ${safeText(item?.school) || "Item"}`,
      [safeText(item?.school), safeText(item?.degree), safeText(item?.area), safeText(item?.period), stripHtml(item?.description || "")]
        .filter(Boolean)
        .join("\n")
    );
  }

  const skillItems = Array.isArray(sections?.skills?.items) ? sections.skills.items : [];
  if (skillItems.length > 0) {
    pushChunk(
      "Skills",
      skillItems
        .map((item: any) => safeText(item?.name))
        .filter(Boolean)
        .join(", ")
    );
  }

  if (chunks.length === 0) pushChunk("Resume", "No structured resume content available.");
  return chunks;
}

function pickTopChunks(query: string, chunks: Array<{ id: number; title: string; text: string }>, topK = 4) {
  const querySet = new Set(tokenize(query));
  return chunks
    .map((chunk) => {
      let score = 0;
      for (const token of tokenize(chunk.text)) {
        if (querySet.has(token)) score += 1;
      }
      return { ...chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function getRuntimeContext() {
  const resume = await readResumeJson();
  return { profile: normalizeProfile(resume), chunks: buildResumeChunks(resume) };
}

function buildMessages(profile: any, userMessage: string, history: ChatHistoryItem[], context: string) {
  const systemPrompt = [
    `你是“${profile.name}”的 AI 名片助手，目标是向用户准确介绍该候选人的简历信息。`,
    "你必须严格依据提供的简历资料回答，禁止编造不存在的事实。",
    "如果信息缺失，请明确说明“资料中未提供该信息”。",
    "回答语言使用中文，风格专业、简洁、客观。"
  ].join("");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: `简历资料如下：\n${context}` }
  ];

  for (const item of history.slice(-8)) {
    if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
      messages.push({ role: item.role, content: item.content } as ChatCompletionMessageParam);
    }
  }
  messages.push({ role: "user", content: userMessage });
  return messages;
}

function createError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function resolveProvider(input: unknown): ChatProvider {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) return DEFAULT_CHAT_PROVIDER === "zhipu" ? "zhipu" : "kimi";
  if (normalized === "kimi" || normalized === "zhipu") return normalized;
  throw createError(`Unsupported provider: ${normalized}`, "INVALID_PROVIDER");
}

function getProviderConfig(provider: ChatProvider): ProviderConfig {
  if (provider === "zhipu") {
    return { provider, apiKey: ZHIPU_API_KEY, baseURL: ZHIPU_BASE_URL, model: ZHIPU_MODEL };
  }
  return { provider: "kimi", apiKey: MOONSHOT_API_KEY, baseURL: MOONSHOT_BASE_URL, model: MOONSHOT_MODEL };
}

function assertProviderConfig(config: ProviderConfig) {
  const missingFields: string[] = [];
  if (!config.apiKey) missingFields.push("apiKey");
  if (!config.baseURL) missingFields.push("baseURL");
  if (!config.model) missingFields.push("model");
  if (missingFields.length > 0) {
    throw createError(`Provider config missing for ${config.provider}: ${missingFields.join(", ")}`, "MODEL_CONFIG_MISSING");
  }
}

function getOpenAIClient(config: ProviderConfig) {
  const cacheKey = `${config.provider}|${config.baseURL}|${config.apiKey}`;
  const cached = openAIClients.get(cacheKey);
  if (cached) return cached;
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  openAIClients.set(cacheKey, client);
  return client;
}

async function callChatCompletion(messages: ChatCompletionMessageParam[], provider: ChatProvider) {
  const config = getProviderConfig(provider);
  assertProviderConfig(config);
  const client = getOpenAIClient(config);
  const completion = await client.chat.completions.create({ model: config.model, temperature: 0.3, messages });
  return completion.choices?.[0]?.message?.content?.trim() || "暂时没有可用回复。";
}
function sseEvent(event: string, payload: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function streamChat(
  messages: ChatCompletionMessageParam[],
  refs: any[],
  reqId: string,
  provider: ChatProvider,
  signal?: AbortSignal
) {
  const config = getProviderConfig(provider);
  assertProviderConfig(config);
  const client = getOpenAIClient(config);

  return new ReadableStream({
    async start(controller) {
      try {
        if (signal?.aborted) {
          controller.close();
          return;
        }

        controller.enqueue(sseEvent("refs", { references: refs.map((item) => ({ title: item.title, score: item.score })) }));
        const stream = await client.chat.completions.create(
          {
            model: config.model,
            temperature: 0.3,
            messages,
            stream: true
          },
          { signal }
        );

        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(sseEvent("token", { delta }));
        }

        if (!signal?.aborted) controller.enqueue(sseEvent("done", { requestId: reqId }));
      } catch (error) {
        if (signal?.aborted || isAbortLikeError(error)) {
          controller.close();
          return;
        }
        const message = error instanceof Error ? error.message : "流式响应失败";
        controller.enqueue(sseEvent("error", { message, requestId: reqId }));
      } finally {
        controller.close();
      }
    }
  });
}

async function parseChatPayload(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const userMessage = String(payload?.message || "").trim();
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const provider = payload?.provider;
  return { userMessage, history, provider };
}

async function prepareChatContext(userMessage: string, history: ChatHistoryItem[]) {
  if (!userMessage) {
    const error = new Error("message 不能为空");
    // @ts-ignore custom runtime code
    error.code = "INVALID_REQUEST";
    throw error;
  }

  const { profile, chunks } = await getRuntimeContext();
  const refs = pickTopChunks(userMessage, chunks, 4);
  const context = refs.map((chunk) => chunk.text).join("\n\n---\n\n");
  const messages = buildMessages(profile, userMessage, history, context);
  return { refs, messages };
}

async function handleProfile(request: Request, reqId: string) {
  try {
    if (request.signal.aborted) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const { profile } = await getRuntimeContext();
    return jsonResponse(profile, 200);
  } catch (error) {
    if (isAbortLikeError(error) || request.signal.aborted) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const message = error instanceof Error ? error.message : "服务异常";
    const code = (error as { code?: string })?.code || "RUNTIME_PROFILE_ERROR";
    return errorResponse(reqId, 500, code, message);
  }
}

async function handleChat(request: Request, reqId: string) {
  try {
    const { userMessage, history, provider } = await parseChatPayload(request);
    const resolvedProvider = resolveProvider(provider);
    const { refs, messages } = await prepareChatContext(userMessage, history);
    const reply = await callChatCompletion(messages, resolvedProvider);
    return jsonResponse({
      reply,
      provider: resolvedProvider,
      references: refs.map((item) => ({ title: item.title, score: item.score })),
      requestId: reqId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务异常";
    const code = (error as { code?: string })?.code || "CHAT_RUNTIME_ERROR";
    return errorResponse(reqId, code === "INVALID_REQUEST" ? 400 : 500, code, message);
  }
}

async function handleChatStream(request: Request, reqId: string) {
  try {
    const { userMessage, history, provider } = await parseChatPayload(request);
    const resolvedProvider = resolveProvider(provider);
    const { refs, messages } = await prepareChatContext(userMessage, history);
    return new Response(streamChat(messages, refs, reqId, resolvedProvider, request.signal), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...corsHeaders()
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务异常";
    const code = (error as { code?: string })?.code || "CHAT_STREAM_RUNTIME_ERROR";
    return errorResponse(reqId, code === "INVALID_REQUEST" ? 400 : 500, code, message);
  }
}

async function serveFrontend(pathname: string, reqId: string) {
  try {
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const targetPath = join(frontendDistFsPath, safePath);

    const stat = await Deno.stat(targetPath).catch(() => null);
    if (stat?.isFile) {
      const data = await Deno.readFile(targetPath);
      return new Response(data, { status: 200, headers: { "Content-Type": getMimeType(targetPath) } });
    }

    const indexPath = join(frontendDistFsPath, "index.html");
    const indexData = await Deno.readFile(indexPath);
    return new Response(indexData, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch {
    return errorResponse(reqId, 503, "FRONTEND_DIST_MISSING", "frontend/dist 不存在，请先执行 deno task build。");
  }
}

Deno.serve({ hostname: API_HOST, port: API_PORT }, async (request) => {
  const url = new URL(request.url);
  const reqId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "GET" && url.pathname === "/api/profile") return handleProfile(request, reqId);
  if (request.method === "POST" && url.pathname === "/api/chat") return handleChat(request, reqId);
  if (request.method === "POST" && url.pathname === "/api/chat/stream") return handleChatStream(request, reqId);

  if (MODE === "full" && request.method === "GET" && !url.pathname.startsWith("/api/")) {
    return serveFrontend(url.pathname, reqId);
  }

  return errorResponse(reqId, 404, "NOT_FOUND", "Not Found");
});

console.log(`Backend mode=${MODE} running at http://${API_HOST}:${API_PORT}`);

