#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_REQUIRE_ROOT = true;
const DEFAULT_REQUIRE_STABLE_CREDENTIAL_KEY = true;
const DEFAULT_MIN_ACTIVATION_READY_ACCOUNTS = 0;

export function buildOpenCodePreflightConfig(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  const baseURL = normalizeBaseURL(args["base-url"] || env.NEW_API_BASE_URL || "");
  if (!baseURL) {
    throw new Error("base URL is required; pass --base-url or set NEW_API_BASE_URL");
  }

  return {
    baseURL,
    adminToken: String(env.NEW_API_ADMIN_TOKEN || "").trim(),
    adminCookie: String(env.NEW_API_ADMIN_COOKIE || "").trim(),
    adminUserID: String(env.NEW_API_ADMIN_USER_ID || "").trim(),
    timeoutMs: readInteger(args["timeout-ms"], DEFAULT_TIMEOUT_MS, 1000, "timeout-ms"),
    requireRoot: readBoolean(
      args["require-root"] || env.OPENCODE_PREFLIGHT_REQUIRE_ROOT,
      DEFAULT_REQUIRE_ROOT,
      "require-root",
    ),
    requireStableCredentialKey: readBoolean(
      args["require-stable-credential-key"] || env.OPENCODE_PREFLIGHT_REQUIRE_STABLE_CREDENTIAL_KEY,
      DEFAULT_REQUIRE_STABLE_CREDENTIAL_KEY,
      "require-stable-credential-key",
    ),
    minActivationReadyAccounts: readInteger(
      args["min-activation-ready-accounts"] ||
        env.OPENCODE_PREFLIGHT_MIN_ACTIVATION_READY_ACCOUNTS,
      DEFAULT_MIN_ACTIVATION_READY_ACCOUNTS,
      0,
      "min-activation-ready-accounts",
    ),
  };
}

export async function runOpenCodePreflight(config) {
  const fetcher = config.fetcher || globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error("fetch is not available in this Node.js runtime");
  }

  const summary = {
    endpoints: {},
    diagnostics: null,
    accounts: null,
  };
  const checks = [];

  const statusResult = await getJSON(config, fetcher, "/api/status");
  summary.endpoints.status = endpointSummary(statusResult);
  checks.push({
    name: "status_endpoint",
    status: statusResult.ok ? "passed" : "failed",
    actual: statusResult.status,
    expected: "ok",
    message: statusResult.message,
  });

  const hasRootAuth = hasRootCredentials(config);
  if (!hasRootAuth) {
    checks.push({
      name: "root_auth_configured",
      status: config.requireRoot ? "failed" : "skipped",
      actual: "missing",
      expected: "configured",
    });
    summary.checks = buildChecksSummary(checks);
    return summary;
  }

  checks.push({
    name: "root_auth_configured",
    status: "passed",
    actual: "configured",
    expected: "configured",
  });

  const diagnosticsResult = await getJSON(config, fetcher, "/api/opencode/accounts/diagnostics", {
    root: true,
  });
  summary.endpoints.diagnostics = endpointSummary(diagnosticsResult);
  checks.push({
    name: "opencode_diagnostics_endpoint",
    status: diagnosticsResult.ok ? "passed" : "failed",
    actual: diagnosticsResult.status,
    expected: "ok",
    message: diagnosticsResult.message,
  });
  if (diagnosticsResult.ok) {
    summary.diagnostics = sanitizeDiagnostics(diagnosticsResult.data);
    checks.push({
      name: "credential_key_stable",
      status:
        !config.requireStableCredentialKey ||
        !summary.diagnostics.uses_fallback_credential_key
          ? "passed"
          : "failed",
      actual: summary.diagnostics.credential_key_source,
      expected: "crypto_secret",
    });
  }

  const accountsResult = await getJSON(config, fetcher, "/api/opencode/accounts", { root: true });
  summary.endpoints.accounts = endpointSummary(accountsResult);
  checks.push({
    name: "opencode_accounts_endpoint",
    status: accountsResult.ok ? "passed" : "failed",
    actual: accountsResult.status,
    expected: "ok",
    message: accountsResult.message,
  });
  if (accountsResult.ok) {
    summary.accounts = summarizeAccounts(accountsResult.data);
    if (config.minActivationReadyAccounts > 0) {
      checks.push({
        name: "activation_ready_accounts",
        status:
          summary.accounts.activation_ready >= config.minActivationReadyAccounts
            ? "passed"
            : "failed",
        actual: summary.accounts.activation_ready,
        expected_min: config.minActivationReadyAccounts,
      });
    }
  }

  summary.checks = buildChecksSummary(checks);
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith("--") ? argv[++index] : "true";
  }
  return args;
}

