import type OpenAI from "npm:openai";
import type { ChatCompletionMessageParam } from "npm:openai/resources/chat/completions";
import { extname, fromFileUrl, join, normalize } from "jsr:@std/path";
import { loadSync } from "jsr:@std/dotenv";
import {
  AbuseGuard,
  extractClientIp,
  loadGuardConfig,
  validateChatInput,
} from "./abuse_guard.ts";
import {
  assertProviderConfig,
  callCompatibleCompletion,
  type ChatProvider,
  createProviderStream,
  getProviderConfig,
  type ProviderConfig,
  resolveProvider,
} from "./providers/index.ts";

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
  const fromArg = Deno.args.find((arg) => arg.startsWith("--mode="))?.slice(
    "--mode=".length,
  );
  const fromEnv = Deno.env.get("APP_MODE");
  const mode = String(fromArg || fromEnv || "full").toLowerCase();
  return mode === "api" ? "api" : "full";
}

function getMimeType(filePath: string) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") {
    return "application/javascript; charset=utf-8";
  }
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

function pickGithubUrl(resume: any) {
  const basicsUrl = safeText(resume?.basics?.website?.url);
  if (/github\.com/i.test(basicsUrl)) return basicsUrl;

  const profileItems = Array.isArray(resume?.sections?.profiles?.items)
    ? resume.sections.profiles.items
    : [];
  for (const item of profileItems) {
    const network = safeText(item?.network);
    const url = safeText(item?.url);
    if (network.toLowerCase() === "github" && url) return url;
    if (/github\.com/i.test(url)) return url;
  }

  return "";
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
  return message.includes("AbortError") || message.includes("cancelled") ||
    message.includes("aborted");
}

function serializeError(error: unknown) {
  const fallbackMessage = String(error || "unknown error");
  if (!(error instanceof Error)) {
    return { message: fallbackMessage };
  }

  const asAny = error as any;
  return {
    name: error.name,
    message: error.message || fallbackMessage,
    code: asAny?.code,
    status: asAny?.status,
    type: asAny?.type,
    cause: asAny?.cause instanceof Error
      ? asAny.cause.message
      : String(asAny?.cause || ""),
  };
}

function isNetworkLikeError(error: unknown) {
  const payload = serializeError(error);
  const text = [
    payload.name,
    payload.message,
    payload.code,
    payload.type,
    payload.cause,
  ].join(" ").toLowerCase();
  return (
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("fetch failed") ||
    text.includes("connection") ||
    text.includes("socket") ||
    text.includes("enotfound") ||
    text.includes("econnreset") ||
    text.includes("tls")
  );
}

function logError(
  scope: string,
  message: string,
  meta: Record<string, unknown>,
) {
  console.error(
    `[${new Date().toISOString()}] [${scope}] ${message} ${
      JSON.stringify(meta, (_, value) =>
        value instanceof Error ? serializeError(value) : value)
    }`,
  );
}

