import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildOpenCodePreflightConfig,
  runOpenCodePreflight,
} from "./opencode-e2e-preflight.mjs";

const PREFLIGHT_SCRIPT_PATH = fileURLToPath(
  new URL("./opencode-e2e-preflight.mjs", import.meta.url),
);

test("buildOpenCodePreflightConfig reads root auth from environment only", () => {
  const config = buildOpenCodePreflightConfig(
    [
      "node",
      "scripts/opencode-e2e-preflight.mjs",
      "--base-url",
      "https://new-api.example.test/",
      "--require-root",
      "true",
      "--require-stable-credential-key",
      "false",
      "--require-affinity-stats",
      "false",
      "--min-activation-ready-accounts",
      "2",
      "--min-active-accounts",
      "1",
      "--min-active-ready-accounts",
      "1",
    ],
    {
      NEW_API_ADMIN_TOKEN: "root-token-secret",
      NEW_API_ADMIN_USER_ID: "1",
    },
  );

  assert.equal(config.baseURL, "https://new-api.example.test");
  assert.equal(config.adminToken, "root-token-secret");
  assert.equal(config.adminUserID, "1");
  assert.equal(config.requireRoot, true);
  assert.equal(config.requireStableCredentialKey, false);
  assert.equal(config.requireAffinityStats, false);
  assert.equal(config.minActivationReadyAccounts, 2);
  assert.equal(config.minActiveAccounts, 1);
  assert.equal(config.minActiveReadyAccounts, 1);
});

test("runOpenCodePreflight fails when root auth is required but missing", async () => {
  const fetcher = async () =>
    jsonResponse({
      version: "test",
    });

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "",
    adminCookie: "",
    adminUserID: "",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(summary.checks.items[1], {
    name: "root_auth_configured",
    status: "failed",
    actual: "missing",
    expected: "configured",
  });
});

test("runOpenCodePreflight passes stable diagnostics and summarizes accounts without secrets", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({
        success: true,
        data: [
          {
            id: 1,
            label: "ready",
            active: true,
            activation_ready: true,
            credential_integrity: "ok",
            credential_key_source: "crypto_secret",
            email_masked: "u***@example.test",
            missing_activation_fields: [],
          },
          {
            id: 2,
            label: "missing",
            active: false,
            activation_ready: false,
            credential_integrity: "decrypt_failed: opencode-api-key-controller-test",
            credential_key_source: "session_secret_fallback",
            email_masked: "",
            missing_activation_fields: [`api_${"key"}`, "channel_id"],
          },
          {
            id: 3,
            label: "codex-plain-key",
            active: false,
            activation_ready: false,
            credential_integrity: "ok",
            credential_key_source: "crypto_secret",
            email_masked: "",
            has_api_key: true,
            missing_activation_fields: ["codex_oauth_key"],
          },
        ],
      });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({
        success: true,
        data: {
          rule_name: "codex cli trace",
          using_group: "default",
          key_fp: "00000000",
          hit: 0,
          total: 0,
        },
      });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 1,
    minActiveAccounts: 1,
    minActiveReadyAccounts: 1,
    fetcher,
  });

  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(summary.diagnostics, {
    credential_key_source: "crypto_secret",
    uses_fallback_credential_key: false,
  });
  assert.deepEqual(summary.accounts, {
    total: 3,
    active: 1,
    active_ready: 1,
    activation_ready: 1,
    activation_ready_inconsistent: 0,
    credential_integrity: {
      ok: 2,
      decrypt_failed: 1,
    },
    credential_key_source: {
      crypto_secret: 2,
      session_secret_fallback: 1,
    },
    activation_contract: {
      ready: 1,
      decrypt_failed: 1,
      codex_oauth_key_required: 1,
    },
    missing_activation_fields: {
      credential: 2,
      channel: 1,
    },
  });
  assert.equal(Object.hasOwn(summary, "base_url"), false);
  assert.equal(summary.endpoints.affinity_usage_stats.status, "ok");
  assert.deepEqual(summary.affinity_usage_stats, {
    rule_name: "codex cli trace",
    using_group: "default",
    key_fp: "00000000",
  });
  assert.equal(calls[1].headers.Authorization, "root-token-secret");
  assert.equal(calls[1].headers["New-Api-User"], "1");
  const encoded = JSON.stringify(summary);
  assert.doesNotMatch(encoded, /root-token-secret/);
  assert.doesNotMatch(encoded, /u\*\*\*@example\.test/);
  assert.doesNotMatch(encoded, /api_key/);
  assert.match(encoded, /codex_oauth_key_required/);
  assert.doesNotMatch(encoded, /opencode-api-key-controller-test/);
  assert.doesNotMatch(encoded, /new-api\.example\.test/);
});

