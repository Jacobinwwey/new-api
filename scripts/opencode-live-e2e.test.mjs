import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildOpenCodeLiveE2EConfig,
  runOpenCodeLiveE2E,
} from "./opencode-live-e2e.mjs";

const LIVE_E2E_SCRIPT_PATH = fileURLToPath(
  new URL("./opencode-live-e2e.mjs", import.meta.url),
);

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
    opencode: { baseURL: "https://new-api.example.test", minActiveReadyAccounts: 1 },
    cacheSmoke: { model: "glm-5.2" },
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage({ route: "direct" });
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage({
          accounts: {
            active_ready: 1,
            activation_contract: {
              ready: 1,
            },
          },
        });
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
    [
      "tailscale_link",
      "opencode_preflight",
      "opencode_activation_contract_ready",
      "glm_cache_smoke",
    ],
  );
  assert.deepEqual(summary.acceptance, {
    status: "passed",
    mode: "production",
    production_ready: true,
    diagnostic_overrides: [],
    failed_checks: [],
  });
  assert.doesNotMatch(JSON.stringify(summary), /new-api\.example\.test|relay-key-secret|root-token-secret/);
});

test("runOpenCodeLiveE2E treats relaxed Tailscale gates as diagnostic acceptance", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: {
      target: "remote-box",
      ports: [],
      pingCount: 3,
      minPongs: 1,
      requireDirect: false,
      requireTun: false,
      requireTCP: false,
    },
    opencode: { minActiveReadyAccounts: 1 },
    cacheSmoke: {},
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage({
          checks: {
            status: "passed",
            items: [
              {
                name: "tailscale_direct_path",
                status: "passed",
                actual: "derp",
                expected: "direct",
              },
            ],
          },
        });
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage({
          accounts: {
            active_ready: 1,
            activation_contract: {
              ready: 1,
            },
          },
        });
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode", "cache"]);
  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "diagnostic",
    production_ready: false,
    diagnostic_overrides: [
      "tailscale_direct_check_disabled",
      "tailscale_tun_check_disabled",
      "tailscale_tcp_check_disabled",
      "tailscale_tcp_ports_empty",
      "tailscale_min_pongs_relaxed",
    ],
    failed_checks: [],
  });
});

test("runOpenCodeLiveE2E treats relaxed OpenCode gates as diagnostic acceptance", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: {
      minActiveReadyAccounts: 0,
      requireRoot: false,
      requireStableCredentialKey: false,
      requireAffinityStats: false,
    },
    cacheSmoke: { model: "glm-5.2" },
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage();
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage({
          accounts: {
            active_ready: 0,
            activation_contract: {},
          },
        });
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode", "cache"]);
  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "diagnostic",
    production_ready: false,
    diagnostic_overrides: [
      "opencode_root_auth_optional",
      "opencode_stable_credential_key_optional",
      "opencode_affinity_stats_optional",
      "opencode_active_ready_accounts_relaxed",
    ],
    failed_checks: [],
  });
});

test("runOpenCodeLiveE2E treats relaxed cache-smoke gates as diagnostic acceptance", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: { minActiveReadyAccounts: 1 },
    cacheSmoke: {
      model: "gpt-4.1",
      warmupRequestCount: 0,
      requestCount: 2,
      requireStats: false,
      skipStats: true,
      minRequestHitRate: 0.2,
      minStatsHitRate: 0.2,
      minCacheSignalTokens: 0,
    },
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage();
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage({
          accounts: {
            active_ready: 1,
            activation_contract: {
              ready: 1,
            },
          },
        });
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode", "cache"]);
  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "diagnostic",
    production_ready: false,
    diagnostic_overrides: [
      "cache_model_not_glm_5_2",
      "cache_stats_disabled",
      "cache_stats_optional",
      "cache_warmup_requests_relaxed",
      "cache_measured_requests_relaxed",
      "cache_request_hit_rate_relaxed",
      "cache_stats_hit_rate_relaxed",
      "cache_signal_tokens_relaxed",
    ],
    failed_checks: [],
  });
});