function logInfo(
  scope: string,
  message: string,
  meta: Record<string, unknown>,
) {
  console.log(
    `[${new Date().toISOString()}] [${scope}] ${message} ${
      JSON.stringify(meta)
    }`,
  );
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

loadEnvFiles();

const MODE = parseMode();
const API_HOST = Deno.env.get("API_HOST") || "0.0.0.0";
const API_PORT = Number(Deno.env.get("API_PORT") || "8000");
const MOONSHOT_API_KEY = Deno.env.get("MOONSHOT_API_KEY") || "";
const MOONSHOT_BASE_URL = Deno.env.get("MOONSHOT_BASE_URL") ||
  "https://api.moonshot.cn/v1";
const MOONSHOT_MODEL = Deno.env.get("MOONSHOT_MODEL") || "kimi-k2-0711-preview";
const ZHIPU_API_KEY = Deno.env.get("ZHIPU_API_KEY") || "";
const ZHIPU_BASE_URL = Deno.env.get("ZHIPU_BASE_URL") ||
  "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_MODEL = Deno.env.get("ZHIPU_MODEL") || "GLM-4.7-Flash";
const DEFAULT_CHAT_PROVIDER = (Deno.env.get("CHAT_PROVIDER") || "").trim()
  .toLowerCase();
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const GUARD_CONFIG = loadGuardConfig((name) => Deno.env.get(name));

const resumeJsonPath = new URL("../data/resume.json", import.meta.url);
const resumePdfPath = new URL("../data/resume.pdf", import.meta.url);
const RESUME_PDF_ROUTE = "/resume.pdf";
const frontendDistFsPath = fromFileUrl(
  new URL("../frontend/dist/", import.meta.url),
);
const encoder = new TextEncoder();
const openAIClients = new Map<string, OpenAI>();
const kv = GUARD_CONFIG.enabled && typeof Deno.openKv === "function"
  ? await Deno.openKv().catch((error) => {
    logError("GUARD_KV", "Failed to open Deno KV", {
      error: serializeError(error),
    });
    return null;
  })
  : null;
if (GUARD_CONFIG.enabled && typeof Deno.openKv !== "function") {
  logError(
    "GUARD_KV",
    "Deno.openKv is unavailable; start with --unstable-kv or run on Deno Deploy",
    {},
  );
}
const abuseGuard = new AbuseGuard(GUARD_CONFIG, kv);

type ChatHistoryItem = { role: string; content: string };

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
  };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
      ...corsHeaders(),
    },
  });
}

function errorResponse(
  reqId: string,
  status: number,
  code: string,
  message: string,
  options: {
    headers?: Record<string, string>;
    meta?: Record<string, unknown>;
  } = {},
) {
  return jsonResponse(
    { error: message, code, requestId: reqId, ...options.meta },
    status,
    options.headers || {},
  );
}

function logGuardRejection(
  reqId: string,
  path: string,
  ip: string,
  code: string,
  limitType: string,
  remaining: number | null = null,
) {
  logError("API_GUARD", "Request rejected by guard", {
    requestId: reqId,
    path,
    ip,
    code,
    limitType,
    remaining,
  });
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
    const error = new Error(
      "Resume source is not valid JSON: data/resume.json",
    );
    // @ts-ignore custom runtime code
    error.code = "RESUME_SOURCE_INVALID";
    throw error;
  }
}

function normalizeProfile(resume: any) {
  const basics = resume?.basics || {};
  const summaryRaw = safeText(stripHtml(resume?.summary?.content));
  const sections = resume?.sections || {};
  const github = pickGithubUrl(resume);
  const skills = Array.isArray(sections?.skills?.items)
    ? sections.skills.items
      .map((item: any) => safeText(item?.name))
      .filter(Boolean)
      .slice(0, 12)
    : [];

  const experiences = Array.isArray(sections?.experience?.items)
    ? sections.experience.items
    : [];
  const projects = Array.isArray(sections?.projects?.items)
    ? sections.projects.items
    : [];
  const highlights = [];

  for (const item of experiences.slice(0, 2)) {
    const value = [
      safeText(item?.position),
      safeText(item?.company),
      safeText(item?.period),
    ]
      .filter(Boolean)
      .join(" | ");
    if (value) highlights.push(value);
  }
  for (const item of projects.slice(0, 2)) {
    const value = [safeText(item?.name), safeText(item?.period)].filter(Boolean)
      .join(" | ");
    if (value) highlights.push(value);
  }

  return {
    name: safeText(basics?.name) || "Candidate",
    headline: safeText(basics?.headline),
    location: safeText(basics?.location),
    email: safeText(basics?.email),
    phone: safeText(basics?.phone),
    github,
    resumePdfUrl: RESUME_PDF_ROUTE,
    summary: summaryRaw,
    skills,
    highlights: highlights.slice(0, 4),
  };
}

