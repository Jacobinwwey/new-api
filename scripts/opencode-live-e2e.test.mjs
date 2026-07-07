import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenCodeLiveE2EConfig,
  runOpenCodeLiveE2E,
} from "./opencode-live-e2e.mjs";

test("buildOpenCodeLiveE2EConfig applies strict live defaults", () => {
  const config = buildOpenCodeLiveE2EConfig(
    [
      "node",
      "scripts/opencode-live-e2e.mjs",
      "--target",
      "remote-box",
      "--base-url",
      "https://new-api.example.test",
      "--ports",
      "3000,24800",
    ],
    {
      NEW_API_KEY: "relay-key-secret",
      NEW_API_ADMIN_TOKEN: "root-token-secret",
      NEW_API_ADMIN_USER_ID: "1",
      GLM_CACHE_SMOKE_KEY: "stable-cache-key",
    },
  );

  assert.equal(config.continueOnFailure, false);
  assert.equal(config.tailscale.target, "remote-box");
  assert.deepEqual(config.tailscale.ports, [3000, 24800]);
  assert.equal(config.opencode.minActiveReadyAccounts, 1);
  assert.equal(config.opencode.requireRoot, true);
  assert.equal(config.opencode.requireStableCredentialKey, true);
  assert.equal(config.opencode.requireAffinityStats, true);
  assert.equal(config.cacheSmoke.warmupRequestCount, 2);
  assert.equal(config.cacheSmoke.requestCount, 6);
  assert.equal(config.cacheSmoke.requireStats, true);
  assert.equal(config.cacheSmoke.minRequestHitRate, 0.8);
  assert.equal(config.cacheSmoke.minStatsHitRate, 0.8);
  assert.equal(config.cacheSmoke.minCacheSignalTokens, 1);
});

test("buildOpenCodeLiveE2EConfig defaults Tailscale ports to the New API service", () => {
  const config = buildOpenCodeLiveE2EConfig(
    [
      "node",
      "scripts/opencode-live-e2e.mjs",
      "--target",
      "remote-box",
      "--base-url",
      "https://new-api.example.test",
    ],
    {
      NEW_API_KEY: "relay-key-secret",
      NEW_API_ADMIN_TOKEN: "root-token-secret",
      NEW_API_ADMIN_USER_ID: "1",
      GLM_CACHE_SMOKE_KEY: "stable-cache-key",
    },
  );

  assert.deepEqual(config.tailscale.ports, [3000]);
});

test("runOpenCodeLiveE2E passes when all gates pass", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: { baseURL: "https://new-api.example.test" },
    cacheSmoke: { model: "glm-5.2" },
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage({ route: "direct" });
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage({ accounts: { active_ready: 1 } });
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage({ checks: { status: "passed", items: [] } });
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode", "cache"]);
  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(
    summary.checks.items.map((item) => item.name),
    ["tailscale_link", "opencode_preflight", "glm_cache_smoke"],
  );
  assert.doesNotMatch(JSON.stringify(summary), /new-api\.example\.test|relay-key-secret|root-token-secret/);
});

test("runOpenCodeLiveE2E stops before credentialed gates when Tailscale fails", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: {},
    cacheSmoke: {},
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return failedStage({ target: { found: true, expired: true } });
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage();
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["tailscale"]);
  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.opencode, null);
  assert.equal(summary.cache_smoke, null);
  assert.deepEqual(summary.checks.items, [
    {
      name: "tailscale_link",
      status: "failed",
      actual: "failed",
      expected: "passed_or_explicitly_skipped",
      reason: "",
    },
    {
      name: "opencode_preflight",
      status: "skipped",
      actual: "skipped",
      expected: "passed",
      reason: "blocked_by_tailscale",
    },
    {
      name: "glm_cache_smoke",
      status: "skipped",
      actual: "skipped",
      expected: "passed",
      reason: "blocked_by_tailscale",
    },
  ]);
});

test("runOpenCodeLiveE2E can continue after failures for diagnostics", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: true,
    tailscale: { target: "remote-box" },
    opencode: {},
    cacheSmoke: {},
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return failedStage({ target: { found: true, expired: true } });
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return failedStage({ accounts: { active_ready: 0 } });
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return failedStage({ stats: { status: "error" } });
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode", "cache"]);
  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(
    summary.checks.items.map((item) => [item.name, item.status]),
    [
      ["tailscale_link", "failed"],
      ["opencode_preflight", "failed"],
      ["glm_cache_smoke", "failed"],
    ],
  );
});

test("runOpenCodeLiveE2E fails when OpenCode readiness is skipped unexpectedly", async () => {
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: {},
    cacheSmoke: {},
    runners: {
      runTailscaleLinkPreflight: async () => passedStage(),
      runOpenCodePreflight: async () => skippedStage(),
      runCacheSmoke: async () => passedStage(),
    },
  });

  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(summary.checks.items, [
    {
      name: "tailscale_link",
      status: "passed",
      actual: "passed",
      expected: "passed_or_explicitly_skipped",
      reason: "",
    },
    {
      name: "opencode_preflight",
      status: "failed",
      actual: "skipped",
      expected: "passed",
      reason: "",
    },
    {
      name: "glm_cache_smoke",
      status: "skipped",
      actual: "skipped",
      expected: "passed",
      reason: "blocked_by_opencode_preflight",
    },
  ]);
});

test("runOpenCodeLiveE2E fails when cache smoke checks are skipped unexpectedly", async () => {
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: {},
    cacheSmoke: {},
    runners: {
      runTailscaleLinkPreflight: async () => passedStage(),
      runOpenCodePreflight: async () => passedStage(),
      runCacheSmoke: async () => skippedStage(),
    },
  });

  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(summary.checks.items.map((item) => [item.name, item.status, item.actual]), [
    ["tailscale_link", "passed", "passed"],
    ["opencode_preflight", "passed", "passed"],
    ["glm_cache_smoke", "failed", "skipped"],
  ]);
});

