import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAdminHeaders,
  buildCacheSmokeConfig,
  buildCacheUsageStatsURL,
  buildDefaultCacheProbeInput,
  buildResponsesPayload,
  cacheKeyFingerprint,
  runCacheSmoke,
} from "./glm-cache-smoke.mjs";

const SMOKE_SCRIPT_PATH = fileURLToPath(new URL("./glm-cache-smoke.mjs", import.meta.url));

test("cacheKeyFingerprint returns the New API affinity fingerprint without exposing the key", () => {
  const key = "session-value-that-must-not-be-printed";

  const fingerprint = cacheKeyFingerprint(key);

  assert.equal(fingerprint.length, 8);
  assert.notEqual(fingerprint, key);
});

test("buildResponsesPayload keeps the cache key in the request body", () => {
  const payload = buildResponsesPayload({
    model: "glm-5.2",
    promptCacheKey: "session-123",
    input: "cache smoke prompt",
    maxOutputTokens: 32,
  });

  assert.deepEqual(payload, {
    model: "glm-5.2",
    input: "cache smoke prompt",
    prompt_cache_key: "session-123",
    max_output_tokens: 32,
  });
});

test("buildCacheSmokeConfig reads secrets from environment only", () => {
  const config = buildCacheSmokeConfig(
    [
      "node",
      "scripts/glm-cache-smoke.mjs",
      "--base-url",
      "https://new-api.example.test/",
      "--requests",
      "3",
      "--warmup-requests",
      "2",
      "--require-stats",
      "true",
      "--min-request-hit-rate",
      "0.5",
      "--min-stats-hit-rate",
      "0.75",
      "--min-cache-signal-tokens",
      "128",
    ],
    {
      NEW_API_KEY: "fixture-relay-secret",
      NEW_API_ADMIN_TOKEN: "admin-token-secret",
      NEW_API_ADMIN_USER_ID: "1",
      GLM_CACHE_SMOKE_KEY: "session-secret",
    },
  );

  assert.equal(config.baseURL, "https://new-api.example.test");
  assert.equal(config.apiKey, "fixture-relay-secret");
  assert.equal(config.adminToken, "admin-token-secret");
  assert.equal(config.adminUserID, "1");
  assert.equal(config.promptCacheKey, "session-secret");
  assert.equal(config.requestCount, 3);
  assert.equal(config.warmupRequestCount, 2);
  assert.equal(config.requireStats, true);
  assert.equal(config.minRequestHitRate, 0.5);
  assert.equal(config.minStatsHitRate, 0.75);
  assert.equal(config.minCacheSignalTokens, 128);
});

test("buildCacheSmokeConfig rejects invalid smoke expectation thresholds", () => {
  assert.throws(
    () =>
      buildCacheSmokeConfig(
        [
          "node",
          "scripts/glm-cache-smoke.mjs",
          "--base-url",
          "https://new-api.example.test",
          "--min-request-hit-rate",
          "1.5",
        ],
        {
          NEW_API_KEY: "fixture-relay-secret",
        },
      ),
    /min-request-hit-rate must be a number between 0 and 1/,
  );
});

test("buildCacheSmokeConfig defaults to a deterministic cacheable probe input", () => {
  const config = buildCacheSmokeConfig(
    ["node", "scripts/glm-cache-smoke.mjs", "--base-url", "https://new-api.example.test"],
    {
      NEW_API_KEY: "fixture-relay-secret",
    },
  );

  assert.equal(config.input, buildDefaultCacheProbeInput());
  assert.ok(config.input.length > 8000);
  assert.match(config.input, /cache-probe-line-096/);
});

test("buildCacheSmokeConfig lets explicit input override the cache probe", () => {
  const config = buildCacheSmokeConfig(
    [
      "node",
      "scripts/glm-cache-smoke.mjs",
      "--base-url",
      "https://new-api.example.test",
      "--input",
      "custom prompt",
    ],
    {
      NEW_API_KEY: "fixture-relay-secret",
    },
  );

  assert.equal(config.input, "custom prompt");
});

test("buildAdminHeaders supports token and cookie auth without mixing relay keys", () => {
  assert.deepEqual(
    buildAdminHeaders({
      adminToken: "admin-token-secret",
      adminCookie: "",
      adminUserID: "1",
    }),
    {
      Authorization: "admin-token-secret",
      "New-Api-User": "1",
    },
  );

  assert.deepEqual(
    buildAdminHeaders({
      adminToken: "",
      adminCookie: "session=abc",
      adminUserID: "2",
    }),
    {
      Cookie: "session=abc",
      "New-Api-User": "2",
    },
  );
});

