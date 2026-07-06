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
    summary.tailscale = await runners.runTailscaleLinkPreflight(config.tailscale);
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

  summary.opencode = await runners.runOpenCodePreflight(config.opencode);
  checks.push(stageCheck("opencode_preflight", summary.opencode?.checks?.status));
  if (shouldStop(summary.opencode, config)) {
    checks.push(
      stageCheck("glm_cache_smoke", "skipped", "blocked_by_opencode_preflight", {
        allowSkipped: true,
      }),
    );
    summary.checks = buildChecksSummary(checks);
    return summary;
  }

  summary.cache_smoke = await runners.runCacheSmoke(config.cacheSmoke);
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
