#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO_URL = "https://github.com/Jacobinwwey/new-api.git";
const DEFAULT_SERVICE_NAME = "new-api";
const DEFAULT_STATUS_URL = "http://127.0.0.1:3000/api/status";
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_READY_TIMEOUT_SECONDS = 90;
const DEFAULT_AUTH_RUNTIME_SMOKE_TIMEOUT_SECONDS = 60;
export const RUNTIME_SCRIPTS = [
  "opencode-auth-session.mjs",
  "opencode-auth-session-smoke.mjs",
  "opencode-e2e-preflight.mjs",
  "glm-cache-smoke.mjs",
  "tailscale-link-preflight.mjs",
  "opencode-live-e2e.mjs",
];
export const NODE_ROLLOUT_CHECK_COMMANDS = [
  "node --test scripts/glm-cache-smoke.test.mjs scripts/opencode-e2e-preflight.test.mjs scripts/opencode-auth-session.test.mjs scripts/opencode-auth-session-smoke.test.mjs scripts/new-api-clean-rollout.test.mjs scripts/tailscale-link-preflight.test.mjs scripts/opencode-live-e2e.test.mjs",
  "node --check scripts/glm-cache-smoke.mjs",
  "node --check scripts/opencode-e2e-preflight.mjs",
  "node --check scripts/opencode-auth-session.mjs",
  "node --check scripts/opencode-auth-session-smoke.mjs",
  "node --check scripts/new-api-clean-rollout.mjs",
  "node --check scripts/tailscale-link-preflight.mjs",
  "node --check scripts/opencode-live-e2e.mjs",
];
export const WEB_DEFAULT_CHECK_COMMANDS = [
  "bun test src/features/opencode-accounts/lib.test.ts",
  "bunx oxlint -c .oxlintrc.json src/features/opencode-accounts src/routes/_authenticated/opencode-accounts",
  "bun run typecheck",
];
export const GO_ROLLOUT_CHECK_COMMANDS = [
  "go test ./service/relayconvert -run TestUsageFromChatUsagePreservesCachedTokensForBothAccountingPaths -count=1",
  "go test ./service -run 'TestObserveChannelAffinityUsageCacheByRelayFormat|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped' -count=1",
  "go test ./controller -run 'TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestOpenCodeAccountResponseDoesNotExposeSecrets' -count=1",
  "go test ./common ./model ./service ./controller ./router ./service/relayconvert -count=1",
];

