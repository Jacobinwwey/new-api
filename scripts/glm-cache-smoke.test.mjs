import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminHeaders,
  buildCacheSmokeConfig,
  buildCacheUsageStatsURL,
  buildResponsesPayload,
  cacheKeyFingerprint,
  runCacheSmoke,
} from "./glm-cache-smoke.mjs";

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
  assert.match(summary.key_fp, /^[a-f0-9]{8}$/);
  assert.doesNotMatch(encoded, /fixture-relay-secret/);
  assert.doesNotMatch(encoded, /admin-token-secret/);
  assert.doesNotMatch(encoded, /session-secret/);
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/responses")).length, 3);
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
