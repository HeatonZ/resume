import OpenAI from "npm:openai";
import type { ChatCompletionMessageParam } from "npm:openai/resources/chat/completions";
import type {
  ChatProvider,
  CreateProviderStreamParams,
  ProviderCompletionParams,
  ProviderConfig,
  ProviderError,
  ProviderMode,
  ProviderStreamEvent,
  ProviderStreamSession,
  StreamTelemetry,
} from "./types.ts";

function normalizeBaseUrl(baseURL: string) {
  return String(baseURL || "").replace(/\/+$/, "");
}

function createProviderError(
  message: string,
  code: string,
  extras: Record<string, unknown> = {},
): ProviderError {
  const error = new Error(message) as ProviderError;
  error.code = code;
  for (const [key, value] of Object.entries(extras)) {
    (error as unknown as Record<string, unknown>)[key] = value;
  }
  return error;
}

function isAbortLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("AbortError") || message.includes("cancelled") ||
    message.includes("aborted");
}

function parseErrorCode(error: unknown) {
  const asAny = error as { code?: string; status?: number };
  if (asAny?.code) return asAny.code;
  if (typeof asAny?.status === "number") return `HTTP_${asAny.status}`;
  return "PROVIDER_STREAM_FAILED";
}

function parseErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "provider stream failed");
}

function parseSseBlocks(buffer: string) {
  const blocks = buffer.split(/\r?\n\r?\n/);
  return {
    blocks: blocks.slice(0, -1),
    remaining: blocks.at(-1) || "",
  };
}

function parseSseData(block: string) {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trim());
  }
  return dataLines.join("\n");
}