test("runOpenCodePreflight fails when no single account is both active and activation-ready", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({
        success: true,
        data: [
          {
            active: true,
            activation_ready: false,
            credential_integrity: "decrypt_failed",
            missing_activation_fields: [`api_${"key"}`],
          },
          {
            active: false,
            activation_ready: true,
            credential_integrity: "ok",
            missing_activation_fields: [],
          },
        ],
      });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({ success: true, data: {} });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 1,
    minActiveAccounts: 1,
    minActiveReadyAccounts: 1,
    fetcher,
  });

  assert.equal(summary.accounts.active, 1);
  assert.equal(summary.accounts.activation_ready, 1);
  assert.equal(summary.accounts.active_ready, 0);
  assert.equal(summary.accounts.activation_ready_inconsistent, 0);
  assert.equal(summary.checks.status, "failed");
  const activeReadyCheck = summary.checks.items.find(
    (item) => item.name === "active_ready_accounts",
  );
  assert.deepEqual(activeReadyCheck, {
    name: "active_ready_accounts",
    status: "failed",
    actual: 0,
    expected_min: 1,
  });
  assert.doesNotMatch(JSON.stringify(summary), /api_key/);
});

test("runOpenCodePreflight rejects inconsistent active-ready account payloads", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({
        success: true,
        data: [
          {
            active: true,
            activation_ready: true,
            credential_integrity: "decrypt_failed",
            missing_activation_fields: [`api_${"key"}`],
          },
        ],
      });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({
        success: true,
        data: {
          rule_name: "codex cli trace",
          using_group: "default",
          key_fp: "00000000",
        },
      });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActiveReadyAccounts: 1,
    fetcher,
  });

  assert.equal(summary.accounts.active, 1);
  assert.equal(summary.accounts.activation_ready, 0);
  assert.equal(summary.accounts.active_ready, 0);
  assert.equal(summary.accounts.activation_ready_inconsistent, 1);
  assert.equal(summary.checks.status, "failed");
  assert.deepEqual(
    summary.checks.items.find((item) => item.name === "opencode_accounts_readiness_consistent"),
    {
      name: "opencode_accounts_readiness_consistent",
      status: "failed",
      actual: 1,
      expected: 0,
    },
  );
  assert.deepEqual(
    summary.checks.items.find((item) => item.name === "active_ready_accounts"),
    {
      name: "active_ready_accounts",
      status: "failed",
      actual: 0,
      expected_min: 1,
    },
  );
  assert.doesNotMatch(JSON.stringify(summary), /api_key/);
});

test("runOpenCodePreflight fails when active account threshold is not met", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({
        success: true,
        data: [
          {
            active: false,
            activation_ready: true,
            credential_integrity: "ok",
            missing_activation_fields: [],
          },
        ],
      });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({ success: true, data: {} });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 1,
    minActiveAccounts: 1,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  const activeCheck = summary.checks.items.find((item) => item.name === "active_accounts");
  assert.deepEqual(activeCheck, {
    name: "active_accounts",
    status: "failed",
    actual: 0,
    expected_min: 1,
  });
});

test("runOpenCodePreflight fails when required affinity stats endpoint is unavailable", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({ success: true, data: [] });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({ success: false, message: "stats disabled" });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  const statsCheck = summary.checks.items.find(
    (item) => item.name === "affinity_usage_stats_endpoint",
  );
  assert.equal(statsCheck.status, "failed");
  assert.equal(statsCheck.actual, "business_error");
});

test("runOpenCodePreflight fails malformed diagnostics payloads", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {},
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({ success: true, data: [] });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({
        success: true,
        data: {
          rule_name: "codex cli trace",
          using_group: "default",
          key_fp: "00000000",
        },
      });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  const payloadCheck = summary.checks.items.find(
    (item) => item.name === "opencode_diagnostics_payload",
  );
  assert.deepEqual(payloadCheck, {
    name: "opencode_diagnostics_payload",
    status: "failed",
    actual: "invalid:credential_key_source",
    expected: "credential_key_source+uses_fallback_credential_key",
  });
  assert.equal(
    summary.checks.items.some((item) => item.name === "credential_key_stable"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(summary), /root-token-secret/);
});

test("runOpenCodePreflight fails non-array account payloads", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({ success: true, data: { items: [] } });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({
        success: true,
        data: {
          rule_name: "codex cli trace",
          using_group: "default",
          key_fp: "00000000",
        },
      });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.accounts, null);
  const accountsPayloadCheck = summary.checks.items.find(
    (item) => item.name === "opencode_accounts_payload",
  );
  assert.deepEqual(accountsPayloadCheck, {
    name: "opencode_accounts_payload",
    status: "failed",
    actual: "object",
    expected: "array",
  });
});

test("runOpenCodePreflight fails mismatched affinity stats identity", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "crypto_secret",
          uses_fallback_credential_key: false,
        },
      });
    }
    if (String(url).endsWith("/api/opencode/accounts")) {
      return jsonResponse({ success: true, data: [] });
    }
    if (String(url).includes("/api/log/channel_affinity_usage_cache")) {
      return jsonResponse({
        success: true,
        data: {
          rule_name: "other codex rule",
          using_group: "default",
          key_fp: "00000000",
        },
      });
    }
    return jsonResponse({ success: false, message: "not found" }, { status: 404 });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  const statsIdentityCheck = summary.checks.items.find(
    (item) => item.name === "affinity_usage_stats_identity",
  );
  assert.deepEqual(statsIdentityCheck, {
    name: "affinity_usage_stats_identity",
    status: "failed",
    actual: "mismatch:rule_name",
    expected: "rule_name+using_group+key_fp",
  });
  assert.deepEqual(summary.affinity_usage_stats, {
    rule_name: "other codex rule",
    using_group: "default",
    key_fp: "00000000",
  });
});

