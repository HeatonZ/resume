import { AbuseGuard, type GuardConfig } from "../backend/abuse_guard.ts";

type ActorPlan = {
  ip: string;
  requestsPerSecond: number;
  burstSeconds: number;
};

type PhaseResult = {
  label: string;
  total: number;
  allowed: number;
  rejected: number;
  blocked: number;
  windowLimited: number;
  dailyLimited: number;
  rejectRate: number;
  allowRate: number;
};

function buildConfig(overrides: Partial<GuardConfig>): GuardConfig {
  return {
    enabled: true,
    failOpen: false,
    windowSeconds: 60,
    maxRequestsPerWindow: 30,
    dailyMaxRequests: 800,
    blockThreshold: 3,
    blockDurationSeconds: 600,
    violationWindowSeconds: 300,
    maxMessageChars: 2000,
    maxHistoryItems: 12,
    maxOutputTokens: 700,
    streamMaxDurationSeconds: 90,
    ...overrides
  };
}

async function runPhase(label: string, config: GuardConfig, actors: ActorPlan[]): Promise<PhaseResult> {
  const kvPath = await Deno.makeTempFile({ suffix: ".sqlite3" });
  const kv = await Deno.openKv(kvPath);
  try {
    const guard = new AbuseGuard(config, kv);
    let total = 0;
    let allowed = 0;
    let rejected = 0;
    let blocked = 0;
    let windowLimited = 0;
    let dailyLimited = 0;

    const start = Date.parse("2026-03-11T00:00:00.000Z");
    for (const actor of actors) {
      for (let sec = 0; sec < actor.burstSeconds; sec += 1) {
        for (let i = 0; i < actor.requestsPerSecond; i += 1) {
          const now = new Date(start + sec * 1000 + i);
          const decision = await guard.evaluate(actor.ip, now);
          total += 1;
          if (decision.ok) {
            allowed += 1;
          } else {
            rejected += 1;
            if (decision.code === "IP_TEMP_BLOCKED") blocked += 1;
            if (decision.code === "RATE_LIMIT_EXCEEDED") windowLimited += 1;
            if (decision.code === "DAILY_QUOTA_EXCEEDED") dailyLimited += 1;
          }
        }
      }
    }

    return {
      label,
      total,
      allowed,
      rejected,
      blocked,
      windowLimited,
      dailyLimited,
      rejectRate: total > 0 ? rejected / total : 0,
      allowRate: total > 0 ? allowed / total : 0
    };
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
}

function printResult(result: PhaseResult) {
  console.log(
    [
      `phase=${result.label}`,
      `total=${result.total}`,
      `allowed=${result.allowed}`,
      `rejected=${result.rejected}`,
      `allowRate=${(result.allowRate * 100).toFixed(2)}%`,
      `rejectRate=${(result.rejectRate * 100).toFixed(2)}%`,
      `windowLimited=${result.windowLimited}`,
      `blocked=${result.blocked}`,
      `dailyLimited=${result.dailyLimited}`
    ].join(" | ")
  );
}

function assertCondition(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`SIM_ASSERT_FAILED: ${message}`);
  }
}

async function main() {
  // Simulate pre-release low traffic with loose thresholds (target: almost no false positives).
  const lowTrafficActors: ActorPlan[] = [
    { ip: "1.1.1.1", requestsPerSecond: 1, burstSeconds: 10 },
    { ip: "1.1.1.2", requestsPerSecond: 1, burstSeconds: 10 },
    { ip: "1.1.1.3", requestsPerSecond: 1, burstSeconds: 10 },
    { ip: "1.1.1.4", requestsPerSecond: 1, burstSeconds: 10 }
  ];
  const stagingLoose = await runPhase(
    "staging-loose",
    buildConfig({
      maxRequestsPerWindow: 60,
      dailyMaxRequests: 5000,
      blockThreshold: 6,
      blockDurationSeconds: 300
    }),
    lowTrafficActors
  );

  // Replay same production-like abusive traffic under progressively tightened thresholds.
  const mixedTrafficActors: ActorPlan[] = [
    { ip: "2.2.2.1", requestsPerSecond: 8, burstSeconds: 20 },
    { ip: "2.2.2.2", requestsPerSecond: 6, burstSeconds: 20 },
    { ip: "2.2.2.3", requestsPerSecond: 4, burstSeconds: 20 },
    { ip: "2.2.2.9", requestsPerSecond: 1, burstSeconds: 20 }
  ];

  const prodStage1 = await runPhase(
    "prod-stage-1",
    buildConfig({
      maxRequestsPerWindow: 25,
      dailyMaxRequests: 200,
      blockThreshold: 4,
      blockDurationSeconds: 300
    }),
    mixedTrafficActors
  );
  const prodStage2 = await runPhase(
    "prod-stage-2",
    buildConfig({
      maxRequestsPerWindow: 15,
      dailyMaxRequests: 120,
      blockThreshold: 3,
      blockDurationSeconds: 600
    }),
    mixedTrafficActors
  );
  const prodStage3 = await runPhase(
    "prod-stage-3",
    buildConfig({
      maxRequestsPerWindow: 10,
      dailyMaxRequests: 80,
      blockThreshold: 2,
      blockDurationSeconds: 900
    }),
    mixedTrafficActors
  );

  printResult(stagingLoose);
  printResult(prodStage1);
  printResult(prodStage2);
  printResult(prodStage3);

  // 5.2 acceptance: low traffic false positives should be very low.
  assertCondition(stagingLoose.rejectRate <= 0.02, "staging loose profile should keep rejectRate <= 2%");

  // 5.3 acceptance: progressively tightened thresholds should reduce allowed traffic.
  assertCondition(prodStage2.allowed < prodStage1.allowed, "stage-2 allowed requests should be lower than stage-1");
  assertCondition(prodStage3.allowed < prodStage2.allowed, "stage-3 allowed requests should be lower than stage-2");

  console.log("simulation=passed");
}

await main();
