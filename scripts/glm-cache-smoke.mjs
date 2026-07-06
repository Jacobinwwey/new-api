#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "glm-5.2";
const DEFAULT_RULE_NAME = "codex cli trace";
const DEFAULT_GROUP = "default";
const DEFAULT_INPUT = buildDefaultCacheProbeInput();
const DEFAULT_REQUEST_COUNT = 4;
const DEFAULT_WARMUP_REQUEST_COUNT = 0;
const DEFAULT_REQUEST_DELAY_MS = 750;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64;
const DEFAULT_MIN_HIT_RATE = 0;
const DEFAULT_MIN_CACHE_SIGNAL_TOKENS = 0;
const MIN_INPUT_REDACTION_PREFIX_LENGTH = 32;
const MAX_INPUT_REDACTION_PREFIX_LENGTH = 512;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|cookie|workspace[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)\s*[:=]\s*["']?[^"',\s&}]+/gi;
const OAUTH_QUERY_PATTERN = /([?&](?:code|state|access_token|refresh_token|id_token)=)[^&\s]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function cacheKeyFingerprint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return createHash("sha1").update(raw).digest("hex").slice(0, 8);
}

export function buildResponsesPayload(options) {
  return {
    model: options.model,
    input: options.input,
    prompt_cache_key: options.promptCacheKey,
    max_output_tokens: options.maxOutputTokens,
  };
}

export function buildCacheUsageStatsURL(baseURL, options) {
  const url = new URL("/api/log/channel_affinity_usage_cache", normalizeBaseURL(baseURL));
  url.searchParams.set("rule_name", options.ruleName);
  url.searchParams.set("using_group", options.usingGroup);
  url.searchParams.set("key_fp", options.keyFingerprint);
  return url.toString();
}

export function buildDefaultCacheProbeInput() {
  const lines = [
    "Cache probe corpus for New API glm-5.2 prompt-cache verification.",
    "Keep this prefix byte-stable across warmup and measured requests.",
  ];
  for (let index = 1; index <= 96; index += 1) {
    const id = String(index).padStart(3, "0");
    lines.push(
      `cache-probe-line-${id}: stable routing, stable session, stable prompt prefix, stable accounting evidence.`,
    );
  }
  lines.push("Answer with exactly: ok");
  return lines.join("\n");
}

export function buildAdminHeaders(options) {
  const headers = {};
  if (options.adminToken) {
    headers.Authorization = options.adminToken;
  } else if (options.adminCookie) {
    headers.Cookie = options.adminCookie;
  }
  if (options.adminUserID) {
    headers["New-Api-User"] = options.adminUserID;
  }
  return headers;
}

export function buildCacheSmokeConfig(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  const baseURL = normalizeBaseURL(args["base-url"] || env.NEW_API_BASE_URL || "");
  const apiKeyEnvName = args["api-key-env"] || "NEW_API_KEY";
  const promptCacheKeyEnvName = args["cache-key-env"] || "GLM_CACHE_SMOKE_KEY";
  const apiKey = String(env[apiKeyEnvName] || "").trim();
  const promptCacheKey =
    String(env[promptCacheKeyEnvName] || "").trim() || `glm-cache-smoke-${randomUUID()}`;

  if (!baseURL) {
    throw new Error("base URL is required; pass --base-url or set NEW_API_BASE_URL");
  }
  if (!apiKey) {
    throw new Error(`relay API key is required in ${apiKeyEnvName}`);
  }

  return {
    baseURL,
    apiKey,
    adminToken: String(env.NEW_API_ADMIN_TOKEN || "").trim(),
    adminCookie: String(env.NEW_API_ADMIN_COOKIE || "").trim(),
    adminUserID: String(env.NEW_API_ADMIN_USER_ID || "").trim(),
    model: String(args.model || DEFAULT_MODEL).trim(),
    promptCacheKey,
    input: String(args.input || env.GLM_CACHE_SMOKE_INPUT || DEFAULT_INPUT),
    maxOutputTokens: readInteger(args["max-output-tokens"], DEFAULT_MAX_OUTPUT_TOKENS, 1),
    requestCount: readInteger(args.requests, DEFAULT_REQUEST_COUNT, 2),
    warmupRequestCount: readInteger(
      args["warmup-requests"] || env.GLM_CACHE_SMOKE_WARMUP_REQUESTS,
      DEFAULT_WARMUP_REQUEST_COUNT,
      0,
    ),
    requestDelayMs: readInteger(args["delay-ms"], DEFAULT_REQUEST_DELAY_MS, 0),
    usingGroup: String(args.group || DEFAULT_GROUP).trim(),
    ruleName: String(args["rule-name"] || DEFAULT_RULE_NAME).trim(),
    timeoutMs: readInteger(args["timeout-ms"], DEFAULT_TIMEOUT_MS, 1000),
    skipStats: args["skip-stats"] === "true",
    requireStats: readBoolean(
      args["require-stats"] || env.GLM_CACHE_SMOKE_REQUIRE_STATS,
      false,
      "require-stats",
    ),
    minRequestHitRate: readRatio(
      args["min-request-hit-rate"] || env.GLM_CACHE_SMOKE_MIN_REQUEST_HIT_RATE,
      DEFAULT_MIN_HIT_RATE,
      "min-request-hit-rate",
    ),
    minStatsHitRate: readRatio(
      args["min-stats-hit-rate"] || env.GLM_CACHE_SMOKE_MIN_STATS_HIT_RATE,
      DEFAULT_MIN_HIT_RATE,
      "min-stats-hit-rate",
    ),
    minCacheSignalTokens: readNonNegativeInteger(
      args["min-cache-signal-tokens"] || env.GLM_CACHE_SMOKE_MIN_CACHE_SIGNAL_TOKENS,
      DEFAULT_MIN_CACHE_SIGNAL_TOKENS,
      "min-cache-signal-tokens",
    ),
  };
}