const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|cookie|workspace[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)\s*[:=]\s*["']?[^"',\s&}]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const POSIX_ABSOLUTE_PATH_PATTERN =
  /(^|[\s"'(])\/(?:home|root|opt|var|srv|etc|mnt|tmp|data)\/[^\s"'<>)]*/g;
const PRIVATE_IP_PATTERN =
  /\b(?:10|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|127|169\.254|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b/g;

export function parseExecStartPath(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const systemdMatch = text.match(/(?:^|\s)path=([^ ;]+)/);
  if (systemdMatch) return systemdMatch[1];
  return text.split(/\s+/)[0] || "";
}

export function redactText(text) {
  return String(text || "")
    .replace(BEARER_TOKEN_PATTERN, "Bearer <redacted>")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key) => `${key}=<redacted>`)
    .replace(EMAIL_PATTERN, "<redacted-email>")
    .replace(PRIVATE_IP_PATTERN, "<redacted-ip>")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, (_match, prefix) => `${prefix}<redacted-path>`);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function normalizeGoModulePath(raw) {
  const modulePath = String(raw || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._~+/-]*$/.test(modulePath) || modulePath.includes("//")) {
    throw new Error("go module path is missing or unsafe");
  }
  return modulePath;
}

export function buildGoBuildCommand(srcDir, artifactPath, modulePath, revision) {
  const versionSymbol = `${normalizeGoModulePath(modulePath)}/common.Version`;
  return [
    `cd ${shellQuote(srcDir)}`,
    `go build -ldflags ${shellQuote(`-s -w -X ${versionSymbol}=${revision}`)} -o ${shellQuote(artifactPath)} .`,
  ].join(" && ");
}

export function buildBinaryVersionCommand(binaryPath) {
  return `${shellQuote(binaryPath)} --version`;
}

export function buildRolloutConfig(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  return {
    repoURL: readRepoURL(args["repo-url"] || env.NEW_API_ROLLOUT_REPO_URL || DEFAULT_REPO_URL),
    revision: String(args.revision || env.NEW_API_ROLLOUT_REVISION || "").trim(),
    serviceName: String(args.service || env.NEW_API_ROLLOUT_SERVICE || DEFAULT_SERVICE_NAME).trim(),
    statusURL: String(args["status-url"] || env.NEW_API_ROLLOUT_STATUS_URL || DEFAULT_STATUS_URL).trim(),
    apply: readBoolean(args.apply || env.NEW_API_ROLLOUT_APPLY, false, "apply"),
    timeoutSeconds: readInteger(
      args.timeout || env.NEW_API_ROLLOUT_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
      60,
      "timeout",
    ),
    readyTimeoutSeconds: readInteger(
      args["ready-timeout"] || env.NEW_API_ROLLOUT_READY_TIMEOUT_SECONDS,
      DEFAULT_READY_TIMEOUT_SECONDS,
      10,
      "ready-timeout",
    ),
    runNodeChecks: readBoolean(args["node-checks"] || env.NEW_API_ROLLOUT_NODE_CHECKS, true, "node-checks"),
    runGoTests: readBoolean(args["go-tests"] || env.NEW_API_ROLLOUT_GO_TESTS, true, "go-tests"),
    runWebBuilds: readBoolean(args["web-builds"] || env.NEW_API_ROLLOUT_WEB_BUILDS, true, "web-builds"),
    runGoBuild: readBoolean(args["go-build"] || env.NEW_API_ROLLOUT_GO_BUILD, true, "go-build"),
    runAuthRuntimeSmoke: readBoolean(
      args["auth-runtime-smoke"] || env.NEW_API_ROLLOUT_AUTH_RUNTIME_SMOKE,
      true,
      "auth-runtime-smoke",
    ),
  };
}

function readRepoURL(raw) {
  const repoURL = String(raw || "").trim();
  if (!repoURL) return "";
  try {
    const parsed = new URL(repoURL);
    if ((parsed.username || parsed.password) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
      throw new Error("repo-url must not include credentials");
    }
    if ((parsed.search || parsed.hash) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
      throw new Error("repo-url must not include query or fragment data");
    }
  } catch (error) {
    if (error.message?.startsWith("repo-url must not include")) throw error;
  }
  return repoURL;
}

export async function runCleanRollout(config) {
  if (process.platform !== "linux") {
    throw new Error("new-api clean rollout must run on the remote Linux host");
  }
  if (!config.revision) {
    throw new Error("revision is required; pass --revision or set NEW_API_ROLLOUT_REVISION");
  }
  if (!config.repoURL) {
    throw new Error("repo URL is required; pass --repo-url or set NEW_API_ROLLOUT_REPO_URL");
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "new-api-rollout-"));
  try {
    const srcDir = path.join(workDir, "src");
    const artifactPath = path.join(workDir, "new-api");
    const stepTimeoutMs = config.timeoutSeconds * 1000;
    await runStep(
      "git_clone",
      `git -c http.version=HTTP/1.1 clone --depth 1 --single-branch ${shellQuote(config.repoURL)} ${shellQuote(srcDir)}`,
      stepTimeoutMs,
      3,
    );

    const actualRevision = (await runCommand(`git -C ${shellQuote(srcDir)} rev-parse HEAD`)).stdout.trim();
    if (actualRevision !== config.revision) {
      throw new Error(`revision mismatch: expected ${config.revision.slice(0, 8)}, got ${actualRevision.slice(0, 8)}`);
    }
    console.log("revision=ok");

    if (config.runNodeChecks) {
      await runStep(
        "node_scripts",
        [
          `cd ${shellQuote(srcDir)}`,
          ...NODE_ROLLOUT_CHECK_COMMANDS,
        ].join(" && "),
        stepTimeoutMs,
      );
    }

    if (config.runGoTests) {
      await runStep(
        "go_targeted",
        [
          `cd ${shellQuote(srcDir)}`,
          ...GO_ROLLOUT_CHECK_COMMANDS,
        ].join(" && "),
        stepTimeoutMs,
      );
    }

    if (config.runWebBuilds) {
      await runStep(
        "web_default_checks",
        [
          `cd ${shellQuote(path.join(srcDir, "web/default"))}`,
          "bun install --silent",
          ...WEB_DEFAULT_CHECK_COMMANDS,
        ].join(" && "),
        stepTimeoutMs,
      );
      await runStep(
        "web_default_build",
        [
          `cd ${shellQuote(path.join(srcDir, "web/default"))}`,
          `DISABLE_ESLINT_PLUGIN=true VITE_REACT_APP_VERSION=${shellQuote(config.revision)} bun run build`,
        ].join(" && "),
        stepTimeoutMs,
      );
      await runStep(
        "web_classic_build",
        [
          `cd ${shellQuote(path.join(srcDir, "web/classic"))}`,
          "bun install --silent",
          `VITE_REACT_APP_VERSION=${shellQuote(config.revision)} bun run build`,
        ].join(" && "),
        stepTimeoutMs,
      );
    }

    if (config.runGoBuild) {
      const modulePath = normalizeGoModulePath(
        (await runCommand(`cd ${shellQuote(srcDir)} && go list -m`, { timeoutMs: stepTimeoutMs })).stdout,
      );
      await runStep(
        "go_build",
        buildGoBuildCommand(srcDir, artifactPath, modulePath, config.revision),
        stepTimeoutMs,
      );
      const artifact = await stat(artifactPath);
      if (!artifact.isFile() || artifact.size <= 0) {
        throw new Error("built artifact is missing or empty");
      }
      console.log("artifact=ok");
      await assertBinaryVersion(artifactPath, config.revision, "artifact_version");
    }

    if (!config.apply) {
      console.log("apply=skipped");
      return;
    }

    await applyRuntimeArtifact(config, srcDir, artifactPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function applyRuntimeArtifact(config, srcDir, artifactPath) {
  const service = await readServiceContract(config.serviceName);
  await validateServiceContract(service);
  console.log("service_contract=ok");

  const backupDir = path.join(service.workingDirectory, `.deploy-backup-${config.revision.slice(0, 8)}-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  await cp(service.execPath, path.join(backupDir, "new-api"), { preserveTimestamps: true });
  const scriptsDir = path.join(service.workingDirectory, "scripts");
  try {
    await cp(scriptsDir, path.join(backupDir, "scripts"), { recursive: true, preserveTimestamps: true });
  } catch {
    // Older artifacts may not have a scripts directory; install will create it.
  }
  console.log("backup=ok");

  await installArtifact(srcDir, artifactPath, service);
  console.log("install=ok");
  await assertBinaryVersion(service.execPath, config.revision, "installed_version");

  try {
    process.kill(Number(service.pid), "SIGTERM");
    await waitForRestart(config.serviceName, service.pid, config.readyTimeoutSeconds);
    await waitForHTTPVersion(config.statusURL, config.revision, config.readyTimeoutSeconds);
    console.log("restart=ok");
    console.log("http_smoke=ok");
    if (config.runAuthRuntimeSmoke) {
      const smokeTimeoutSeconds = Math.max(config.readyTimeoutSeconds, DEFAULT_AUTH_RUNTIME_SMOKE_TIMEOUT_SECONDS);
      await runStep(
        "auth_runtime_smoke",
        buildAuthRuntimeSmokeCommand(service, smokeTimeoutSeconds),
        (smokeTimeoutSeconds + 30) * 1000,
      );
    } else {
      console.log("auth_runtime_smoke=skipped");
    }
    console.log(`deployed_prefix=${config.revision.slice(0, 8)}`);
  } catch (error) {
    console.log("restart_or_smoke=failed");
    await restoreArtifact(backupDir, service);
    const rollbackPID = await currentPID(config.serviceName);
    if (rollbackPID !== "0") {
      try {
        process.kill(Number(rollbackPID), "SIGTERM");
      } catch {
        // The process may have already exited.
      }
    }
    await waitForRestart(config.serviceName, rollbackPID, config.readyTimeoutSeconds);
    await waitForHTTP(config.statusURL, config.readyTimeoutSeconds);
    console.log("rollback=ok");
    throw error;
  }
}

export function buildAuthRuntimeSmokeCommand(service, timeoutSeconds = DEFAULT_AUTH_RUNTIME_SMOKE_TIMEOUT_SECONDS) {
  const scriptsDir = joinRuntimePath(service.workingDirectory, "scripts");
  return [
    "node",
    shellQuote(joinRuntimePath(scriptsDir, "opencode-auth-session-smoke.mjs")),
    "--sidecar-path",
    shellQuote(joinRuntimePath(scriptsDir, "opencode-auth-session.mjs")),
    "--url",
    "about:blank",
    "--timeout",
    shellQuote(String(timeoutSeconds)),
  ].join(" ");
}

function joinRuntimePath(basePath, ...segments) {
  const base = String(basePath || "").replace(/\/+$/g, "");
  return [base, ...segments.map((segment) => String(segment).replace(/^\/+|\/+$/g, ""))]
    .filter(Boolean)
    .join("/");
}

async function readServiceContract(serviceName) {
  const execRaw = (await runCommand(`timeout 5s systemctl show ${shellQuote(serviceName)} -p ExecStart --value`)).stdout;
  const execPath = parseExecStartPath(execRaw);
  const workingDirectory = (
    await runCommand(`timeout 5s systemctl show ${shellQuote(serviceName)} -p WorkingDirectory --value`)
  ).stdout.trim();
  const restart = (
    await runCommand(`timeout 5s systemctl show ${shellQuote(serviceName)} -p Restart --value`)
  ).stdout.trim();
  const pid = await currentPID(serviceName);
  const runUser =
    pid === "0"
      ? ""
      : (await runCommand(`ps -o user= -p ${shellQuote(pid)} 2>/dev/null | awk '{print $1}' || true`)).stdout.trim();
  const currentUser = (await runCommand("id -un")).stdout.trim();
  return { serviceName, execPath, workingDirectory, restart, pid, runUser, currentUser };
}

async function validateServiceContract(service) {
  if (!service.execPath || !(await isFile(service.execPath))) {
    throw new Error("service ExecStart path is missing");
  }
  if (!service.workingDirectory || service.workingDirectory === "-" || !(await isDirectory(service.workingDirectory))) {
    throw new Error("service WorkingDirectory is missing");
  }
  if (service.pid === "0") {
    throw new Error("service has no running process");
  }
  if (service.runUser !== service.currentUser) {
    throw new Error("service process is not owned by the current rollout user");
  }
  if (service.restart !== "always") {
    throw new Error("service Restart policy must be always for no-sudo rollout");
  }
  if (!(await isWritable(path.dirname(service.execPath))) || !(await isWritable(service.workingDirectory))) {
    throw new Error("runtime artifact directories are not writable by the rollout user");
  }
}

async function installArtifact(srcDir, artifactPath, service) {
  const nextBinary = `${service.execPath}.next`;
  await copyFile(artifactPath, nextBinary);
  await chmod(nextBinary, 0o755);
  await rename(nextBinary, service.execPath);

  const scriptsDir = path.join(service.workingDirectory, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  for (const script of RUNTIME_SCRIPTS) {
    const source = path.join(srcDir, "scripts", script);
    const target = path.join(scriptsDir, script);
    const nextTarget = `${target}.next`;
    await copyFile(source, nextTarget);
    await chmod(nextTarget, 0o644);
    await rename(nextTarget, target);
  }
}

async function restoreArtifact(backupDir, service) {
  await copyFile(path.join(backupDir, "new-api"), `${service.execPath}.rollback`);
  await chmod(`${service.execPath}.rollback`, 0o755);
  await rename(`${service.execPath}.rollback`, service.execPath);
  const backupScripts = path.join(backupDir, "scripts");
  if (await isDirectory(backupScripts)) {
    await mkdir(path.join(service.workingDirectory, "scripts"), { recursive: true });
    await cp(backupScripts, path.join(service.workingDirectory, "scripts"), { recursive: true, force: true });
  }
}

async function currentPID(serviceName) {
  return (await runCommand(`timeout 5s systemctl show ${shellQuote(serviceName)} -p MainPID --value || echo 0`)).stdout.trim();
}

async function waitForRestart(serviceName, oldPID, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const active = (await runCommand(`timeout 5s systemctl is-active ${shellQuote(serviceName)} 2>/dev/null || true`)).stdout.trim();
    const pid = await currentPID(serviceName);
    if (active === "active" && pid !== "0" && pid !== String(oldPID)) return;
    await sleep(1000);
  }
  throw new Error("service did not restart within readiness window");
}

async function waitForHTTP(statusURL, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await httpStatusOK(statusURL)) return;
    await sleep(1000);
  }
  throw new Error("HTTP status smoke failed within readiness window");
}

async function waitForHTTPVersion(statusURL, expectedRevision, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await httpVersionMatches(statusURL, expectedRevision)) return;
    await sleep(1000);
  }
  throw new Error("HTTP status version smoke failed within readiness window");
}

async function httpStatusOK(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function httpVersionMatches(url, expectedRevision) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok && response.headers.get("x-new-api-version") === expectedRevision;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function assertBinaryVersion(binaryPath, expectedRevision, label) {
  const result = await runCommand(buildBinaryVersionCommand(binaryPath), { timeoutMs: 15000 });
  const version = firstOutputLine(result.stdout);
  if (result.exitCode !== 0 || version !== expectedRevision) {
    const got = version ? redactText(version).slice(0, 16) : "empty";
    throw new Error(`${label} mismatch: expected ${expectedRevision.slice(0, 8)}, got ${got}`);
  }
  console.log(`${label}=ok`);
}

function firstOutputLine(text) {
  return String(text || "").trim().split(/\r?\n/, 1)[0] || "";
}

async function runStep(name, command, timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000, attempts = 1) {
  let lastError = null;
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runCommand(command, { timeoutMs });
      if (result.exitCode === 0) {
        console.log(`${name}=ok`);
        return;
      }
      lastResult = result;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      console.log(`${name}=retry attempt=${attempt + 1}`);
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
  console.log(`${name}=failed`);
  if (lastResult) {
    const tail = redactText(`${lastResult.stdout}\n${lastResult.stderr}`).trim().split(/\r?\n/).slice(-80).join("\n");
    if (tail) process.stderr.write(`${tail}\n`);
  }
  if (lastError) {
    throw new Error(`${name} failed: ${redactText(lastError.message)}`);
  }
  throw new Error(`${name} failed`);
}

async function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn(value);
    };
    timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (!settled) child.kill("SIGKILL");
            }, 5000);
          }, options.timeoutMs)
        : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(reject, error);
    });
    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        settle(reject, new Error(`command timed out: ${redactText(command)}`));
        return;
      }
      settle(resolve, { exitCode, signal, stdout, stderr });
    });
  });
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

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directoryPath) {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isWritable(targetPath) {
  try {
    await access(targetPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    const config = buildRolloutConfig(process.argv, process.env);
    await runCleanRollout(config);
  } catch (error) {
    process.stderr.write(`${redactText(error.message || "new-api clean rollout failed")}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
