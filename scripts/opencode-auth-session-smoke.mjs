#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_ACCOUNT_ID = 900001;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_URL = "about:blank";
const DEFAULT_PRESS_KEY = "Escape";
const DEFAULT_SIDECAR_PATH = fileURLToPath(new URL("./opencode-auth-session.mjs", import.meta.url));
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[-_]?key|cookie|workspace[-_]?id|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|code|state)\s*[:=]\s*["']?[^"',\s&}]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const PRIVATE_IP_PATTERN =
  /\b(?:10|100|127|169\.254|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b/g;
const POSIX_ABSOLUTE_PATH_PATTERN =
  /(^|[\s"'(])\/(?:home|root|opt|var|srv|etc|mnt|tmp|data)\/[^\s"'<>)]*/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Z]:\\[^\s"'<>)]*/gi;

export function buildAuthSessionSmokeConfig(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  return {
    sidecarPath: String(args["sidecar-path"] || env.OPENCODE_AUTH_SMOKE_SIDECAR_PATH || DEFAULT_SIDECAR_PATH),
    accountID: readInteger(
      args["account-id"] || env.OPENCODE_AUTH_SMOKE_ACCOUNT_ID,
      DEFAULT_ACCOUNT_ID,
      1,
      "account-id",
    ),
    stateDir: String(args["state-dir"] || env.OPENCODE_AUTH_SMOKE_STATE_DIR || ""),
    url: readSmokeURL(args.url || env.OPENCODE_AUTH_SMOKE_URL || DEFAULT_URL),
    timeoutMs:
      readInteger(args.timeout || env.OPENCODE_AUTH_SMOKE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS, 1, "timeout") *
      1000,
    runScreenshot: readBoolean(
      args.screenshot || env.OPENCODE_AUTH_SMOKE_SCREENSHOT,
      true,
      "screenshot",
    ),
    pressKey: readPressKey(args["press-key"] || env.OPENCODE_AUTH_SMOKE_PRESS_KEY || DEFAULT_PRESS_KEY),
  };
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

function readSmokeURL(raw) {
  const value = String(raw || "").trim();
  if (value === "about:blank") return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be about:blank or an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("url must be about:blank or an HTTP(S) URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("url must not include credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("url must not include query or fragment data");
  }
  return parsed.toString();
}

function readPressKey(raw) {
  const value = String(raw || "").trim();
  if (!value || value.toLowerCase() === "none") return "";
  return value;
}

export function redactAuthSessionSmokeText(text) {
  return String(text || "")
    .replace(HTTP_URL_PATTERN, "<redacted-url>")
    .replace(BEARER_TOKEN_PATTERN, "Bearer <redacted>")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key) => `${key}=<redacted>`)
    .replace(EMAIL_PATTERN, "<redacted-email>")
    .replace(PRIVATE_IP_PATTERN, "<redacted-ip>")
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "<redacted-path>")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, (_match, prefix) => `${prefix}<redacted-path>`);
}

export function summarizeAuthSessionStatus(status) {
  const safeStatus = status && typeof status === "object" ? status : {};
  return {
    account_id: Number(safeStatus.account_id || 0),
    running: Boolean(safeStatus.running),
    status: safeStatus.status === "running" ? "running" : "stopped",
    url_kind: classifyURLKind(safeStatus.url),
    has_title: Boolean(String(safeStatus.title || "").trim()),
    has_started_at: Number(safeStatus.started_at || 0) > 0,
  };
}

function classifyURLKind(rawURL) {
  const value = String(rawURL || "").trim();
  if (!value) return "empty";
  if (value === "about:blank") return "about_blank";
  try {
    const parsed = new URL(value);
    if (["http:", "https:"].includes(parsed.protocol)) return "http";
  } catch {
  }
  return "other";
}