export async function runCacheSmoke(config) {
  const fetcher = config.fetcher || globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error("fetch is not available in this Node.js runtime");
  }

  const keyFingerprint = cacheKeyFingerprint(config.promptCacheKey);
  const warmupResults = await runResponsesRequests(
    config,
    fetcher,
    Number(config.warmupRequestCount || 0),
  );
  const baselineStats = await readUsageStats(config, fetcher, keyFingerprint);
  const results = await runResponsesRequests(config, fetcher, config.requestCount);
  const finalStats =
    baselineStats.status === "skipped"
      ? baselineStats
      : await readUsageStats(config, fetcher, keyFingerprint);

  const summary = {
    model: config.model,
    rule_name: config.ruleName,
    using_group: config.usingGroup,
    key_fp: keyFingerprint,
    warmup: summarizeRequests(warmupResults),
    requests: summarizeRequests(results),
    stats: buildUsageStatsReport(baselineStats, finalStats),
  };
  summary.checks = evaluateCacheSmokeChecks(summary, config);
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith("--") ? argv[++i] : "true";
  }
  return args;
}

function normalizeBaseURL(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function readInteger(raw, fallback, minimum) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < minimum) {
    return fallback;
  }
  return value;
}

function readNonNegativeInteger(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readRatio(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(String(raw));
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
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

async function postResponsesRequest(config, fetcher) {
  const url = `${normalizeBaseURL(config.baseURL)}/v1/responses`;
  const body = buildResponsesPayload(config);
  const response = await fetchWithTimeout(
    fetcher,
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Originator: "Codex CLI",
        Session_id: config.promptCacheKey,
        "User-Agent": "new-api-glm-cache-smoke/1",
      },
      body: JSON.stringify(body),
    },
    config.timeoutMs,
  );
  return parseJSONResponse(response, config);
}

async function runResponsesRequests(config, fetcher, requestCount) {
  const results = [];
  for (let index = 0; index < requestCount; index += 1) {
    const response = await postResponsesRequest(config, fetcher);
    results.push(summarizeResponse(response));
    if (index + 1 < requestCount && config.requestDelayMs > 0) {
      await sleep(config.requestDelayMs);
    }
  }
  return results;
}

async function readUsageStats(config, fetcher, keyFingerprint) {
  if (config.skipStats) {
    return { status: "skipped", reason: "disabled" };
  }
  if ((!config.adminToken && !config.adminCookie) || !config.adminUserID) {
    return { status: "skipped", reason: "missing_admin_auth" };
  }

  const url = buildCacheUsageStatsURL(config.baseURL, {
    ruleName: config.ruleName,
    usingGroup: config.usingGroup,
    keyFingerprint,
  });
  try {
    const response = await fetchWithTimeout(
      fetcher,
      url,
      {
        method: "GET",
        headers: buildAdminHeaders(config),
      },
      config.timeoutMs,
    );
    const payload = await parseJSONResponse(response, config);
    if (payload && payload.success === false) {
      return { status: "error", message: sanitizeText(payload.message || "stats request failed", config) };
    }
    const stats = sanitizeStats(payload?.data || {});
    const identityMismatch = usageStatsIdentityMismatch(stats, config, keyFingerprint);
    if (identityMismatch) {
      return { status: "error", message: `stats identity mismatch: ${identityMismatch}` };
    }
    return { status: "ok", data: stats };
  } catch (error) {
    return { status: "error", message: sanitizeText(error.message || "stats request failed", config) };
  }
}