function normalizeBaseURL(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function readInteger(raw, fallback, minimum, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function readBoolean(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  switch (String(raw).trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
      return false;
    default:
      throw new Error(`${name} must be true or false`);
  }
}

function hasRootCredentials(config) {
  return Boolean((config.adminToken || config.adminCookie) && config.adminUserID);
}

async function getJSON(config, fetcher, path, options = {}) {
  const url = `${normalizeBaseURL(config.baseURL)}${path}`;
  try {
    const response = await fetchWithTimeout(
      fetcher,
      url,
      {
        method: "GET",
        headers: options.root ? buildRootHeaders(config) : {},
      },
      config.timeoutMs,
    );
    const text = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(text || "{}");
    } catch {
      return {
        ok: false,
        status: "invalid_json",
        http_status: response.status,
        message: sanitizeText(text, config),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: "http_error",
        http_status: response.status,
        message: sanitizeText(payload?.message || text, config),
      };
    }
    if (payload && payload.success === false) {
      return {
        ok: false,
        status: "business_error",
        http_status: response.status,
        message: sanitizeText(payload.message || "request failed", config),
      };
    }
    return {
      ok: true,
      status: "ok",
      http_status: response.status,
      data: payload && Object.hasOwn(payload, "data") ? payload.data : payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: "request_error",
      http_status: 0,
      message: sanitizeText(error.message || "request failed", config),
    };
  }
}

function buildRootHeaders(config) {
  const headers = {};
  if (config.adminToken) {
    headers.Authorization = config.adminToken;
  } else if (config.adminCookie) {
    headers.Cookie = config.adminCookie;
  }
  if (config.adminUserID) {
    headers["New-Api-User"] = config.adminUserID;
  }
  return headers;
}

function endpointSummary(result) {
  return {
    status: result.status,
    http_status: result.http_status,
    message: result.message || "",
  };
}

function sanitizeDiagnostics(data) {
  return {
    credential_key_source: String(data?.credential_key_source || ""),
    uses_fallback_credential_key: Boolean(data?.uses_fallback_credential_key),
  };
}

function summarizeAccounts(data) {
  const accounts = Array.isArray(data) ? data : [];
  const missingActivationFields = {};
  const credentialIntegrity = {};
  let activationReady = 0;
  let active = 0;
  for (const account of accounts) {
    if (account?.activation_ready) activationReady += 1;
    if (account?.active) active += 1;
    const integrity = String(account?.credential_integrity || "unknown");
    credentialIntegrity[integrity] = (credentialIntegrity[integrity] || 0) + 1;
    for (const field of account?.missing_activation_fields || []) {
      const key = missingActivationFieldCategory(field);
      if (!key) continue;
      missingActivationFields[key] = (missingActivationFields[key] || 0) + 1;
    }
  }
  return {
    total: accounts.length,
    active,
    activation_ready: activationReady,
    credential_integrity: credentialIntegrity,
    missing_activation_fields: missingActivationFields,
  };
}

function missingActivationFieldCategory(field) {
  const value = String(field || "").trim().toLowerCase();
  if (!value) return "";
  if (value.includes("channel")) return "channel";
  if (
    value.includes("api") ||
    value.includes("key") ||
    value.includes("token") ||
    value.includes("secret") ||
    value.includes("credential")
  ) {
    return "credential";
  }
  if (value.includes("workspace")) return "workspace";
  if (value.includes("account")) return "account";
  if (value.includes("email")) return "email";
  return "other";
}

function buildChecksSummary(items) {
  return {
    status: items.some((item) => item.status === "failed") ? "failed" : "passed",
    items,
  };
}

async function fetchWithTimeout(fetcher, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeText(text, config) {
  let result = String(text || "");
  for (const secret of [config.adminToken, config.adminCookie, ...deploymentURLParts(config.baseURL)]) {
    if (!secret) continue;
    result = result.split(secret).join("<redacted>");
  }
  return result;
}

function deploymentURLParts(rawBaseURL) {
  const baseURL = normalizeBaseURL(rawBaseURL);
  if (!baseURL) return [];
  try {
    const url = new URL(baseURL);
    return [baseURL, url.origin, url.host, url.hostname].filter(Boolean);
  } catch {
    return [baseURL];
  }
}

async function main() {
  try {
    const config = buildOpenCodePreflightConfig(process.argv, process.env);
    const summary = await runOpenCodePreflight(config);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.checks.status === "failed") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message || "opencode preflight failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