function buildResumeChunks(resume: any) {
  const chunks: Array<{ id: number; title: string; text: string }> = [];
  let nextId = 1;

  function pushChunk(title: string, text: string) {
    const cleanTitle = safeText(title);
    const cleanText = safeText(text);
    if (!cleanText) return;
    chunks.push({
      id: nextId++,
      title: cleanTitle || `Section ${nextId - 1}`,
      text: cleanText,
    });
  }

  const basics = resume?.basics || {};
  pushChunk(
    "Basics",
    [
      safeText(basics?.name),
      safeText(basics?.headline),
      safeText(basics?.location),
    ].filter(Boolean).join(" | "),
  );
  pushChunk("Summary", stripHtml(resume?.summary?.content || ""));

  const sections = resume?.sections || {};
  const experienceItems = Array.isArray(sections?.experience?.items)
    ? sections.experience.items
    : [];
  for (const item of experienceItems) {
    pushChunk(
      `Experience: ${
        safeText(item?.company) || safeText(item?.position) || "Item"
      }`,
      [
        safeText(item?.company),
        safeText(item?.position),
        safeText(item?.location),
        safeText(item?.period),
        stripHtml(item?.description || ""),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const projectItems = Array.isArray(sections?.projects?.items)
    ? sections.projects.items
    : [];
  for (const item of projectItems) {
    pushChunk(
      `Project: ${safeText(item?.name) || "Item"}`,
      [
        safeText(item?.name),
        safeText(item?.period),
        stripHtml(item?.description || ""),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const educationItems = Array.isArray(sections?.education?.items)
    ? sections.education.items
    : [];
  for (const item of educationItems) {
    pushChunk(
      `Education: ${safeText(item?.school) || "Item"}`,
      [
        safeText(item?.school),
        safeText(item?.degree),
        safeText(item?.area),
        safeText(item?.period),
        stripHtml(item?.description || ""),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const skillItems = Array.isArray(sections?.skills?.items)
    ? sections.skills.items
    : [];
  if (skillItems.length > 0) {
    pushChunk(
      "Skills",
      skillItems
        .map((item: any) => safeText(item?.name))
        .filter(Boolean)
        .join(", "),
    );
  }

  if (chunks.length === 0) {
    pushChunk("Resume", "No structured resume content available.");
  }
  return chunks;
}

function pickTopChunks(
  query: string,
  chunks: Array<{ id: number; title: string; text: string }>,
  topK = 4,
) {
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
  return {
    profile: normalizeProfile(resume),
    chunks: buildResumeChunks(resume),
  };
}

function buildMessages(
  profile: any,
  userMessage: string,
  history: ChatHistoryItem[],
  context: string,
) {
  const systemPrompt = [
    `你是“${profile.name}”的 AI 名片助手，目标是向用户准确介绍该候选人的简历信息。`,
    "你必须严格依据提供的简历资料回答，禁止编造不存在的事实。",
    "如果信息缺失，请明确说明“资料中未提供该信息”。",
    "回答语言使用中文，风格专业、简洁、客观。",
  ].join("");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: `简历资料如下：\n${context}` },
  ];

  for (const item of history.slice(-8)) {
    if (
      item && (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string"
    ) {
      messages.push(
        {
          role: item.role,
          content: item.content,
        } as ChatCompletionMessageParam,
      );
    }
  }
  messages.push({ role: "user", content: userMessage });
  return messages;
}

const DEFAULT_PROVIDER: ChatProvider = DEFAULT_CHAT_PROVIDER === "zhipu"
  ? "zhipu"
  : "kimi";
const PROVIDER_CONFIGS: Record<ChatProvider, ProviderConfig> = {
  kimi: {
    provider: "kimi",
    apiKey: MOONSHOT_API_KEY,
    baseURL: MOONSHOT_BASE_URL,
    model: MOONSHOT_MODEL,
  },
  zhipu: {
    provider: "zhipu",
    apiKey: ZHIPU_API_KEY,
    baseURL: ZHIPU_BASE_URL,
    model: ZHIPU_MODEL,
  },
};

function createError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

async function callChatCompletion(
  messages: ChatCompletionMessageParam[],
  provider: ChatProvider,
  reqId: string,
) {
  const config = getProviderConfig(provider, PROVIDER_CONFIGS);
  assertProviderConfig(config);
  try {
    const text = await callCompatibleCompletion({
      provider,
      config,
      messages,
      temperature: 0.3,
      maxTokens: GUARD_CONFIG.maxOutputTokens,
    }, openAIClients);
    if (text) return text;

    logError("AI_CHAT", "Empty completion content", {
      requestId: reqId,
      provider: config.provider,
      model: config.model,
    });
    return "暂时没有可用回复。";
  } catch (error) {
    logError("AI_CHAT", "Chat completion failed", {
      requestId: reqId,
      provider: config.provider,
      model: config.model,
      networkLike: isNetworkLikeError(error),
      error: serializeError(error),
    });
    throw error;
  }
}
function sseEvent(event: string, payload: unknown) {
  return encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

function sseComment(comment: string) {
  return encoder.encode(`: ${comment}\n\n`);
}

function streamChat(
  messages: ChatCompletionMessageParam[],
  refs: any[],
  reqId: string,
  provider: ChatProvider,
  signal?: AbortSignal,
  onClose?: () => void,
) {
  const config = getProviderConfig(provider, PROVIDER_CONFIGS);
  assertProviderConfig(config);
  const { stream, telemetry } = createProviderStream(
    {
      provider,
      config,
      messages,
      temperature: 0.3,
      maxTokens: GUARD_CONFIG.maxOutputTokens,
      signal,
    },
    openAIClients,
  );

  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const streamStart = Date.now();
      let firstTokenAt = 0;
      let tokenEventCount = 0;
      let lastTokenAt = 0;
      const tokenGapsMs: number[] = [];
      let streamErrorCode = "";
      let streamErrorMessage = "";

      const keepAlive = setInterval(() => {
        safeEnqueue(sseComment("ping"));
      }, 15000);

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Ignore double-close/closed stream errors.
        }
      };

      try {
        if (signal?.aborted) {
          safeClose();
          return;
        }

        if (
          !safeEnqueue(
            sseEvent("refs", {
              references: refs.map((item) => ({
                title: item.title,
                score: item.score,
              })),
            }),
          )
        ) {
          return;
        }

        for await (const event of stream) {
          if (signal?.aborted) break;
          if (event.type === "token") {
            const now = Date.now();
            tokenEventCount += 1;
            if (!firstTokenAt) firstTokenAt = now;
            if (lastTokenAt) tokenGapsMs.push(now - lastTokenAt);
            lastTokenAt = now;
            if (!safeEnqueue(sseEvent("token", { delta: event.delta }))) break;
            continue;
          }
          if (event.type === "error") {
            streamErrorCode = event.code || "PROVIDER_STREAM_FAILED";
            streamErrorMessage = event.message || "流式响应失败";
            safeEnqueue(
              sseEvent("error", {
                message: streamErrorMessage,
                code: streamErrorCode,
                requestId: reqId,
              }),
            );
            break;
          }
          if (event.type === "done") {
            safeEnqueue(sseEvent("done", { requestId: reqId }));
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted || isAbortLikeError(error)) {
          safeClose();
          return;
        }
        streamErrorCode = (error as { code?: string })?.code ||
          "PROVIDER_STREAM_RUNTIME_ERROR";
        streamErrorMessage = error instanceof Error
          ? error.message
          : "流式响应失败";
        logError("AI_STREAM", "Chat stream failed", {
          requestId: reqId,
          provider: config.provider,
          model: config.model,
          providerMode: telemetry.providerMode,
          fallbackReason: telemetry.fallbackReason,
          networkLike: isNetworkLikeError(error),
          error: serializeError(error),
        });
        safeEnqueue(
          sseEvent("error", {
            message: streamErrorMessage,
            code: streamErrorCode,
            requestId: reqId,
          }),
        );
      } finally {
        clearInterval(keepAlive);
        const streamDurationMs = Date.now() - streamStart;
        const firstTokenLatencyMs = firstTokenAt
          ? firstTokenAt - streamStart
          : streamDurationMs;
        const tokenGapMsP95 = percentile(tokenGapsMs, 95);
        const degradedStreaming =
          tokenEventCount <= GUARD_CONFIG.streamMinTokenEvents ||
          firstTokenLatencyMs > GUARD_CONFIG.streamFirstTokenMaxLatencyMs;
        logInfo("STREAM_QUALITY", "Stream completed", {
          request_id: reqId,
          provider: config.provider,
          model: config.model,
          provider_mode: telemetry.providerMode,
          fallback_reason: telemetry.fallbackReason,
          first_token_latency_ms: firstTokenLatencyMs,
          token_event_count: tokenEventCount,
          token_gap_ms_p95: tokenGapMsP95,
          stream_duration_ms: streamDurationMs,
          degraded_streaming: degradedStreaming,
          first_token_latency_threshold_ms:
            GUARD_CONFIG.streamFirstTokenMaxLatencyMs,
          min_token_events_threshold: GUARD_CONFIG.streamMinTokenEvents,
          error_code: streamErrorCode || null,
          error_message: streamErrorMessage || null,
        });
        onClose?.();
        safeClose();
      }
    },
  });
}

async function parseChatPayload(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const userMessage = String(payload?.message || "").trim();
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const provider = payload?.provider;
  return { userMessage, history, provider };
}

async function prepareChatContext(
  userMessage: string,
  history: ChatHistoryItem[],
) {
  const inputDecision = await validateChatInput(
    userMessage,
    history.length,
    GUARD_CONFIG,
  );
  if (!inputDecision.ok) {
    throw createError(
      inputDecision.message || "请求参数不合法",
      inputDecision.code || "INVALID_REQUEST",
    );
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
    logError("API_PROFILE", "Profile request failed", {
      requestId: reqId,
      error: serializeError(error),
    });
    const message = error instanceof Error ? error.message : "服务异常";
    const code = (error as { code?: string })?.code || "RUNTIME_PROFILE_ERROR";
    return errorResponse(reqId, 500, code, message);
  }
}

async function handleResumePdf(request: Request, reqId: string) {
  try {
    if (request.signal.aborted) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const data = await Deno.readFile(resumePdfPath);
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "public, max-age=300",
        ...corsHeaders(),
      },
    });
  } catch (error) {
    if (isAbortLikeError(error) || request.signal.aborted) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const missing = error instanceof Deno.errors.NotFound;
    logError("API_RESUME_PDF", "Resume PDF request failed", {
      requestId: reqId,
      missing,
      error: serializeError(error),
    });
    return errorResponse(
      reqId,
      missing ? 404 : 500,
      missing ? "RESUME_PDF_MISSING" : "RESUME_PDF_READ_FAILED",
      missing
        ? "Resume PDF not found: data/resume.pdf"
        : "Failed to read resume PDF",
    );
  }
}

async function handleChat(request: Request, reqId: string) {
  try {
    const { userMessage, history, provider } = await parseChatPayload(request);
    const resolvedProvider = resolveProvider(provider, DEFAULT_PROVIDER);
    const { refs, messages } = await prepareChatContext(userMessage, history);
    const reply = await callChatCompletion(messages, resolvedProvider, reqId);
    return jsonResponse({
      reply,
      provider: resolvedProvider,
      references: refs.map((item) => ({
        title: item.title,
        score: item.score,
      })),
      requestId: reqId,
    });
  } catch (error) {
    logError("API_CHAT", "Chat request failed", {
      requestId: reqId,
      networkLike: isNetworkLikeError(error),
      error: serializeError(error),
    });
    const message = error instanceof Error ? error.message : "服务异常";
    const code = (error as { code?: string })?.code || "CHAT_RUNTIME_ERROR";
    const status = [
        "INVALID_REQUEST",
        "MESSAGE_TOO_LARGE",
        "HISTORY_TOO_LARGE",
        "INVALID_PROVIDER",
      ].includes(code)
      ? 400
      : 500;
    return errorResponse(reqId, status, code, message);
  }
}

async function handleChatStream(request: Request, reqId: string) {
  try {
    const { userMessage, history, provider } = await parseChatPayload(request);
    const resolvedProvider = resolveProvider(provider, DEFAULT_PROVIDER);
    const { refs, messages } = await prepareChatContext(userMessage, history);
    const streamController = new AbortController();
    const timeout = setTimeout(() => {
      logError("API_CHAT_STREAM", "Stream duration guard reached", {
        requestId: reqId,
        maxSeconds: GUARD_CONFIG.streamMaxDurationSeconds,
      });
      streamController.abort("STREAM_DURATION_EXCEEDED");
    }, GUARD_CONFIG.streamMaxDurationSeconds * 1000);
    request.signal.addEventListener(
      "abort",
      () => {
        streamController.abort("REQUEST_ABORTED");
      },
      { once: true },
    );

    return new Response(
      streamChat(
        messages,
        refs,
        reqId,
        resolvedProvider,
        streamController.signal,
        () => clearTimeout(timeout),
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          ...corsHeaders(),
        },
      },
    );
  } catch (error) {
    logError("API_CHAT_STREAM", "Chat stream request failed", {
      requestId: reqId,
      networkLike: isNetworkLikeError(error),
      error: serializeError(error),
    });
    const message = error instanceof Error ? error.message : "服务异常";
    const code = (error as { code?: string })?.code ||
      "CHAT_STREAM_RUNTIME_ERROR";
    const status = [
        "INVALID_REQUEST",
        "MESSAGE_TOO_LARGE",
        "HISTORY_TOO_LARGE",
        "INVALID_PROVIDER",
      ].includes(code)
      ? 400
      : 500;
    return errorResponse(reqId, status, code, message);
  }
}

async function serveFrontend(pathname: string, reqId: string) {
  try {
    const requested = pathname === "/"
      ? "index.html"
      : pathname.replace(/^\/+/, "");
    const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const targetPath = join(frontendDistFsPath, safePath);

    const stat = await Deno.stat(targetPath).catch(() => null);
    if (stat?.isFile) {
      const data = await Deno.readFile(targetPath);
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": getMimeType(targetPath) },
      });
    }

    const indexPath = join(frontendDistFsPath, "index.html");
    const indexData = await Deno.readFile(indexPath);
    return new Response(indexData, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return errorResponse(
      reqId,
      503,
      "FRONTEND_DIST_MISSING",
      "frontend/dist 不存在，请先执行 deno task build。",
    );
  }
}