test("runOpenCodeLiveE2E redacts stage exceptions and keeps fail-fast semantics", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "private-tailnet-host" },
    opencode: {
      baseURL: "https://new-api.example.test",
      adminToken: "root-token-secret",
      adminCookie: "session=admin-cookie-secret",
    },
    cacheSmoke: {
      baseURL: "https://new-api.example.test",
      apiKey: "relay-key-secret",
      promptCacheKey: "stable-cache-key",
      input: "private prompt text for live e2e",
    },
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage();
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        throw new Error(
          `failed root-token-secret relay-key-secret stable-cache-key private-tailnet-host https://new-api.example.test api_key=x user@example.test tailnet=${"100"}.64.0.250 lan=${"192"}.168.255.250 C:\\Users\\operator\\secret`,
        );
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode"]);
  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.opencode.checks.status, "failed");
  assert.equal(summary.opencode.error.message.includes("<redacted>"), true);
  const serialized = JSON.stringify(summary);
  for (const fragment of [
    "root-token-secret",
    "relay-key-secret",
    "stable-cache-key",
    "private-tailnet-host",
    "new-api.example.test",
    "api_" + "key=x",
    "user@example.test",
    `${"100"}.64.0.250`,
    `${"192"}.168.255.250`,
    "C:\\Users\\operator\\secret",
  ]) {
    assert.equal(serialized.includes(fragment), false);
  }
  assert.equal(summary.cache_smoke, null);
});

test("runOpenCodeLiveE2E redacts successful stage summaries defensively", async () => {
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: true,
    tailscale: { target: "private-tailnet-host" },
    opencode: {
      baseURL: "https://new-api.example.test",
      adminToken: "root-token-secret",
      adminCookie: "session=admin-cookie-secret",
    },
    cacheSmoke: {
      baseURL: "https://new-api.example.test",
      apiKey: "relay-key-secret",
      promptCacheKey: "stable-cache-key",
      input: "private prompt text for live e2e",
    },
    runners: {
      runTailscaleLinkPreflight: async () =>
        passedStage({
          diagnostic: "private-tailnet-host via https://new-api.example.test",
        }),
      runOpenCodePreflight: async () =>
        passedStage({
          account: {
            ["root-token-secret"]: "secret key name",
            email: "user@example.test",
            tailnet: `${"100"}.64.0.250`,
            lan: `${"192"}.168.255.250`,
            path: "C:\\Users\\operator\\secret",
            token: "root-token-secret",
            notes: ["relay-key-secret", "stable-cache-key", "private prompt text for live e2e"],
          },
        }),
      runCacheSmoke: async () =>
        passedStage({
          usage: {
            total: 6,
            message: "Bearer " + "abcdefghijklmnop " + "api_" + "key=x",
          },
        }),
    },
  });

  assert.equal(summary.checks.status, "passed");
  assert.equal(summary.cache_smoke.usage.total, 6);
  const serialized = JSON.stringify(summary);
  for (const fragment of [
    "root-token-secret",
    "relay-key-secret",
    "stable-cache-key",
    "private-tailnet-host",
    "new-api.example.test",
    "private prompt text for live e2e",
    "Bearer " + "abcdefghijklmnop",
    "api_" + "key=x",
    "user@example.test",
    `${"100"}.64.0.250`,
    `${"192"}.168.255.250`,
    "C:\\Users\\operator\\secret",
  ]) {
    assert.equal(serialized.includes(fragment), false);
  }
});

test("runOpenCodeLiveE2E redacts prompt echo variants from stage summaries", async () => {
  const liveInput = [
    "cache prompt alpha line 001",
    "cache prompt beta line 002",
    "cache prompt gamma line 003",
  ].join("\n");
  const encodedInput = JSON.stringify(liveInput);
  const encodedInnerInput = encodedInput.slice(1, -1);
  const leakedFragments = [
    liveInput.slice(0, 44),
    encodedInput,
    encodedInnerInput,
    encodedInnerInput.slice(0, 44),
  ];

  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: true,
    tailscale: null,
    opencode: {},
    cacheSmoke: {
      input: liveInput,
    },
    runners: {
      runOpenCodePreflight: async () => passedStage(),
      runCacheSmoke: async () =>
        passedStage({
          upstream_error: {
            raw_prefix: leakedFragments[0],
            json_encoded: leakedFragments[1],
            json_inner: leakedFragments[2],
            json_inner_prefix: leakedFragments[3],
          },
        }),
    },
  });

  assert.equal(summary.checks.status, "passed");
  const serialized = JSON.stringify(summary);
  for (const fragment of leakedFragments) {
    assert.equal(serialized.includes(fragment), false);
  }
});

test("runOpenCodeLiveE2E supports explicitly skipped Tailscale for local diagnostics", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: null,
    opencode: {},
    cacheSmoke: {},
    runners: {
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage();
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["opencode", "cache"]);
  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(summary.checks.items[0], {
    name: "tailscale_link",
    status: "skipped",
    actual: "skipped",
    expected: "passed_or_explicitly_skipped",
    reason: "disabled",
  });
});

function passedStage(extra = {}) {
  return {
    ...extra,
    checks: {
      status: "passed",
      items: [],
      ...(extra.checks || {}),
    },
  };
}

function failedStage(extra = {}) {
  return {
    ...extra,
    checks: {
      status: "failed",
      items: [],
      ...(extra.checks || {}),
    },
  };
}

function skippedStage(extra = {}) {
  return {
    ...extra,
    checks: {
      status: "skipped",
      items: [],
      ...(extra.checks || {}),
    },
  };
}
