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
      "--min-activation-ready-accounts",
      "2",
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
  assert.equal(config.minActivationReadyAccounts, 2);
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
            email_masked: "u***@example.test",
            missing_activation_fields: [],
          },
          {
            id: 2,
            label: "missing",
            active: false,
            activation_ready: false,
            credential_integrity: "decrypt_failed",
            email_masked: "",
            missing_activation_fields: [`api_${"key"}`, "channel_id"],
          },
        ],
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
    minActivationReadyAccounts: 1,
    fetcher,
  });

  assert.equal(summary.checks.status, "passed");
  assert.deepEqual(summary.diagnostics, {
    credential_key_source: "crypto_secret",
    uses_fallback_credential_key: false,
  });
  assert.deepEqual(summary.accounts, {
    total: 2,
    active: 1,
    activation_ready: 1,
    credential_integrity: {
      ok: 1,
      decrypt_failed: 1,
    },
    missing_activation_fields: {
      credential: 1,
      channel: 1,
    },
  });
  assert.equal(Object.hasOwn(summary, "base_url"), false);
  assert.equal(calls[1].headers.Authorization, "root-token-secret");
  assert.equal(calls[1].headers["New-Api-User"], "1");
  const encoded = JSON.stringify(summary);
  assert.doesNotMatch(encoded, /root-token-secret/);
  assert.doesNotMatch(encoded, /u\*\*\*@example\.test/);
  assert.doesNotMatch(encoded, /api_key/);
  assert.doesNotMatch(encoded, /new-api\.example\.test/);
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
    minActivationReadyAccounts: 0,
    fetcher,
  });

  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.endpoints.status.status, "request_error");
  assert.doesNotMatch(JSON.stringify(summary), /new-api\.example\.test/);
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