function usageStatsIdentityMismatch(stats, config, keyFingerprint) {
  const expected = {
    rule_name: String(config.ruleName || ""),
    using_group: String(config.usingGroup || ""),
    key_fp: String(keyFingerprint || ""),
  };
  for (const field of ["rule_name", "using_group", "key_fp"]) {
    const actual = String(stats[field] || "");
    if (actual && actual !== expected[field]) {
      return field;
    }
  }
  return "";
}

function buildUsageStatsReport(baselineStats, finalStats) {
  if (baselineStats.status === "skipped") {
    return baselineStats;
  }
  if (baselineStats.status !== "ok") {
    return { ...baselineStats, phase: "baseline" };
  }
  if (finalStats.status !== "ok") {
    return { ...finalStats, phase: "final", baseline: baselineStats.data };
  }

  const { delta, resetDetected } = computeStatsDelta(baselineStats.data, finalStats.data);
  return {
    status: "ok",
    baseline: baselineStats.data,
    data: finalStats.data,
    delta,
    reset_detected: resetDetected,
  };
}

function computeStatsDelta(baseline, current) {
  const delta = {};
  let resetDetected = false;
  for (const key of [
    "hit",
    "total",
    "cached_tokens",
    "prompt_cache_hit_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
  ]) {
    const value = Number(current[key] || 0) - Number(baseline[key] || 0);
    if (value < 0) {
      resetDetected = true;
    }
    delta[key] = Math.max(0, value);
  }
  return { delta, resetDetected };
}

function evaluateCacheSmokeChecks(summary, config) {
  const items = [];
  if (Number(config.minRequestHitRate || 0) > 0) {
    const actual = ratio(summary.requests.hit, summary.requests.total);
    items.push({
      name: "request_hit_rate",
      status: actual >= config.minRequestHitRate ? "passed" : "failed",
      actual,
      expected_min: config.minRequestHitRate,
    });
  }
  if (summary.stats.status === "ok" && summary.stats.reset_detected) {
    items.push({
      name: "stats_not_reset",
      status: "failed",
      actual: "reset_detected",
      expected: "stable_counter_window",
    });
  }

  const expectsStats =
    config.requireStats ||
    Number(config.minStatsHitRate || 0) > 0 ||
    Number(config.minCacheSignalTokens || 0) > 0;
  if (expectsStats) {
    const statsOK = summary.stats.status === "ok";
    items.push({
      name: "stats_available",
      status: statsOK ? "passed" : "failed",
      actual: summary.stats.status,
      expected: "ok",
      reason: summary.stats.reason || summary.stats.message || "",
    });
    if (Number(config.minStatsHitRate || 0) > 0) {
      const actual = statsOK ? ratio(summary.stats.delta.hit, summary.stats.delta.total) : 0;
      items.push({
        name: "stats_hit_rate",
        status: statsOK && actual >= config.minStatsHitRate ? "passed" : "failed",
        actual,
        expected_min: config.minStatsHitRate,
      });
    }
    if (Number(config.minCacheSignalTokens || 0) > 0) {
      const actual = statsOK ? cacheSignalTokens(summary.stats.delta) : 0;
      items.push({
        name: "cache_signal_tokens",
        status: statsOK && actual >= config.minCacheSignalTokens ? "passed" : "failed",
        actual,
        expected_min: config.minCacheSignalTokens,
      });
    }
  }

  if (items.length === 0) {
    return { status: "skipped", items };
  }
  return {
    status: items.some((item) => item.status === "failed") ? "failed" : "passed",
    items,
  };
}

function ratio(numerator, denominator) {
  const bottom = Number(denominator || 0);
  if (bottom <= 0) return 0;
  return Number((Number(numerator || 0) / bottom).toFixed(4));
}

