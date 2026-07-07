#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  buildCacheSmokeConfig,
  runCacheSmoke,
} from "./glm-cache-smoke.mjs";
import {
  buildOpenCodePreflightConfig,
  runOpenCodePreflight,
} from "./opencode-e2e-preflight.mjs";
import {
  buildTailscaleLinkPreflightConfig,
  runTailscaleLinkPreflight,
} from "./tailscale-link-preflight.mjs";

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
const MIN_INPUT_REDACTION_PREFIX_LENGTH = 32;
const MAX_INPUT_REDACTION_PREFIX_LENGTH = 512;

const LIVE_E2E_DEFAULT_ARGS = {
  "min-active-ready-accounts": "1",
  "require-root": "true",
  "require-stable-credential-key": "true",
  "require-affinity-stats": "true",
  "warmup-requests": "2",
  requests: "6",
  "require-stats": "true",
  "min-request-hit-rate": "0.8",
  "min-stats-hit-rate": "0.8",
  "min-cache-signal-tokens": "1",
  ports: "3000",
};

export function buildOpenCodeLiveE2EConfig(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  const effectiveArgv = appendDefaultArgs(argv, args, LIVE_E2E_DEFAULT_ARGS);
  const skipTailscale = readBoolean(
    args["skip-tailscale"] || env.OPENCODE_LIVE_E2E_SKIP_TAILSCALE,
    false,
    "skip-tailscale",
  );
  return {
    continueOnFailure: readBoolean(
      args["continue-on-failure"] || env.OPENCODE_LIVE_E2E_CONTINUE_ON_FAILURE,
      false,
      "continue-on-failure",
    ),
    tailscale: skipTailscale ? null : buildTailscaleLinkPreflightConfig(effectiveArgv, env),
    opencode: buildOpenCodePreflightConfig(effectiveArgv, env),
    cacheSmoke: buildCacheSmokeConfig(effectiveArgv, env),
  };
}