test("runOpenCodePreflight redacts deployment URL parts from endpoint errors", async () => {
  const fetcher = async (url) => {
    throw new Error(`cannot reach ${url}`);
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "",
    adminCookie: "",
    adminUserID: "",
    timeoutMs: 1000,
    requireRoot: false,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.endpoints.status.status, "request_error");
  assert.doesNotMatch(JSON.stringify(summary), /new-api\.example\.test/);
});

test("runOpenCodePreflight redacts generic secret-shaped endpoint errors", async () => {
  const secretMessage = [
    "upstream rejected",
    `api_${"key"}=live-secret-value`,
    `${"cook"}ie=session-secret-value`,
    `workspace_${"id"}=workspace-secret-value`,
    `${"Bea"}rer bearer-secret-value-12345`,
    "operator@example.test",
    "https://opencode.ai/auth/callback?code=oauth-code-secret&state=oauth-state-secret",
    `tailnet=${"100"}.64.0.250`,
    `lan=${"192"}.168.255.250`,
    "D:\\srv\\release\\private\\session.txt",
    "/opt/release/private/session.txt",
  ].join(" ");
  const fetcher = async () =>
    jsonResponse({
      success: false,
      message: secretMessage,
    });

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "",
    adminCookie: "",
    adminUserID: "",
    timeoutMs: 1000,
    requireRoot: false,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  const encoded = JSON.stringify(summary);
  assert.equal(summary.checks.status, "failed");
  assert.match(encoded, /<redacted>/);
  assert.match(encoded, /<redacted-email>/);
  assert.doesNotMatch(encoded, /live-secret-value/);
  assert.doesNotMatch(encoded, /session-secret-value/);
  assert.doesNotMatch(encoded, /workspace-secret-value/);
  assert.doesNotMatch(encoded, /bearer-secret-value/);
  assert.doesNotMatch(encoded, /operator@example\.test/);
  assert.doesNotMatch(encoded, /oauth-code-secret/);
  assert.doesNotMatch(encoded, /oauth-state-secret/);
  assert.doesNotMatch(encoded, /100\.126\.180\.64/);
  assert.doesNotMatch(encoded, /192\.168\.1\.20/);
  assert.match(encoded, /<redacted-ip>/);
  assert.doesNotMatch(encoded, /D:\\srv/);
  assert.doesNotMatch(encoded, /\/opt\/release/);
  assert.match(encoded, /<redacted-path>/);
});

test("runOpenCodePreflight fails fallback credential key by default", async () => {
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/status")) {
      return jsonResponse({ version: "test" });
    }
    if (String(url).endsWith("/api/opencode/accounts/diagnostics")) {
      return jsonResponse({
        success: true,
        data: {
          credential_key_source: "session_secret_fallback",
          uses_fallback_credential_key: true,
        },
      });
    }
    return jsonResponse({ success: true, data: [] });
  };

  const summary = await runOpenCodePreflight({
    baseURL: "https://new-api.example.test",
    adminToken: "root-token-secret",
    adminCookie: "",
    adminUserID: "1",
    timeoutMs: 1000,
    requireRoot: true,
    requireStableCredentialKey: true,
    requireAffinityStats: true,
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  const stableCheck = summary.checks.items.find((item) => item.name === "credential_key_stable");
  assert.deepEqual(stableCheck, {
    name: "credential_key_stable",
    status: "failed",
    actual: "session_secret_fallback",
    expected: "crypto_secret",
  });
});

test("CLI exits non-zero and redacts root auth when preflight checks fail", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ version: "test" }));
      return;
    }
    if (request.url === "/api/opencode/accounts/diagnostics") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          data: {
            credential_key_source: "session_secret_fallback",
            uses_fallback_credential_key: true,
          },
        }),
      );
      return;
    }
    if (request.url === "/api/opencode/accounts") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, data: [] }));
      return;
    }
    if (request.url?.startsWith("/api/log/channel_affinity_usage_cache")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, data: {} }));
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
        PREFLIGHT_SCRIPT_PATH,
        "--base-url",
        `http://127.0.0.1:${address.port}`,
      ],
      {
        env: {
          ...process.env,
          NEW_API_ADMIN_TOKEN: "root-token-secret",
          NEW_API_ADMIN_COOKIE: "",
          NEW_API_ADMIN_USER_ID: "1",
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
    assert.equal(Object.hasOwn(summary, "base_url"), false);
    assert.doesNotMatch(stdout, /root-token-secret/);
    assert.doesNotMatch(stdout, /127\.0\.0\.1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function jsonResponse(body, options = {}) {
  return {
    ok: options.status ? options.status >= 200 && options.status < 300 : true,
    status: options.status || 200,
    statusText: options.statusText || "OK",
    async text() {
      return JSON.stringify(body);
    },
  };
}
