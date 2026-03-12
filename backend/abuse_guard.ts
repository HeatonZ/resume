export type GuardConfig = {
  enabled: boolean;
  failOpen: boolean;
  windowSeconds: number;
  maxRequestsPerWindow: number;
  dailyMaxRequests: number;
  blockThreshold: number;
  blockDurationSeconds: number;
  violationWindowSeconds: number;
  maxMessageChars: number;
  maxHistoryItems: number;
  maxOutputTokens: number;
  streamMaxDurationSeconds: number;
  streamFirstTokenMaxLatencyMs: number;
  streamMinTokenEvents: number;
};

export type GuardDecision = {
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
  retryAfter?: number;
  limitType?: "blocked" | "window" | "daily" | "backend";
  remaining?: number;
};

function toPositiveInt(value: string | undefined, fallback: number, min = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.floor(parsed);
  return asInt < min ? fallback : asInt;
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadGuardConfig(
  getEnv: (name: string) => string | undefined,
): GuardConfig {
  return {
    enabled: parseBooleanEnv(getEnv("RATE_LIMIT_ENABLED"), true),
    failOpen: parseBooleanEnv(getEnv("RATE_LIMIT_FAIL_OPEN"), false),
    windowSeconds: toPositiveInt(getEnv("RATE_LIMIT_WINDOW_SECONDS"), 60),
    maxRequestsPerWindow: toPositiveInt(getEnv("RATE_LIMIT_MAX_REQUESTS"), 80),
    dailyMaxRequests: toPositiveInt(
      getEnv("RATE_LIMIT_DAILY_MAX_REQUESTS"),
      5000,
    ),
    blockThreshold: toPositiveInt(getEnv("RATE_LIMIT_BLOCK_THRESHOLD"), 8),
    blockDurationSeconds: toPositiveInt(
      getEnv("RATE_LIMIT_BLOCK_DURATION_SECONDS"),
      600,
    ),
    violationWindowSeconds: toPositiveInt(
      getEnv("RATE_LIMIT_VIOLATION_WINDOW_SECONDS"),
      300,
    ),
    maxMessageChars: toPositiveInt(getEnv("CHAT_MAX_MESSAGE_CHARS"), 12000),
    maxHistoryItems: toPositiveInt(getEnv("CHAT_MAX_HISTORY_ITEMS"), 20),
    maxOutputTokens: toPositiveInt(getEnv("CHAT_MAX_OUTPUT_TOKENS"), 2048),
    streamMaxDurationSeconds: toPositiveInt(
      getEnv("CHAT_STREAM_MAX_DURATION_SECONDS"),
      90,
    ),
    streamFirstTokenMaxLatencyMs: toPositiveInt(
      getEnv("CHAT_STREAM_FIRST_TOKEN_MAX_LATENCY_MS"),
      5000,
    ),
    streamMinTokenEvents: toPositiveInt(
      getEnv("CHAT_STREAM_MIN_TOKEN_EVENTS"),
      2,
    ),
  };
}

export function validateIpCandidate(input: string) {
  const normalized = input.trim().replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
  if (!normalized) return "";
  if (normalized.length > 64) return "";
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(normalized)) return normalized;
  if (/^[0-9a-fA-F:]+$/.test(normalized) && normalized.includes(":")) {
    return normalized.toLowerCase();
  }
  return "";
}

export function extractClientIp(
  request: Request,
  remoteAddr?: Deno.Addr | null,
) {
  const candidates = [
    request.headers.get("x-forwarded-for")?.split(",")[0] || "",
    request.headers.get("cf-connecting-ip") || "",
    request.headers.get("x-real-ip") || "",
    request.headers.get("fly-client-ip") || "",
  ];

  if (remoteAddr && remoteAddr.transport === "tcp") {
    candidates.push(remoteAddr.hostname);
  }

  for (const candidate of candidates) {
    const normalized = validateIpCandidate(candidate);
    if (normalized) return normalized;
  }
  return "unknown";
}

function minuteBucket(now: Date, windowSeconds: number) {
  const slot = Math.floor(now.getTime() / 1000 / windowSeconds);
  return `${slot}`;
}

function dayBucket(now: Date) {
  return now.toISOString().slice(0, 10);
}

function secondsUntilNextWindow(now: Date, windowSeconds: number) {
  const currentSeconds = Math.floor(now.getTime() / 1000);
  const elapsed = currentSeconds % windowSeconds;
  return Math.max(1, windowSeconds - elapsed);
}

