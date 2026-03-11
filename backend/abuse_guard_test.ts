import { assertEquals } from "jsr:@std/assert";
import { AbuseGuard, extractClientIp, type GuardConfig, validateChatInput } from "./abuse_guard.ts";

function testConfig(): GuardConfig {
  return {
    enabled: true,
    failOpen: false,
    windowSeconds: 60,
    maxRequestsPerWindow: 2,
    dailyMaxRequests: 10,
    blockThreshold: 2,
    blockDurationSeconds: 1,
    violationWindowSeconds: 60,
    maxMessageChars: 10,
    maxHistoryItems: 2,
    maxOutputTokens: 128,
    streamMaxDurationSeconds: 10
  };
}

Deno.test("validateChatInput should reject oversize message and history", async () => {
  const cfg = testConfig();
  const tooLong = await validateChatInput("12345678901", 0, cfg);
  assertEquals(tooLong.ok, false);
  assertEquals(tooLong.code, "MESSAGE_TOO_LARGE");

  const tooManyHistory = await validateChatInput("ok", 3, cfg);
  assertEquals(tooManyHistory.ok, false);
  assertEquals(tooManyHistory.code, "HISTORY_TOO_LARGE");
});

Deno.test("extractClientIp should prioritize x-forwarded-for first IP", () => {
  const request = new Request("https://example.com", {
    headers: {
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      "x-real-ip": "9.9.9.9"
    }
  });
  assertEquals(extractClientIp(request), "1.2.3.4");
});

Deno.test("AbuseGuard should rate-limit and then temporarily block abusive IP", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".sqlite3" });
  const kv = await Deno.openKv(kvPath);
  try {
    const guard = new AbuseGuard(testConfig(), kv);
    const ip = "10.0.0.1";
    const now = new Date("2026-01-01T00:00:00.000Z");

    const first = await guard.evaluate(ip, now);
    assertEquals(first.ok, true);
    const second = await guard.evaluate(ip, now);
    assertEquals(second.ok, true);

    const third = await guard.evaluate(ip, now);
    assertEquals(third.ok, false);
    assertEquals(third.code, "RATE_LIMIT_EXCEEDED");

    let blockedCode = "";
    for (let i = 0; i < 4; i += 1) {
      const result = await guard.evaluate(ip, now);
      if (result.code === "IP_TEMP_BLOCKED") {
        blockedCode = result.code;
        break;
      }
    }
    assertEquals(blockedCode, "IP_TEMP_BLOCKED");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