export function isPNGBase64(value) {
  const raw = String(value || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  const normalized = raw.replace(/=+$/g, "");
  let buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    return false;
  }
  if (buffer.length < 8) return false;
  if (buffer.toString("base64").replace(/=+$/g, "") !== normalized) return false;
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

export function buildAuthSessionSmokeReport(observations) {
  const start = summarizeAuthSessionStatus(observations?.start?.status);
  const status = summarizeAuthSessionStatus(observations?.status?.status);
  const press = summarizeAuthSessionStatus(observations?.press?.status);
  const screenshot = summarizeAuthSessionStatus(observations?.screenshot?.status);
  const stop = summarizeAuthSessionStatus(observations?.stop?.status);
  const checks = {
    start_running: start.running && start.status === "running",
    status_running: status.running && status.status === "running",
    press_running: observations?.press ? press.running && press.status === "running" : true,
    screenshot_png: observations?.screenshot ? isPNGBase64(observations.screenshot?.screenshot?.image_base64) : true,
    stop_stopped: !stop.running && stop.status === "stopped",
  };
  return {
    success: Object.values(checks).every(Boolean),
    checks,
    stages: {
      start,
      status,
      press: observations?.press ? press : { skipped: true },
      screenshot: observations?.screenshot ? screenshot : { skipped: true },
      stop,
    },
  };
}

async function runSidecarAction(config, action, extraArgs = []) {
  const args = [
    config.sidecarPath,
    "--action",
    action,
    "--account-id",
    String(config.accountID),
    "--state-dir",
    config.stateDir,
    ...extraArgs,
  ];
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(process.execPath, args, {
      timeout: config.timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout || "";
    stderr = error.stderr || "";
    throw new Error(redactAuthSessionSmokeText(`${action} sidecar command failed ${error.message} ${stdout} ${stderr}`));
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(redactAuthSessionSmokeText(`${action} sidecar returned non-JSON output ${stdout} ${stderr}`));
  }
}

function requireActionSuccess(action, result) {
  if (result?.success === true) return;
  throw new Error(`${action} failed: ${redactAuthSessionSmokeText(result?.message || "unknown sidecar failure")}`);
}

function requireRunning(action, result) {
  requireActionSuccess(action, result);
  const summary = summarizeAuthSessionStatus(result.status);
  if (!summary.running || summary.status !== "running") {
    throw new Error(`${action} did not leave browser running`);
  }
}

function requireStopped(action, result) {
  requireActionSuccess(action, result);
  const summary = summarizeAuthSessionStatus(result.status);
  if (summary.running || summary.status !== "stopped") {
    throw new Error(`${action} did not stop browser session`);
  }
}

export async function runAuthSessionSmoke(rawConfig) {
  const tempStateDir = rawConfig.stateDir ? "" : await mkdtemp(path.join(os.tmpdir(), "opencode-auth-smoke-"));
  const config = { ...rawConfig, stateDir: rawConfig.stateDir || tempStateDir };
  const observations = {};
  try {
    observations.start = await runSidecarAction(config, "start", ["--url", config.url]);
    requireRunning("start", observations.start);

    observations.status = await runSidecarAction(config, "status");
    requireRunning("status", observations.status);

    if (config.pressKey) {
      observations.press = await runSidecarAction(config, "press", ["--key", config.pressKey]);
      requireRunning("press", observations.press);
    }

    if (config.runScreenshot) {
      observations.screenshot = await runSidecarAction(config, "screenshot");
      requireActionSuccess("screenshot", observations.screenshot);
      if (!isPNGBase64(observations.screenshot?.screenshot?.image_base64)) {
        throw new Error("screenshot did not return a PNG image");
      }
    }

    observations.stop = await runSidecarAction(config, "stop");
    requireStopped("stop", observations.stop);
    const report = buildAuthSessionSmokeReport(observations);
    if (!report.success) {
      throw new Error("auth session smoke checks failed");
    }
    return report;
  } catch (error) {
    try {
      await runSidecarAction(config, "stop");
    } catch {
    }
    return {
      success: false,
      message: redactAuthSessionSmokeText(error.message || "opencode auth session smoke failed"),
      checks: buildAuthSessionSmokeReport(observations).checks,
    };
  } finally {
    try {
      await runSidecarAction(config, "purge");
    } catch {
    }
    if (tempStateDir) {
      await rm(tempStateDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    const report = await runAuthSessionSmoke(buildAuthSessionSmokeConfig(process.argv, process.env));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.success) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        success: false,
        message: redactAuthSessionSmokeText(error.message || "opencode auth session smoke failed"),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
