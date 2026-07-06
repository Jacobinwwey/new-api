#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "glm-5.2";
const DEFAULT_RULE_NAME = "codex cli trace";
const DEFAULT_GROUP = "default";
const DEFAULT_INPUT = "Return the word ok. Keep the answer short.";
const DEFAULT_REQUEST_COUNT = 4;
const DEFAULT_REQUEST_DELAY_MS = 750;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64;

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
    requestDelayMs: readInteger(args["delay-ms"], DEFAULT_REQUEST_DELAY_MS, 0),
    usingGroup: String(args.group || DEFAULT_GROUP).trim(),
    ruleName: String(args["rule-name"] || DEFAULT_RULE_NAME).trim(),
    timeoutMs: readInteger(args["timeout-ms"], DEFAULT_TIMEOUT_MS, 1000),
    skipStats: args["skip-stats"] === "true",
  };
}

export async function runCacheSmoke(config) {
  const fetcher = config.fetcher || globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error("fetch is not available in this Node.js runtime");
  }

  const keyFingerprint = cacheKeyFingerprint(config.promptCacheKey);
  const baselineStats = await readUsageStats(config, fetcher, keyFingerprint);
  const results = [];
  for (let index = 0; index < config.requestCount; index += 1) {
    const response = await postResponsesRequest(config, fetcher);
    results.push(summarizeResponse(response));
    if (index + 1 < config.requestCount && config.requestDelayMs > 0) {
      await sleep(config.requestDelayMs);
    }
  }
  const finalStats =
    baselineStats.status === "skipped"
      ? baselineStats
      : await readUsageStats(config, fetcher, keyFingerprint);

  return {
    model: config.model,
    rule_name: config.ruleName,
    using_group: config.usingGroup,
    key_fp: keyFingerprint,
    requests: summarizeRequests(results),
    stats: buildUsageStatsReport(baselineStats, finalStats),
  };
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
    return { status: "ok", data: sanitizeStats(payload?.data || {}) };
  } catch (error) {
    return { status: "error", message: sanitizeText(error.message || "stats request failed", config) };
  }
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
  for (const secret of [
    config.apiKey,
    config.adminToken,
    config.adminCookie,
    config.promptCacheKey,
  ]) {
    if (!secret) continue;
    result = result.split(secret).join("<redacted>");
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const config = buildCacheSmokeConfig(process.argv, process.env);
    const summary = await runCacheSmoke(config);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || "glm cache smoke failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