export async function appHandler(
  request: Request,
  info: Deno.ServeHandlerInfo,
) {
  const url = new URL(request.url);
  const reqId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const ip = extractClientIp(request, info?.remoteAddr);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method === "GET" && url.pathname === "/api/profile") {
    return handleProfile(request, reqId);
  }
  if (request.method === "GET" && url.pathname === RESUME_PDF_ROUTE) {
    return handleResumePdf(request, reqId);
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/api/chat" || url.pathname === "/api/chat/stream")
  ) {
    const decision = await abuseGuard.evaluate(ip);
    if (!decision.ok) {
      logGuardRejection(
        reqId,
        url.pathname,
        ip,
        decision.code || "GUARD_REJECTED",
        decision.limitType || "unknown",
        decision.remaining ?? null,
      );
      const headers: Record<string, string> = {};
      if (decision.retryAfter) {
        headers["Retry-After"] = String(decision.retryAfter);
      }
      return errorResponse(
        reqId,
        decision.status || 429,
        decision.code || "RATE_LIMIT_REJECTED",
        decision.message || "请求被拒绝",
        {
          headers,
          meta: {
            limitType: decision.limitType,
            remaining: decision.remaining,
          },
        },
      );
    }
    if (url.pathname === "/api/chat") return handleChat(request, reqId);
    return handleChatStream(request, reqId);
  }

  if (
    MODE === "full" && request.method === "GET" &&
    !url.pathname.startsWith("/api/")
  ) {
    return serveFrontend(url.pathname, reqId);
  }

  return errorResponse(reqId, 404, "NOT_FOUND", "Not Found");
}

export function startServer() {
  const server = Deno.serve({ hostname: API_HOST, port: API_PORT }, appHandler);
  console.log(`Backend mode=${MODE} running at http://${API_HOST}:${API_PORT}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