export async function runOpenCodeLiveE2E(config) {
  const runners = {
    runTailscaleLinkPreflight,
    runOpenCodePreflight,
    runCacheSmoke,
    ...(config.runners || {}),
  };
  const summary = {
    tailscale: null,
    opencode: null,
    cache_smoke: null,
  };
  const checks = [];

  if (config.tailscale) {
    summary.tailscale = await runStage(
      "tailscale_link",
      () => runners.runTailscaleLinkPreflight(config.tailscale),
      config,
    );
    checks.push(stageCheck("tailscale_link", summary.tailscale?.checks?.status));
    if (shouldStop(summary.tailscale, config)) {
      checks.push(
        stageCheck("opencode_preflight", "skipped", "blocked_by_tailscale", {
          allowSkipped: true,
        }),
      );
      checks.push(
        stageCheck("glm_cache_smoke", "skipped", "blocked_by_tailscale", {
          allowSkipped: true,
        }),
      );
      summary.checks = buildChecksSummary(checks);
      return summary;
    }
  } else {
    checks.push(stageCheck("tailscale_link", "skipped", "disabled", { allowSkipped: true }));
  }

  summary.opencode = await runStage(
    "opencode_preflight",
    () => runners.runOpenCodePreflight(config.opencode),
    config,
  );
  checks.push(stageCheck("opencode_preflight", summary.opencode?.checks?.status));
  const opencodeContractCheck = opencodeActivationContractReadyCheck(
    summary.opencode,
    config.opencode,
  );
  if (opencodeContractCheck) {
    checks.push(opencodeContractCheck);
  }
  if (shouldStop(summary.opencode, config) || shouldStopCheck(opencodeContractCheck, config)) {
    checks.push(
      stageCheck("glm_cache_smoke", "skipped", "blocked_by_opencode_preflight", {
        allowSkipped: true,
      }),
    );
    summary.checks = buildChecksSummary(checks);
    return summary;
  }

  summary.cache_smoke = await runStage(
    "glm_cache_smoke",
    () => runners.runCacheSmoke(config.cacheSmoke),
    config,
  );
  checks.push(stageCheck("glm_cache_smoke", summary.cache_smoke?.checks?.status));

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

function appendDefaultArgs(argv, args, defaults) {
  const nextArgv = [...argv];
  for (const [key, value] of Object.entries(defaults)) {
    if (args[key] !== undefined) continue;
    nextArgv.push(`--${key}`, value);
  }
  return nextArgv;
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

function shouldStop(stageSummary, config) {
  return !config.continueOnFailure && stageSummary?.checks?.status !== "passed";
}

function shouldStopCheck(check, config) {
  return Boolean(!config.continueOnFailure && check && check.status !== "passed");
}

function opencodeActivationContractReadyCheck(stageSummary, opencodeConfig = {}) {
  if (stageSummary?.checks?.status !== "passed") {
    return null;
  }
  const expectedMin = Number(opencodeConfig?.minActiveReadyAccounts || 0);
  if (!Number.isFinite(expectedMin) || expectedMin <= 0) {
    return null;
  }
  const contract = stageSummary?.accounts?.activation_contract;
  const ready = Number(contract?.ready);
  const passed = Number.isFinite(ready) && ready >= expectedMin;
  return {
    name: "opencode_activation_contract_ready",
    status: passed ? "passed" : "failed",
    actual: Number.isFinite(ready) ? ready : "missing",
    expected_min: expectedMin,
  };
}

async function runStage(name, execute, config) {
  try {
    return sanitizeStageSummary(await execute(), config);
  } catch (error) {
    const message = sanitizeLiveText(error.message || `${name} failed`, config);
    return sanitizeStageSummary({
      error: { message },
      checks: {
        status: "failed",
        items: [
          {
            name: `${name}_exception`,
            status: "failed",
            actual: "thrown",
            expected: "completed",
            message,
          },
        ],
      },
    }, config);
  }
}

function stageCheck(name, status, reason = "", options = {}) {
  const normalized =
    status === "passed" || (status === "skipped" && options.allowSkipped) ? status : "failed";
  return {
    name,
    status: normalized,
    actual: status || "missing",
    expected: name === "tailscale_link" ? "passed_or_explicitly_skipped" : "passed",
    reason,
  };
}

function buildChecksSummary(items) {
  return {
    status: items.some((item) => item.status === "failed") ? "failed" : "passed",
    items,
  };
}

function sanitizeLiveText(text, config) {
  let result = String(text || "");
  for (const fragment of sensitiveFragments(config)) {
    result = result.split(fragment).join("<redacted>");
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

function sanitizeStageSummary(value, config) {
  if (typeof value === "string") {
    return sanitizeLiveText(value, config);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStageSummary(item, config));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      sanitizeLiveText(key, config),
      sanitizeStageSummary(item, config),
    ]),
  );
}

function sensitiveFragments(config) {
  const fragments = [
    config?.tailscale?.target,
    config?.opencode?.baseURL,
    config?.opencode?.adminToken,
    config?.opencode?.adminCookie,
    config?.cacheSmoke?.baseURL,
    config?.cacheSmoke?.apiKey,
    config?.cacheSmoke?.adminToken,
    config?.cacheSmoke?.adminCookie,
    config?.cacheSmoke?.promptCacheKey,
    ...inputTextFragments(config?.cacheSmoke?.input),
    ...deploymentURLParts(config?.opencode?.baseURL),
    ...deploymentURLParts(config?.cacheSmoke?.baseURL),
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
  const baseURL = String(rawBaseURL || "").trim().replace(/\/+$/, "");
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
    const config = buildOpenCodeLiveE2EConfig(process.argv, process.env);
    const summary = await runOpenCodeLiveE2E(config);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.checks.status === "failed") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message || "opencode live e2e failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
