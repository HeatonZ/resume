import { assertEquals } from "jsr:@std/assert";
import type { ChatCompletionMessageParam } from "npm:openai/resources/chat/completions";
import {
  type ChatProvider,
  createProviderStreamWithRunners,
  type ProviderConfig,
} from "./index.ts";

const baseConfig: ProviderConfig = {
  provider: "kimi",
  apiKey: "test",
  baseURL: "https://example.com/v1",
  model: "test-model",
};

function baseParams(provider: ChatProvider = "kimi") {
  return {
    provider,
    config: { ...baseConfig, provider },
    messages: [
      { role: "user", content: "hello" } as ChatCompletionMessageParam,
    ],
    temperature: 0.3,
    maxTokens: 128,
    signal: undefined,
  };
}

async function collectEvents(stream: AsyncGenerator<any>) {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

Deno.test("createProviderStreamWithRunners should emit native token sequence", async () => {
  const session = createProviderStreamWithRunners(baseParams(), {
    nativeRunner: async function* () {
      yield { type: "token", delta: "A" };
      yield { type: "token", delta: "B" };
      yield { type: "done" };
    },
    compatibleRunner: async function* () {
      yield { type: "error", message: "should not run", code: "UNEXPECTED" };
    },
  });

  const events = await collectEvents(session.stream);
  assertEquals(events, [
    { type: "token", delta: "A" },
    { type: "token", delta: "B" },
    { type: "done" },
  ]);
  assertEquals(session.telemetry.providerMode, "native");
  assertEquals(session.telemetry.fallbackReason, null);
});

Deno.test("createProviderStreamWithRunners should fallback before first token", async () => {
  const session = createProviderStreamWithRunners(baseParams("zhipu"), {
    nativeRunner: async function* () {
      throw Object.assign(new Error("native unsupported"), {
        code: "NATIVE_UNSUPPORTED",
      });
    },
    compatibleRunner: async function* () {
      yield { type: "token", delta: "C" };
      yield { type: "done" };
    },
  });

  const events = await collectEvents(session.stream);
  assertEquals(events, [
    { type: "token", delta: "C" },
    { type: "done" },
  ]);
  assertEquals(session.telemetry.providerMode, "compatible");
  assertEquals(session.telemetry.fallbackReason, "NATIVE_UNSUPPORTED");
});

Deno.test("createProviderStreamWithRunners should emit error when both native and compatible fail", async () => {
  const session = createProviderStreamWithRunners(baseParams(), {
    nativeRunner: async function* () {
      throw Object.assign(new Error("native failed"), { code: "NATIVE_DOWN" });
    },
    compatibleRunner: async function* () {
      throw Object.assign(new Error("compatible failed"), {
        code: "COMPATIBLE_DOWN",
      });
    },
  });

  const events = await collectEvents(session.stream);
  assertEquals(events, [{
    type: "error",
    message: "compatible failed",
    code: "COMPATIBLE_DOWN",
  }]);
  assertEquals(session.telemetry.providerMode, "compatible");
  assertEquals(session.telemetry.fallbackReason, "NATIVE_DOWN");
});

Deno.test("createProviderStreamWithRunners should emit error if native fails after token", async () => {
  const session = createProviderStreamWithRunners(baseParams(), {
    nativeRunner: async function* () {
      yield { type: "token", delta: "A" };
      throw Object.assign(new Error("native interrupted"), {
        code: "NATIVE_INTERRUPTED",
      });
    },
    compatibleRunner: async function* () {
      yield { type: "token", delta: "fallback" };
      yield { type: "done" };
    },
  });

  const events = await collectEvents(session.stream);
  assertEquals(events, [
    { type: "token", delta: "A" },
    {
      type: "error",
      message: "native interrupted",
      code: "NATIVE_INTERRUPTED",
    },
  ]);
  assertEquals(session.telemetry.providerMode, "native");
  assertEquals(session.telemetry.fallbackReason, null);
});