test("buildCacheUsageStatsURL addresses the channel-affinity stats endpoint", () => {
  const url = buildCacheUsageStatsURL("https://new-api.example.test/", {
    ruleName: "codex cli trace",
    usingGroup: "default",
    keyFingerprint: "abcdef12",
  });

  assert.equal(
    url,
    "https://new-api.example.test/api/log/channel_affinity_usage_cache?rule_name=codex+cli+trace&using_group=default&key_fp=abcdef12",
  );
});

test("runCacheSmoke never returns raw secrets in the summary", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({
        success: true,
        data: {
          rule_name: "codex cli trace",
          using_group: "default",
          key_fp: "deadbeef",
          hit: 2,
          total: 3,
          cached_tokens: 128,
          prompt_cache_hit_tokens: 128,
        },
      });
    }
    return jsonResponse({
      id: "resp_1",
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
      },
    });
  };

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "admin-token-secret",
    adminCookie: "",
    adminUserID: "1",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 3,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    fetcher,
  });

  const encoded = JSON.stringify(summary);
  assert.equal(summary.requests.total, 3);
  assert.equal(summary.stats.status, "ok");
  assert.equal(summary.stats.data.cached_tokens, 128);
  assert.equal(summary.checks.status, "skipped");
  assert.match(summary.key_fp, /^[a-f0-9]{8}$/);
  assert.doesNotMatch(encoded, /fixture-relay-secret/);
  assert.doesNotMatch(encoded, /admin-token-secret/);
  assert.doesNotMatch(encoded, /session-secret/);
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/responses")).length, 3);
});

test("runCacheSmoke rejects business failures from relay responses with redaction", async () => {
  const fetcher = async () =>
    jsonResponse({
      success: false,
      message: "relay rejected fixture-relay-secret for session-secret",
    });

  await assert.rejects(
    runCacheSmoke({
      baseURL: "https://new-api.example.test",
      apiKey: "fixture-relay-secret",
      adminToken: "",
      adminCookie: "",
      adminUserID: "",
      model: "glm-5.2",
      promptCacheKey: "session-secret",
      input: "cache smoke prompt",
      maxOutputTokens: 16,
      requestCount: 2,
      requestDelayMs: 0,
      usingGroup: "default",
      ruleName: "codex cli trace",
      timeoutMs: 1000,
      fetcher,
    }),
    (error) => {
      const message = String(error.message || "");
      assert.match(message, /relay rejected/);
      assert.doesNotMatch(message, /response is not JSON/);
      assert.doesNotMatch(message, /fixture-relay-secret/);
      assert.doesNotMatch(message, /session-secret/);
      return true;
    },
  );
});

test("runCacheSmoke reports usage-cache deltas for the current smoke run", async () => {
  let statsReads = 0;
  const fetcher = async (url) => {
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      statsReads += 1;
      return jsonResponse({
        success: true,
        data:
          statsReads === 1
            ? {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 5,
                total: 8,
                cached_tokens: 256,
                prompt_cache_hit_tokens: 128,
                prompt_tokens: 1024,
              }
            : {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 7,
                total: 10,
                cached_tokens: 768,
                prompt_cache_hit_tokens: 384,
                prompt_tokens: 2048,
              },
      });
    }
    return jsonResponse({
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
      },
    });
  };

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "admin-token-secret",
    adminCookie: "",
    adminUserID: "1",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 2,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    fetcher,
  });

  assert.equal(statsReads, 2);
  assert.equal(summary.stats.status, "ok");
  assert.equal(summary.stats.baseline.cached_tokens, 256);
  assert.equal(summary.stats.data.cached_tokens, 768);
  assert.deepEqual(summary.stats.delta, {
    hit: 2,
    total: 2,
    cached_tokens: 512,
    prompt_cache_hit_tokens: 256,
    prompt_tokens: 1024,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

test("runCacheSmoke measures deltas after warmup requests", async () => {
  const calls = [];
  let statsReads = 0;
  let responseReads = 0;
  const fetcher = async (url) => {
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      statsReads += 1;
      calls.push("stats");
      return jsonResponse({
        success: true,
        data:
          statsReads === 1
            ? {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 2,
                total: 2,
                cached_tokens: 64,
              }
            : {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 4,
                total: 4,
                cached_tokens: 192,
              },
      });
    }
    responseReads += 1;
    calls.push("response");
    return jsonResponse({
      usage: {
        input_tokens: 20,
        input_tokens_details: {
          cached_tokens: responseReads <= 2 ? 0 : 8,
        },
      },
    });
  };

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "admin-token-secret",
    adminCookie: "",
    adminUserID: "1",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 2,
    warmupRequestCount: 2,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    fetcher,
  });

  assert.deepEqual(calls, ["response", "response", "stats", "response", "response", "stats"]);
  assert.equal(summary.warmup.total, 2);
  assert.equal(summary.warmup.hit, 0);
  assert.equal(summary.requests.total, 2);
  assert.equal(summary.requests.hit, 2);
  assert.deepEqual(summary.stats.delta, {
    hit: 2,
    total: 2,
    cached_tokens: 128,
    prompt_cache_hit_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

test("runCacheSmoke passes configured cache-hit checks when measured signals meet thresholds", async () => {
  let statsReads = 0;
  const fetcher = async (url) => {
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      statsReads += 1;
      return jsonResponse({
        success: true,
        data:
          statsReads === 1
            ? {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 10,
                total: 20,
                cached_tokens: 1000,
              }
            : {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 14,
                total: 24,
                cached_tokens: 1400,
              },
      });
    }
    return jsonResponse({
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 12 },
      },
    });
  };

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "admin-token-secret",
    adminCookie: "",
    adminUserID: "1",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 4,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    minRequestHitRate: 0.75,
    requireStats: true,
    minStatsHitRate: 0.75,
    minCacheSignalTokens: 256,
    fetcher,
  });

  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(
    summary.checks.items.map((item) => item.name),
    ["request_hit_rate", "stats_available", "stats_hit_rate", "cache_signal_tokens"],
  );
});