function cacheSignalTokens(statsDelta) {
  return Math.max(
    Number(statsDelta.cached_tokens || 0),
    Number(statsDelta.prompt_cache_hit_tokens || 0),
  );
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

async function parseJSONResponse(response, config) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText || ""}: ${sanitizeText(text, config)}`.trim(),
    );
  }
  let payload;
  try {
    payload = JSON.parse(text || "{}");
  } catch {
    throw new Error(`response is not JSON: ${sanitizeText(text, config)}`);
  }
  if (payload && payload.success === false) {
    throw new Error(sanitizeText(payload.message || "request failed", config));
  }
  return payload;
}

function summarizeResponse(payload) {
  const usage = payload?.usage || {};
  const cachedTokens =
    Number(usage?.prompt_tokens_details?.cached_tokens || 0) ||
    Number(usage?.input_tokens_details?.cached_tokens || 0);
  const promptCacheHitTokens = Number(usage?.prompt_cache_hit_tokens || 0);
  return {
    cached_tokens: cachedTokens,
    prompt_cache_hit_tokens: promptCacheHitTokens,
    prompt_tokens: Number(usage?.prompt_tokens || usage?.input_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || usage?.output_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0),
  };
}

function summarizeRequests(results) {
  return {
    total: results.length,
    hit: results.filter((item) => item.cached_tokens > 0 || item.prompt_cache_hit_tokens > 0).length,
    cached_tokens: sum(results, "cached_tokens"),
    prompt_cache_hit_tokens: sum(results, "prompt_cache_hit_tokens"),
    prompt_tokens: sum(results, "prompt_tokens"),
    completion_tokens: sum(results, "completion_tokens"),
    total_tokens: sum(results, "total_tokens"),
  };
}

function sanitizeStats(stats) {
  return {
    rule_name: String(stats.rule_name || ""),
    using_group: String(stats.using_group || ""),
    key_fp: String(stats.key_fp || ""),
    hit: Number(stats.hit || 0),
    total: Number(stats.total || 0),
    cached_tokens: Number(stats.cached_tokens || 0),
    prompt_cache_hit_tokens: Number(stats.prompt_cache_hit_tokens || 0),
    prompt_tokens: Number(stats.prompt_tokens || 0),
    completion_tokens: Number(stats.completion_tokens || 0),
    total_tokens: Number(stats.total_tokens || 0),
    window_seconds: Number(stats.window_seconds || 0),
    last_seen_at: Number(stats.last_seen_at || 0),
    cached_token_rate_mode: String(stats.cached_token_rate_mode || ""),
  };
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function sanitizeText(text, config) {
  let result = String(text || "");
  for (const fragment of sensitiveTextFragments(config)) {
    if (!fragment) continue;
    result = result.split(fragment).join("<redacted>");
  }
  result = result.replace(BEARER_TOKEN_PATTERN, "Bearer <redacted>");
  result = result.replace(OAUTH_QUERY_PATTERN, "$1<redacted>");
  result = result.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key) => `${key}=<redacted>`);
  result = result.replace(EMAIL_PATTERN, "<redacted-email>");
  return result;
}

function sensitiveTextFragments(config) {
  const fragments = [
    config.apiKey,
    config.adminToken,
    config.adminCookie,
    config.promptCacheKey,
    ...inputTextFragments(config.input),
    ...deploymentURLParts(config.baseURL),
  ].filter(Boolean);
  return Array.from(new Set(fragments)).sort((left, right) => right.length - left.length);
}

function inputTextFragments(input) {
  const raw = String(input || "");
  if (!raw) return [];
  const fragments = [raw, ...inputPrefixFragments(raw)];
  try {
    const encoded = JSON.stringify(raw);
    fragments.push(encoded);
    if (encoded.length >= 2) {
      const encodedInner = encoded.slice(1, -1);
      fragments.push(encodedInner, ...inputPrefixFragments(encodedInner));
    }
  } catch {
    // JSON.stringify on a string is expected to succeed; keep raw redaction if it ever does not.
  }
  return fragments;
}

function inputPrefixFragments(value) {
  const maxLength = Math.min(value.length - 1, MAX_INPUT_REDACTION_PREFIX_LENGTH);
  const fragments = [];
  for (let length = maxLength; length >= MIN_INPUT_REDACTION_PREFIX_LENGTH; length -= 1) {
    fragments.push(value.slice(0, length));
  }
  return fragments;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const config = buildCacheSmokeConfig(process.argv, process.env);
    const summary = await runCacheSmoke(config);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.checks.status === "failed") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message || "glm cache smoke failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