async function atomicIncrement(
  kv: Deno.Kv,
  key: Deno.KvKey,
  expireIn: number,
  attempts = 5,
): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const current = await kv.get<number>(key);
    const nextValue = Number(current.value || 0) + 1;
    const committed = await kv
      .atomic()
      .check(current)
      .set(key, nextValue, { expireIn })
      .commit();
    if (committed.ok) return nextValue;
  }
  throw new Error("KV_ATOMIC_INCREMENT_FAILED");
}

export async function validateChatInput(
  userMessage: string,
  historyCount: number,
  config: GuardConfig,
): Promise<GuardDecision> {
  if (!userMessage) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_REQUEST",
      message: "message 不能为空",
    };
  }
  if (userMessage.length > config.maxMessageChars) {
    return {
      ok: false,
      status: 400,
      code: "MESSAGE_TOO_LARGE",
      message: `message 超出限制，最大 ${config.maxMessageChars} 字符`,
    };
  }
  if (historyCount > config.maxHistoryItems) {
    return {
      ok: false,
      status: 400,
      code: "HISTORY_TOO_LARGE",
      message: `history 超出限制，最大 ${config.maxHistoryItems} 条`,
    };
  }
  return { ok: true };
}

export class AbuseGuard {
  constructor(
    private readonly config: GuardConfig,
    private readonly kv: Deno.Kv | null,
  ) {}

  async evaluate(ip: string, now = new Date()): Promise<GuardDecision> {
    if (!this.config.enabled) return { ok: true };
    if (!this.kv) {
      if (this.config.failOpen) return { ok: true };
      return {
        ok: false,
        status: 503,
        code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
        message: "限流服务暂时不可用，请稍后重试",
        limitType: "backend",
      };
    }

    if (!ip || ip === "unknown") {
      return { ok: true };
    }

    const blockKey: Deno.KvKey = ["guard", "block", ip];
    const blocked = await this.kv.get<{ until: number; reason: string }>(
      blockKey,
    );
    if (blocked.value && blocked.value.until > now.getTime()) {
      const retryAfter = Math.max(
        1,
        Math.ceil((blocked.value.until - now.getTime()) / 1000),
      );
      return {
        ok: false,
        status: 429,
        code: "IP_TEMP_BLOCKED",
        message: "请求过于频繁，IP 已被临时封禁",
        retryAfter,
        limitType: "blocked",
      };
    }

    const windowKey: Deno.KvKey = [
      "guard",
      "window",
      ip,
      minuteBucket(now, this.config.windowSeconds),
    ];
    const dayKey: Deno.KvKey = ["guard", "day", ip, dayBucket(now)];
    const windowCount = await atomicIncrement(
      this.kv,
      windowKey,
      (this.config.windowSeconds + 5) * 1000,
    );
    const dayCount = await atomicIncrement(
      this.kv,
      dayKey,
      48 * 60 * 60 * 1000,
    );

    if (windowCount > this.config.maxRequestsPerWindow) {
      const retryAfter = secondsUntilNextWindow(now, this.config.windowSeconds);
      await this.recordViolation(ip, now, "window_limit");
      return {
        ok: false,
        status: 429,
        code: "RATE_LIMIT_EXCEEDED",
        message: "请求过于频繁，请稍后重试",
        retryAfter,
        limitType: "window",
        remaining: 0,
      };
    }

    if (dayCount > this.config.dailyMaxRequests) {
      await this.recordViolation(ip, now, "daily_quota");
      const endOfDay = new Date(now);
      endOfDay.setUTCHours(24, 0, 0, 0);
      const retryAfter = Math.max(
        1,
        Math.ceil((endOfDay.getTime() - now.getTime()) / 1000),
      );
      return {
        ok: false,
        status: 429,
        code: "DAILY_QUOTA_EXCEEDED",
        message: "今日调用额度已用完，请明天再试",
        retryAfter,
        limitType: "daily",
        remaining: 0,
      };
    }

    return {
      ok: true,
      remaining: Math.max(0, this.config.maxRequestsPerWindow - windowCount),
    };
  }

  private async recordViolation(ip: string, now: Date, reason: string) {
    if (!this.kv) return;
    const key: Deno.KvKey = ["guard", "violation", ip];
    const count = await atomicIncrement(
      this.kv,
      key,
      this.config.violationWindowSeconds * 1000,
    );
    if (count < this.config.blockThreshold) return;

    const until = now.getTime() + this.config.blockDurationSeconds * 1000;
    await this.kv.set(["guard", "block", ip], { until, reason }, {
      expireIn: this.config.blockDurationSeconds * 1000,
    });
  }
}