async function* nativeStreamRunner(
  params: CreateProviderStreamParams,
): AsyncGenerator<ProviderStreamEvent> {
  const payload = {
    model: params.config.model,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    messages: params.messages,
    stream: true,
  };

  const response = await fetch(
    `${normalizeBaseUrl(params.config.baseURL)}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${params.config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: params.signal,
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw createProviderError(
      `${params.provider} native stream failed: HTTP ${response.status}`,
      "PROVIDER_NATIVE_HTTP_ERROR",
      { status: response.status, body },
    );
  }

  if (!response.body) {
    throw createProviderError(
      `${params.provider} native stream has no body`,
      "PROVIDER_NATIVE_NO_BODY",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const { blocks, remaining } = parseSseBlocks(buffer);
    buffer = remaining;

    for (const block of blocks) {
      const text = parseSseData(block.trim());
      if (!text) continue;
      if (text === "[DONE]") {
        yield { type: "done" };
        return;
      }

      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }

      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        yield { type: "token", delta };
      }

      if (json?.choices?.[0]?.finish_reason) {
        yield { type: "done" };
        return;
      }
    }
  }

  if (buffer.trim()) {
    const text = parseSseData(buffer.trim());
    if (text === "[DONE]") {
      yield { type: "done" };
      return;
    }
    try {
      const json = JSON.parse(text);
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        yield { type: "token", delta };
      }
    } catch {
      // Ignore trailing invalid chunks.
    }
  }

  yield { type: "done" };
}

async function* compatibleStreamRunner(
  params: CreateProviderStreamParams,
  client: OpenAI,
): AsyncGenerator<ProviderStreamEvent> {
  const stream = await client.chat.completions.create(
    {
      model: params.config.model,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      messages: params.messages,
      stream: true,
    },
    { signal: params.signal },
  );

  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      yield { type: "token", delta };
    }
  }

  yield { type: "done" };
}

export function resolveProvider(
  input: unknown,
  defaultProvider: ChatProvider,
): ChatProvider {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) return defaultProvider;
  if (normalized === "kimi" || normalized === "zhipu") return normalized;
  throw createProviderError(
    `Unsupported provider: ${normalized}`,
    "INVALID_PROVIDER",
  );
}

export function assertProviderConfig(config: ProviderConfig) {
  const missingFields: string[] = [];
  if (!config.apiKey) missingFields.push("apiKey");
  if (!config.baseURL) missingFields.push("baseURL");
  if (!config.model) missingFields.push("model");

  if (missingFields.length > 0) {
    throw createProviderError(
      `Provider config missing for ${config.provider}: ${
        missingFields.join(", ")
      }`,
      "MODEL_CONFIG_MISSING",
    );
  }
}

export function getProviderConfig(
  provider: ChatProvider,
  configs: Record<ChatProvider, ProviderConfig>,
): ProviderConfig {
  return configs[provider];
}

export function getOpenAIClient(
  config: ProviderConfig,
  cache: Map<string, OpenAI>,
) {
  const cacheKey = `${config.provider}|${config.baseURL}|${config.apiKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  cache.set(cacheKey, client);
  return client;
}

export function extractAssistantText(completion: any) {
  const choice = completion?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();

  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
    if (text) return text;
  }

  const refusal = choice?.message?.refusal;
  if (typeof refusal === "string" && refusal.trim()) return refusal.trim();

  if (
    typeof completion?.output_text === "string" && completion.output_text.trim()
  ) {
    return completion.output_text.trim();
  }

  return "";
}

export async function callCompatibleCompletion(
  params: ProviderCompletionParams,
  clientCache: Map<string, OpenAI>,
): Promise<string> {
  assertProviderConfig(params.config);
  const client = getOpenAIClient(params.config, clientCache);
  const completion = await client.chat.completions.create({
    model: params.config.model,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    messages: params.messages,
  });
  return extractAssistantText(completion);
}

type StreamRunner = (
  params: CreateProviderStreamParams,
) => AsyncGenerator<ProviderStreamEvent>;

export function createProviderStreamWithRunners(
  params: CreateProviderStreamParams,
  runners: {
    nativeRunner: StreamRunner;
    compatibleRunner: StreamRunner;
  },
): ProviderStreamSession {
  const telemetry: StreamTelemetry = {
    provider: params.provider,
    model: params.config.model,
    providerMode: "native",
    fallbackReason: null,
  };

  const stream = (async function* () {
    let emittedToken = false;

    try {
      telemetry.providerMode = "native";
      for await (const event of runners.nativeRunner(params)) {
        if (event.type === "token") emittedToken = true;
        yield event;
      }
      return;
    } catch (error) {
      if (params.signal?.aborted || isAbortLikeError(error)) {
        throw error;
      }
      if (emittedToken) {
        const message = parseErrorMessage(error);
        const code = parseErrorCode(error);
        yield { type: "error" as const, message, code };
        return;
      }

      telemetry.providerMode = "compatible";
      telemetry.fallbackReason = parseErrorCode(error);
    }

    try {
      for await (const event of runners.compatibleRunner(params)) {
        yield event;
      }
    } catch (error) {
      if (params.signal?.aborted || isAbortLikeError(error)) {
        throw error;
      }
      const message = parseErrorMessage(error);
      const code = parseErrorCode(error);
      yield { type: "error" as const, message, code };
    }
  })();

  return { telemetry, stream };
}

export function createProviderStream(
  params: CreateProviderStreamParams,
  clientCache: Map<string, OpenAI>,
): ProviderStreamSession {
  assertProviderConfig(params.config);
  const compatibleClient = getOpenAIClient(params.config, clientCache);

  return createProviderStreamWithRunners(params, {
    nativeRunner: (runnerParams) => nativeStreamRunner(runnerParams),
    compatibleRunner: (runnerParams) =>
      compatibleStreamRunner(runnerParams, compatibleClient),
  });
}

export function createProviderModeFromEnv(
  input: string | undefined,
): ProviderMode {
  return String(input || "").trim().toLowerCase() === "compatible"
    ? "compatible"
    : "native";
}

export type { ChatProvider, ProviderConfig, ProviderMode, ProviderStreamEvent };