test("runOpenCodeLiveE2E fails when OpenCode activation-contract categories contradict readiness", async () => {
  const calls = [];
  const summary = await runOpenCodeLiveE2E({
    continueOnFailure: false,
    tailscale: { target: "remote-box" },
    opencode: { minActiveReadyAccounts: 1 },
    cacheSmoke: {},
    runners: {
      runTailscaleLinkPreflight: async () => {
        calls.push("tailscale");
        return passedStage();
      },
      runOpenCodePreflight: async () => {
        calls.push("opencode");
        return passedStage({
          accounts: {
            active_ready: 1,
            activation_contract: {
              codex_oauth_key_required: 1,
            },
          },
        });
      },
      runCacheSmoke: async () => {
        calls.push("cache");
        return passedStage();
      },
    },
  });

  assert.deepEqual(calls, ["tailscale", "opencode"]);
  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "production",
    production_ready: false,
    diagnostic_overrides: [],
    failed_checks: ["opencode_activation_contract_ready"],
  });
  assert.deepEqual(
    summary.checks.items.find((item) => item.name === "opencode_activation_contract_ready"),
    {
      name: "opencode_activation_contract_ready",
      status: "failed",
      actual: "missing",
      expected_min: 1,
    },
  );
  assert.deepEqual(summary.checks.items.at(-1), {
    name: "glm_cache_smoke",
    status: "skipped",
    actual: "skipped",
    expected: "passed",
    reason: "blocked_by_opencode_preflight",
  });
  assert.equal(summary.cache_smoke, null);
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
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "production",
    production_ready: false,
    diagnostic_overrides: [],
    failed_checks: ["tailscale_link"],
  });
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
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "diagnostic",
    production_ready: false,
    diagnostic_overrides: ["continue_on_failure"],
    failed_checks: ["tailscale_link", "opencode_preflight", "glm_cache_smoke"],
  });
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
  assert.deepEqual(summary.acceptance, {
    status: "failed",
    mode: "diagnostic",
    production_ready: false,
    diagnostic_overrides: ["skip_tailscale"],
    failed_checks: [],
  });
  assert.deepEqual(summary.checks.items[0], {
    name: "tailscale_link",
    status: "skipped",
    actual: "skipped",
    expected: "passed_or_explicitly_skipped",
    reason: "disabled",
  });
});

test("CLI exits non-zero when diagnostic overrides make acceptance non-production", async () => {
  let measuredRequests = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/status") {
      jsonResponse(response, { version: "test" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/opencode/accounts/diagnostics") {
      jsonResponse(response, {
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/opencode/accounts") {
      jsonResponse(response, {
        success: true,
        data: [
          {
            active: true,
            activation_ready: true,
            credential_integrity: "ok",
            credential_key_source: "crypto_secret",
            missing_activation_fields: [],
          },
        ],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/log/channel_affinity_usage_cache") {
      const keyFingerprint = url.searchParams.get("key_fp") || "";
      const isPreflightProbe = keyFingerprint === "00000000";
      jsonResponse(response, {
        success: true,
        data: {
          rule_name: url.searchParams.get("rule_name") || "",
          using_group: url.searchParams.get("using_group") || "",
          key_fp: keyFingerprint,
          hit: isPreflightProbe ? 0 : measuredRequests,
          total: isPreflightProbe ? 0 : measuredRequests,
          cached_tokens: isPreflightProbe ? 0 : measuredRequests,
          prompt_cache_hit_tokens: 0,
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      await consumeRequestBody(request);
      measuredRequests += 1;
      jsonResponse(response, {
        id: `response-${measuredRequests}`,
        usage: {
          input_tokens_details: {
            cached_tokens: 1,
          },
          input_tokens: 16,
          output_tokens: 1,
          total_tokens: 17,
        },
      });
      return;
    }
    jsonResponse(response, { success: false, message: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const child = spawn(
      process.execPath,
      [
        LIVE_E2E_SCRIPT_PATH,
        "--skip-tailscale",
        "true",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--warmup-requests",
        "0",
        "--requests",
        "2",
        "--delay-ms",
        "0",
        "--min-request-hit-rate",
        "1",
        "--min-stats-hit-rate",
        "1",
        "--min-cache-signal-tokens",
        "1",
      ],
      {
        env: {
          ...process.env,
          NEW_API_KEY: "relay-key-secret",
          NEW_API_ADMIN_TOKEN: "root-token-secret",
          NEW_API_ADMIN_USER_ID: "1",
          GLM_CACHE_SMOKE_KEY: "stable-cache-key",
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
    assert.equal(summary.checks.status, "passed");
    assert.deepEqual(summary.acceptance, {
      status: "failed",
      mode: "diagnostic",
      production_ready: false,
      diagnostic_overrides: [
        "skip_tailscale",
        "cache_warmup_requests_relaxed",
        "cache_measured_requests_relaxed",
      ],
      failed_checks: [],
    });
    assert.equal(summary.cache_smoke.requests.hit, 2);
    assert.doesNotMatch(stdout, /relay-key-secret|root-token-secret|stable-cache-key|127\.0\.0\.1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

function jsonResponse(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function consumeRequestBody(request) {
  for await (const _chunk of request) {
  }
}
