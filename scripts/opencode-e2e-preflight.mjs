#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_REQUIRE_ROOT = true;
const DEFAULT_REQUIRE_STABLE_CREDENTIAL_KEY = true;
const DEFAULT_REQUIRE_AFFINITY_STATS = true;
const DEFAULT_MIN_ACTIVATION_READY_ACCOUNTS = 0;
const DEFAULT_MIN_ACTIVE_ACCOUNTS = 0;
const DEFAULT_MIN_ACTIVE_READY_ACCOUNTS = 0;
const CREDENTIAL_KEY_SOURCES = new Set(["crypto_secret", "session_secret_fallback"]);
const CREDENTIAL_INTEGRITY_CATEGORIES = new Set(["ok", "decrypt_failed", "unknown"]);
const ACCOUNT_ITEM_CONTRACT_FIELDS = [
  "active",
  "activation_ready",
  "credential_integrity",
  "credential_key_source",
  "missing_activation_fields",
];
const AFFINITY_STATS_PROBE = {
  ruleName: "codex cli trace",
  usingGroup: "default",
  keyFingerprint: "00000000",
};
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|cookie|workspace[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)\s*[:=]\s*["']?[^"',\s&}]+/gi;
const OAUTH_QUERY_PATTERN = /([?&](?:code|state|access_token|refresh_token|id_token)=)[^&\s]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PRIVATE_IP_PATTERN =
  /\b(?:10|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|127|169\.254|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'<>]+/g;
const POSIX_ABSOLUTE_PATH_PATTERN =
  /(^|[\s"'(])\/(?:home|root|opt|var|srv|etc|mnt|tmp|data)\/[^\s"'<>)]*/g;

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
    requireAffinityStats: readBoolean(
      args["require-affinity-stats"] || env.OPENCODE_PREFLIGHT_REQUIRE_AFFINITY_STATS,
      DEFAULT_REQUIRE_AFFINITY_STATS,
      "require-affinity-stats",
    ),
    minActivationReadyAccounts: readInteger(
      args["min-activation-ready-accounts"] ||
        env.OPENCODE_PREFLIGHT_MIN_ACTIVATION_READY_ACCOUNTS,
      DEFAULT_MIN_ACTIVATION_READY_ACCOUNTS,
      0,
      "min-activation-ready-accounts",
    ),
    minActiveAccounts: readInteger(
      args["min-active-accounts"] || env.OPENCODE_PREFLIGHT_MIN_ACTIVE_ACCOUNTS,
      DEFAULT_MIN_ACTIVE_ACCOUNTS,
      0,
      "min-active-accounts",
    ),
    minActiveReadyAccounts: readInteger(
      args["min-active-ready-accounts"] || env.OPENCODE_PREFLIGHT_MIN_ACTIVE_READY_ACCOUNTS,
      DEFAULT_MIN_ACTIVE_READY_ACCOUNTS,
      0,
      "min-active-ready-accounts",
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
    const diagnosticsContractError = diagnosticsContractViolation(diagnosticsResult.data);
    checks.push({
      name: "opencode_diagnostics_payload",
      status: diagnosticsContractError ? "failed" : "passed",
      actual: diagnosticsContractError ? `invalid:${diagnosticsContractError}` : "valid",
      expected: "credential_key_source+uses_fallback_credential_key",
    });
    if (!diagnosticsContractError) {
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
    const accountsPayloadIsArray = Array.isArray(accountsResult.data);
    checks.push({
      name: "opencode_accounts_payload",
      status: accountsPayloadIsArray ? "passed" : "failed",
      actual: accountsPayloadIsArray ? "array" : typeof accountsResult.data,
      expected: "array",
    });
    if (accountsPayloadIsArray) {
      const accountItemContractViolations = accountItemContractViolationCounts(
        accountsResult.data,
      );
      const hasAccountItemContractViolations = objectHasValues(accountItemContractViolations);
      checks.push({
        name: "opencode_accounts_item_contract",
        status: hasAccountItemContractViolations ? "failed" : "passed",
        actual: hasAccountItemContractViolations ? accountItemContractViolations : "valid",
        expected: ACCOUNT_ITEM_CONTRACT_FIELDS.join("+"),
      });
      summary.accounts = summarizeAccounts(accountsResult.data);
      checks.push({
        name: "opencode_accounts_readiness_consistent",
        status: summary.accounts.activation_ready_inconsistent === 0 ? "passed" : "failed",
        actual: summary.accounts.activation_ready_inconsistent,
        expected: 0,
      });
    }
    if (accountsPayloadIsArray && config.minActivationReadyAccounts > 0) {
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
    if (accountsPayloadIsArray && config.minActiveAccounts > 0) {
      checks.push({
        name: "active_accounts",
        status: summary.accounts.active >= config.minActiveAccounts ? "passed" : "failed",
        actual: summary.accounts.active,
        expected_min: config.minActiveAccounts,
      });
    }
    if (accountsPayloadIsArray && config.minActiveReadyAccounts > 0) {
      checks.push({
        name: "active_ready_accounts",
        status:
          summary.accounts.active_ready >= config.minActiveReadyAccounts ? "passed" : "failed",
        actual: summary.accounts.active_ready,
        expected_min: config.minActiveReadyAccounts,
      });
    }
  }

  const affinityStatsResult = await getJSON(config, fetcher, buildAffinityStatsProbePath(), {
    root: true,
  });
  summary.endpoints.affinity_usage_stats = endpointSummary(affinityStatsResult);
  checks.push({
    name: "affinity_usage_stats_endpoint",
    status: endpointCheckStatus(affinityStatsResult, config.requireAffinityStats),
    actual: affinityStatsResult.status,
    expected: "ok",
    message: affinityStatsResult.message,
  });
  if (affinityStatsResult.ok) {
    summary.affinity_usage_stats = sanitizeAffinityStats(affinityStatsResult.data);
    const statsIdentityError = affinityStatsIdentityMismatch(summary.affinity_usage_stats);
    checks.push({
      name: "affinity_usage_stats_identity",
      status: statsIdentityError
        ? endpointCheckStatus({ ok: false }, config.requireAffinityStats)
        : "passed",
      actual: statsIdentityError ? `mismatch:${statsIdentityError}` : "matched",
      expected: "rule_name+using_group+key_fp",
    });
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

function buildAffinityStatsProbePath() {
  const params = new URLSearchParams({
    rule_name: AFFINITY_STATS_PROBE.ruleName,
    using_group: AFFINITY_STATS_PROBE.usingGroup,
    key_fp: AFFINITY_STATS_PROBE.keyFingerprint,
  });
  return `/api/log/channel_affinity_usage_cache?${params.toString()}`;
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

function diagnosticsContractViolation(data) {
  const source = String(data?.credential_key_source || "");
  if (!CREDENTIAL_KEY_SOURCES.has(source)) {
    return "credential_key_source";
  }
  if (typeof data?.uses_fallback_credential_key !== "boolean") {
    return "uses_fallback_credential_key";
  }
  return "";
}

function sanitizeAffinityStats(data) {
  return {
    rule_name: String(data?.rule_name || ""),
    using_group: String(data?.using_group || ""),
    key_fp: String(data?.key_fp || ""),
  };
}

function affinityStatsIdentityMismatch(stats) {
  const expected = {
    rule_name: AFFINITY_STATS_PROBE.ruleName,
    using_group: AFFINITY_STATS_PROBE.usingGroup,
    key_fp: AFFINITY_STATS_PROBE.keyFingerprint,
  };
  for (const field of ["rule_name", "using_group", "key_fp"]) {
    if (stats[field] !== expected[field]) {
      return field;
    }
  }
  return "";
}

function summarizeAccounts(data) {
  const accounts = Array.isArray(data) ? data : [];
  const missingActivationFields = {};
  const credentialIntegrity = {};
  const credentialKeySource = {};
  const activationContract = {};
  let activationReady = 0;
  let activationReadyInconsistent = 0;
  let active = 0;
  let activeReady = 0;
  for (const account of accounts) {
    const isActive = account?.active === true;
    if (isActive) active += 1;
    const integrity = credentialIntegrityCategory(account?.credential_integrity);
    credentialIntegrity[integrity] = (credentialIntegrity[integrity] || 0) + 1;
    const keySource = credentialKeySourceCategory(account?.credential_key_source);
    credentialKeySource[keySource] = (credentialKeySource[keySource] || 0) + 1;
    const missingFields = Array.isArray(account?.missing_activation_fields)
      ? account.missing_activation_fields
      : [];
    const ready = account?.activation_ready === true && integrity === "ok" && missingFields.length === 0;
    if (account?.activation_ready === true && !ready) {
      activationReadyInconsistent += 1;
    }
    if (ready) activationReady += 1;
    if (isActive && ready) activeReady += 1;
    const contract = activationContractCategory(account, integrity, missingFields, ready);
    activationContract[contract] = (activationContract[contract] || 0) + 1;
    for (const field of missingFields) {
      const key = missingActivationFieldCategory(field);
      if (!key) continue;
      missingActivationFields[key] = (missingActivationFields[key] || 0) + 1;
    }
  }
  return {
    total: accounts.length,
    active,
    active_ready: activeReady,
    activation_ready: activationReady,
    activation_ready_inconsistent: activationReadyInconsistent,
    credential_integrity: credentialIntegrity,
    credential_key_source: credentialKeySource,
    activation_contract: activationContract,
    missing_activation_fields: missingActivationFields,
  };
}

function accountItemContractViolationCounts(accounts) {
  const violations = {};
  for (const account of accounts) {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      incrementViolation(violations, "item");
      continue;
    }
    if (typeof account.active !== "boolean") {
      incrementViolation(violations, "active");
    }
    if (typeof account.activation_ready !== "boolean") {
      incrementViolation(violations, "activation_ready");
    }
    if (
      typeof account.credential_integrity !== "string" ||
      account.credential_integrity.trim() === ""
    ) {
      incrementViolation(violations, "credential_integrity");
    }
    if (
      typeof account.credential_key_source !== "string" ||
      account.credential_key_source.trim() === ""
    ) {
      incrementViolation(violations, "credential_key_source");
    }
    if (!Array.isArray(account.missing_activation_fields)) {
      incrementViolation(violations, "missing_activation_fields");
    }
  }
  return violations;
}

function incrementViolation(violations, key) {
  violations[key] = (violations[key] || 0) + 1;
}

function objectHasValues(value) {
  return Object.keys(value || {}).length > 0;
}

function credentialIntegrityCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (CREDENTIAL_INTEGRITY_CATEGORIES.has(normalized)) {
    return normalized;
  }
  if (normalized.includes("decrypt")) {
    return "decrypt_failed";
  }
  return "other";
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

function credentialKeySourceCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (CREDENTIAL_KEY_SOURCES.has(normalized)) {
    return normalized;
  }
  return "other";
}

function activationContractCategory(account, integrity, missingFields, ready) {
  if (ready) return "ready";
  if (integrity === "decrypt_failed") return "decrypt_failed";
  const normalizedFields = missingFields.map((field) =>
    String(field || "").trim().toLowerCase(),
  );
  if (normalizedFields.includes("credentials_decryptable")) {
    return "decrypt_failed";
  }
  if (normalizedFields.includes("codex_oauth_key")) {
    return "codex_oauth_key_required";
  }
  if (normalizedFields.some((field) => missingActivationFieldCategory(field) === "channel")) {
    return "missing_channel";
  }
  if (
    normalizedFields.some((field) => missingActivationFieldCategory(field) === "credential") ||
    account?.has_api_key === false
  ) {
    return "missing_credential";
  }
  return "incomplete";
}

function buildChecksSummary(items) {
  return {
    status: items.some((item) => item.status === "failed") ? "failed" : "passed",
    items,
  };
}

function endpointCheckStatus(result, required) {
  if (result.ok) return "passed";
  return required ? "failed" : "skipped";
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
  result = result.replace(BEARER_TOKEN_PATTERN, "Bearer <redacted>");
  result = result.replace(OAUTH_QUERY_PATTERN, "$1<redacted>");
  result = result.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key) => `${key}=<redacted>`);
  result = result.replace(EMAIL_PATTERN, "<redacted-email>");
  result = result.replace(PRIVATE_IP_PATTERN, "<redacted-ip>");
  result = result.replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "<redacted-path>");
  result = result.replace(POSIX_ABSOLUTE_PATH_PATTERN, (_match, prefix) => `${prefix}<redacted-path>`);
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