test("runCacheSmoke fails configured checks for low request hit rate", async () => {
  const fetcher = async () =>
    jsonResponse({
      usage: {
        input_tokens: 20,
      },
    });

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "",
    adminCookie: "",
    adminUserID: "",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 2,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    minRequestHitRate: 0.5,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(summary.checks.items[0], {
    name: "request_hit_rate",
    status: "failed",
    actual: 0,
    expected_min: 0.5,
  });
});

test("runCacheSmoke fails configured checks when required stats are unavailable", async () => {
  const fetcher = async () =>
    jsonResponse({
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 10 },
      },
    });

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "",
    adminCookie: "",
    adminUserID: "",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 2,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    requireStats: true,
    minStatsHitRate: 0.5,
    fetcher,
  });

  assert.equal(summary.stats.status, "skipped");
  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.checks.items[0].name, "stats_available");
  assert.equal(summary.checks.items[0].reason, "missing_admin_auth");
});

test("CLI exits non-zero after printing summary when configured checks fail", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/responses") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ usage: { input_tokens: 20 } }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const child = spawn(
      process.execPath,
      [
        SMOKE_SCRIPT_PATH,
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--requests",
        "2",
        "--delay-ms",
        "0",
        "--min-request-hit-rate",
        "0.5",
      ],
      {
        env: {
          ...process.env,
          NEW_API_KEY: "fixture-relay-secret",
          NEW_API_ADMIN_TOKEN: "",
          NEW_API_ADMIN_COOKIE: "",
          NEW_API_ADMIN_USER_ID: "",
          GLM_CACHE_SMOKE_KEY: "session-secret",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.equal(stderr, "");
    const summary = JSON.parse(stdout);
    assert.equal(summary.checks.status, "failed");
    assert.equal(summary.checks.items[0].name, "request_hit_rate");
    assert.doesNotMatch(stdout, /fixture-relay-secret/);
    assert.doesNotMatch(stdout, /session-secret/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runCacheSmoke clamps usage-cache deltas when counters reset", async () => {
  let statsReads = 0;
  const fetcher = async (url) => {
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      statsReads += 1;
      return jsonResponse({
        success: true,
        data:
          statsReads === 1
            ? {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 9,
                total: 10,
                cached_tokens: 1024,
                prompt_cache_hit_tokens: 512,
                prompt_tokens: 4096,
              }
            : {
                rule_name: "codex cli trace",
                using_group: "default",
                key_fp: "deadbeef",
                hit: 1,
                total: 1,
                cached_tokens: 64,
                prompt_cache_hit_tokens: 32,
                prompt_tokens: 128,
              },
      });
    }
    return jsonResponse({
      usage: {
        input_tokens: 10,
      },
    });
  };

  const summary = await runCacheSmoke({
    baseURL: "https://new-api.example.test",
    apiKey: "fixture-relay-secret",
    adminToken: "admin-token-secret",
    adminCookie: "",
    adminUserID: "1",
    model: "glm-5.2",
    promptCacheKey: "session-secret",
    input: "cache smoke prompt",
    maxOutputTokens: 16,
    requestCount: 1,
    requestDelayMs: 0,
    usingGroup: "default",
    ruleName: "codex cli trace",
    timeoutMs: 1000,
    fetcher,
  });

  assert.equal(statsReads, 2);
  assert.equal(summary.stats.reset_detected, true);
  assert.deepEqual(summary.stats.delta, {
    hit: 0,
    total: 0,
    cached_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
