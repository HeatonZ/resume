import type { ChatCompletionMessageParam } from "npm:openai/resources/chat/completions";

export type ChatProvider = "kimi" | "zhipu";

export type ProviderMode = "native" | "compatible";

export type ProviderConfig = {
  provider: ChatProvider;
  apiKey: string;
  baseURL: string;
  model: string;
};

export type ProviderError = Error & {
  code?: string;
  status?: number;
};

export type ProviderStreamEvent =
  | { type: "token"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

export type CreateProviderStreamParams = {
  provider: ChatProvider;
  config: ProviderConfig;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
};

export type StreamTelemetry = {
  provider: ChatProvider;
  model: string;
  providerMode: ProviderMode;
  fallbackReason: string | null;
};

export type ProviderStreamSession = {
  telemetry: StreamTelemetry;
  stream: AsyncGenerator<ProviderStreamEvent>;
};

export type ProviderCompletionParams = {
  provider: ChatProvider;
  config: ProviderConfig;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
};
