#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const XVFB_DISPLAY_MIN = 200;
const XVFB_DISPLAY_COUNT = 300;
const XVFB_START_ATTEMPTS = 24;
const MAX_JSON_RESPONSE_COUNT = 20;
const MAX_JSON_RESPONSE_CHARS = 262144;
const BROWSER_STATUS_TITLE_MAX_CHARS = 160;
const BROWSER_STATUS_TITLE_HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const BROWSER_STATUS_TITLE_UNSAFE_URL_PATTERN = /\b(?:data|file|javascript):[^\s"'<>]+/gi;
const BROWSER_STATUS_TITLE_BEARER_PATTERN = /\bbearer\s+[a-z0-9._-]+/gi;
const BROWSER_STATUS_TITLE_SECRET_KV_PATTERN =
  /\b(api[-_]?key|cookie|workspace[-_]?id|authorization|access_token|refresh_token|id_token|code|state)=([^&\s"'<>]+)/gi;
const BROWSER_STATUS_TITLE_EMAIL_PATTERN = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const BROWSER_STATUS_TITLE_WINDOWS_PATH_PATTERN = /\b[a-z]:\\[^\s"'<>]+/gi;
const BROWSER_STATUS_TITLE_UNIX_PATH_PATTERN = /\B\/(?:home|root|opt|var|srv|etc|mnt|tmp|data)\/[^\s"'<>]+/g;
const SAFE_PRESS_KEYS = Object.freeze({
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
});

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = value;
  }
  return args;
}

function json(data) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function fail(message) {
  json({ success: false, message });
}

export function openCodePressKeySpec(rawKey) {
  const key = String(rawKey || "").trim();
  return SAFE_PRESS_KEYS[key] || null;
}

export function normalizeOpenCodeClickPoint(rawX, rawY, viewport = DEFAULT_VIEWPORT) {
  const x = Number(rawX);
  const y = Number(rawY);
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("opencode login click coordinates are invalid");
  }
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (roundedX < 0 || roundedY < 0 || roundedX >= width || roundedY >= height) {
    throw new Error("opencode login click coordinates are outside the viewport");
  }
  return { x: roundedX, y: roundedY };
}

export function openCodeXvfbDisplayCandidates(accountID, attempts = XVFB_START_ATTEMPTS) {
  const numericAccountID = Number(accountID);
  const normalizedAccountID = Number.isInteger(numericAccountID) ? numericAccountID : 0;
  const displayCount = Math.max(1, Math.min(XVFB_DISPLAY_COUNT, Number(attempts) || XVFB_START_ATTEMPTS));
  const baseOffset = ((normalizedAccountID % XVFB_DISPLAY_COUNT) + XVFB_DISPLAY_COUNT) % XVFB_DISPLAY_COUNT;
  const displays = [];
  for (let offset = 0; offset < displayCount; offset += 1) {
    displays.push(`:${XVFB_DISPLAY_MIN + ((baseOffset + offset) % XVFB_DISPLAY_COUNT)}`);
  }
  return displays;
}

async function readStdinText() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

function statePath(stateDir, accountID) {
  return path.join(stateDir, `account-${accountID}.json`);
}

function profileDir(stateDir, accountID) {
  return path.join(stateDir, `profile-${accountID}`);
}

async function readState(stateDir, accountID) {
  const file = statePath(stateDir, accountID);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const missing = new Error("opencode auth state is missing");
      missing.code = "ENOENT";
      throw missing;
    }
    throw new Error(`opencode auth state for account ${accountID} is unreadable`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`opencode auth state for account ${accountID} is invalid`);
  }
}

function isMissingStateError(error) {
  return error && error.code === "ENOENT";
}

async function writeState(stateDir, accountID, state) {
  await ensureDir(stateDir);
  await fs.writeFile(statePath(stateDir, accountID), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function pidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryTransientBrowserAction(action, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const delayMs = Math.max(0, Number(options.delayMs || 250));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error("browser action failed");
}

export function shouldProbeOpenCodeResourceURL(rawURL, pageURL) {
  try {
    const isOpenCodeHost = (hostname) => {
      const host = String(hostname || "").toLowerCase();
      return host === "opencode.ai" || host.endsWith(".opencode.ai");
    };
    const isStaticBrowserResource = (pathname) =>
      /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)$/i.test(String(pathname || ""));
    const containsOAuthPayload = (search) =>
      /[?&](?:code|state|id_token|access_token|refresh_token)=/i.test(String(search || ""));
    const url = new URL(String(rawURL));
    const page = new URL(String(pageURL));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (!isOpenCodeHost(url.hostname) || !isOpenCodeHost(page.hostname)) return false;
    if (isStaticBrowserResource(url.pathname)) return false;
    if (containsOAuthPayload(url.search)) return false;
    const target = `${url.pathname} ${url.search}`.toLowerCase();
    return /\b(api|auth|account|workspace|quota|usage|subscription|user|me|key|token|billing|plan)\b/.test(target);
  } catch {
    return false;
  }
}

export function sanitizeBrowserStatusURL(rawURL) {
  const value = String(rawURL || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "about:" && url.pathname === "blank") return "about:blank";
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function sanitizeBrowserStatusTitle(rawTitle) {
  let title = String(rawTitle || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (!title) return "";
  title = title.replace(
    BROWSER_STATUS_TITLE_HTTP_URL_PATTERN,
    (rawURL) => sanitizeBrowserStatusURL(rawURL) || "<redacted-url>",
  );
  title = title.replace(BROWSER_STATUS_TITLE_UNSAFE_URL_PATTERN, "<redacted-url>");
  title = title.replace(BROWSER_STATUS_TITLE_BEARER_PATTERN, "Bearer <redacted>");
  title = title.replace(BROWSER_STATUS_TITLE_SECRET_KV_PATTERN, "$1=<redacted>");
  title = title.replace(BROWSER_STATUS_TITLE_EMAIL_PATTERN, "<redacted-email>");
  title = title.replace(BROWSER_STATUS_TITLE_WINDOWS_PATH_PATTERN, "<redacted-path>");
  title = title.replace(BROWSER_STATUS_TITLE_UNIX_PATH_PATTERN, "<redacted-path>");
  title = title.replace(/\s+/g, " ").trim();
  const chars = Array.from(title);
  if (chars.length <= BROWSER_STATUS_TITLE_MAX_CHARS) return title;
  return `${chars.slice(0, BROWSER_STATUS_TITLE_MAX_CHARS - 3).join("")}...`;
}

export function buildOpenCodeBrowserStateExpression() {
  return `(${async function browserStateProbe(maxResponses, maxChars) {
    const shouldProbeOpenCodeResourceURL = SHOULD_PROBE_SOURCE;
    const copy = (storage) => {
      const out = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
      return out;
    };
    const resources = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name, index, names) => names.indexOf(name) === index)
      .filter((name) => shouldProbeOpenCodeResourceURL(name, window.location.href));
    const jsonResponses = [];
    for (const url of resources) {
      if (jsonResponses.length >= maxResponses) break;
      try {
        const response = await fetch(url, {
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json, text/plain, */*" },
        });
        if (!response.ok) continue;
        const contentType = response.headers.get("content-type") || "";
        const text = (await response.text()).trim();
        if (text.length === 0 || text.length > maxChars) continue;
        if (contentType.includes("json") || text.startsWith("{") || text.startsWith("[")) {
          jsonResponses.push(text);
        }
      } catch {
      }
    }
    return {
      localStorage: copy(window.localStorage),
      sessionStorage: copy(window.sessionStorage),
      jsonResponses,
    };
  }.toString().replace("SHOULD_PROBE_SOURCE", shouldProbeOpenCodeResourceURL.toString())})(${MAX_JSON_RESPONSE_COUNT}, ${MAX_JSON_RESPONSE_CHARS})`;
}

export function isDirectScriptExecution(moduleURL, argvScriptPath, resolvePath = realpathSync) {
  if (!argvScriptPath) return false;
  try {
    return moduleURL === pathToFileURL(resolvePath(argvScriptPath)).href;
  } catch {
    return moduleURL === pathToFileURL(argvScriptPath).href;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidRunning(pid)) return true;
    await sleep(50);
  }
  return !pidRunning(pid);
}

async function stopProcess(pid) {
  if (!pid || !pidRunning(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForProcessExit(pid, 2000)) return;
  if (os.platform() === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    await waitForProcessExit(pid, 1000);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForProcessExit(pid, 1000);
}

async function readProcessArgs(pid) {
  const processID = Number(pid);
  if (!Number.isInteger(processID) || processID <= 0) return [];
  if (os.platform() === "win32") {
    return new Promise((resolve) => {
      const query = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${processID}").CommandLine`,
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      let stdout = "";
      query.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      query.once("error", () => resolve([]));
      query.once("close", () => {
        const commandLine = stdout.trim();
        resolve(commandLine ? [commandLine] : []);
      });
    });
  }
  try {
    const raw = await fs.readFile(`/proc/${processID}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function processArgMatches(values, expected) {
  if (!values.length || !expected) return false;
  if (values.length > 1) return values.includes(expected);
  const quotedOrWhitespaceBoundary = String.raw`(?:^|[\s"'])`;
  const quotedOrWhitespaceTerminator = String.raw`(?=$|[\s"'])`;
  return new RegExp(`${quotedOrWhitespaceBoundary}${escapeRegExp(expected)}${quotedOrWhitespaceTerminator}`).test(
    values[0],
  );
}

function processExecutableMatches(values, marker) {
  if (!values.length || !marker) return false;
  if (values.length > 1) return path.basename(values[0]).includes(marker);
  return values[0].includes(marker);
}

export function browserProcessArgsMatchState(args, state) {
  const values = Array.isArray(args) ? args.map(String) : [];
  const profile = String(state?.profile || "");
  const port = Number(state?.port || 0);
  if (!profile || !port) return false;
  return (
    processArgMatches(values, `--user-data-dir=${profile}`) &&
    processArgMatches(values, `--remote-debugging-port=${port}`)
  );
}

export function xvfbProcessArgsMatchState(args, state) {
  const values = Array.isArray(args) ? args.map(String) : [];
  const display = String(state?.display || "");
  if (!display) return false;
  return processExecutableMatches(values, "Xvfb") && processArgMatches(values, display);
}

async function stopRecordedSessionProcesses(state) {
  const browserArgs = await readProcessArgs(state?.browserPid);
  const xvfbArgs = await readProcessArgs(state?.xvfbPid);
  await Promise.all([
    browserProcessArgsMatchState(browserArgs, state) ? stopProcess(state.browserPid) : Promise.resolve(),
    xvfbProcessArgsMatchState(xvfbArgs, state) ? stopProcess(state.xvfbPid) : Promise.resolve(),
  ]);
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function chromiumBinary() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ].filter(Boolean);
  return candidates[0];
}

function requestJSON(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
  });
}

async function waitForBrowser(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const version = await requestJSON(`http://127.0.0.1:${port}/json/version`, 1000);
      if (version.webSocketDebuggerUrl) return version;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("browser did not expose CDP");
}

function watchProcessStartup(child, label, command) {
  let waiting = true;
  return {
    promise: new Promise((resolve) => {
      child.once("error", (error) => {
        if (!waiting) return;
        resolve(new Error(`failed to start ${label} (${command}): ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        if (!waiting) return;
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        resolve(new Error(`${label} exited before ready (${reason})`));
      });
    }),
    ready() {
      waiting = false;
    },
  };
}

async function pageWebSocketURL(port) {
  const pages = await requestJSON(`http://127.0.0.1:${port}/json/list`);
  const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page target found");
  return { url: page.url || "", title: page.title || "", ws: page.webSocketDebuggerUrl };
}

class CDP {
  constructor(wsURL) {
    this.wsURL = wsURL;
    this.nextID = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.wsURL);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
      else pending.resolve(message.result || {});
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextID++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
    });
  }

  close() {
    if (this.socket) this.socket.close();
  }
}

async function withPage(state, fn) {
  const target = await pageWebSocketURL(state.port);
  const cdp = new CDP(target.ws);
  await cdp.connect();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return await fn(cdp, target);
  } finally {
    cdp.close();
  }
}

async function startSession(args) {
  const accountID = Number(args["account-id"]);
  const stateDir = args["state-dir"];
  const url = args.url || "https://opencode.ai/auth";
  await ensureDir(stateDir);

  try {
    const existing = await readState(stateDir, accountID);
    if (pidRunning(existing.browserPid)) {
      const existingStatus = await statusFromState(existing);
      if (existingStatus.running) {
        json({ success: true, status: existingStatus });
        return;
      }
      await stopRecordedSessionProcesses(existing);
    }
  } catch (error) {
    if (!isMissingStateError(error)) throw error;
    /* no prior session */
  }

  const displays = shouldSpawnXvfb() ? openCodeXvfbDisplayCandidates(accountID) : [process.env.DISPLAY || ""];
  let lastError;
  for (const display of displays) {
    try {
      const state = await startSessionProcesses({ accountID, stateDir, url, display });
      await writeState(stateDir, accountID, state);
      json({ success: true, status: await statusFromState(state) });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableXvfbStartupError(error)) break;
    }
  }

  throw lastError || new Error("opencode auth browser did not start");
}

function shouldSpawnXvfb() {
  return os.platform() !== "win32" && !process.env.DISPLAY;
}

function isRetryableXvfbStartupError(error) {
  return /Xvfb exited before ready/.test(String(error?.message || ""));
}

async function startSessionProcesses({ accountID, stateDir, url, display }) {
  const port = await allocatePort();
  let xvfb;
  let xvfbStartup;
  const env = { ...process.env };
  if (shouldSpawnXvfb()) {
    xvfb = spawn("Xvfb", [display, "-screen", "0", `${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}x24`], {
      detached: true,
      stdio: "ignore",
    });
    xvfbStartup = watchProcessStartup(xvfb, "Xvfb", "Xvfb");
    xvfb.unref();
    env.DISPLAY = display;
  }

  const profile = profileDir(stateDir, accountID);
  await ensureDir(profile);
  const browserCommand = chromiumBinary();
  const browser = spawn(browserCommand, [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    url,
  ], {
    detached: true,
    stdio: "ignore",
    env,
  });
  const browserStartup = watchProcessStartup(browser, "chromium", browserCommand);
  browser.unref();

  try {
    const startupChecks = [waitForBrowser(port), browserStartup.promise];
    if (xvfbStartup) startupChecks.push(xvfbStartup.promise);
    const startupResult = await Promise.race(startupChecks);
    if (startupResult instanceof Error) throw startupResult;
    browserStartup.ready();
    if (xvfbStartup) xvfbStartup.ready();
  } catch (error) {
    browserStartup.ready();
    if (xvfbStartup) xvfbStartup.ready();
    await Promise.all([stopProcess(browser.pid), stopProcess(xvfb?.pid)]);
    throw error;
  }
  const state = {
    accountID,
    port,
    display: display || env.DISPLAY || "",
    profile,
    browserPid: browser.pid,
    xvfbPid: xvfb?.pid || 0,
    startedAt: Math.floor(Date.now() / 1000),
  };
  return state;
}

async function statusFromState(state) {
  let url = "";
  let title = "";
  let running = pidRunning(state.browserPid);
  if (running) {
    try {
      const target = await pageWebSocketURL(state.port);
      url = sanitizeBrowserStatusURL(target.url);
      title = sanitizeBrowserStatusTitle(target.title);
    } catch {
      running = false;
    }
  }
  return {
    account_id: state.accountID,
    running,
    status: running ? "running" : "stopped",
    url,
    title,
    started_at: state.startedAt || 0,
  };
}

async function statusSession(args) {
  const accountID = Number(args["account-id"]);
  let state;
  try {
    state = await readState(args["state-dir"], accountID);
  } catch (error) {
    if (!isMissingStateError(error)) throw error;
    json({ success: true, status: { account_id: accountID, running: false, status: "stopped" } });
    return;
  }
  json({ success: true, status: await statusFromState(state) });
}

async function screenshotSession(args) {
  const state = await readState(args["state-dir"], Number(args["account-id"]));
  const screenshot = await retryTransientBrowserAction(() =>
    withPage(state, async (cdp) => {
      const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      return { image_base64: result.data || "" };
    })
  );
  json({ success: true, screenshot, status: await statusFromState(state) });
}

async function clickSession(args) {
  const state = await readState(args["state-dir"], Number(args["account-id"]));
  const { x, y } = normalizeOpenCodeClickPoint(args.x, args.y);
  await withPage(state, async (cdp) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  });
  json({ success: true, status: await statusFromState(state) });
}

async function keySession(args) {
  const state = await readState(args["state-dir"], Number(args["account-id"]));
  if (args.text) throw new Error("key text must be passed through stdin");
  const text = await readStdinText();
  await withPage(state, async (cdp) => {
    await cdp.send("Input.insertText", { text });
  });
  json({ success: true, status: await statusFromState(state) });
}

async function pressSession(args) {
  const keySpec = openCodePressKeySpec(args.key);
  if (!keySpec) throw new Error("unsupported opencode login key");
  const state = await readState(args["state-dir"], Number(args["account-id"]));
  await withPage(state, async (cdp) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...keySpec });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...keySpec });
  });
  json({ success: true, status: await statusFromState(state) });
}

async function extractSession(args) {
  const state = await readState(args["state-dir"], Number(args["account-id"]));
  const browserState = await withPage(state, async (cdp) => {
    await cdp.send("Network.enable");
    const cookiesResult = await cdp.send("Network.getAllCookies");
    const storageResult = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: buildOpenCodeBrowserStateExpression(),
    });
    const storage = storageResult.result?.value || {};
    return {
      cookies: (cookiesResult.cookies || [])
        .filter((cookie) => String(cookie.domain || "").includes("opencode.ai"))
        .map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain })),
      local_storage: storage.localStorage || {},
      session_storage: storage.sessionStorage || {},
      json_responses: storage.jsonResponses || [],
    };
  });
  json({ success: true, browser_state: browserState, status: await statusFromState(state) });
}

async function stopSession(args) {
  const accountID = Number(args["account-id"]);
  const stateDir = args["state-dir"];
  let state;
  try {
    state = await readState(stateDir, accountID);
  } catch (error) {
    if (!isMissingStateError(error)) throw error;
    json({ success: true, status: { account_id: accountID, running: false, status: "stopped" } });
    return;
  }
  await stopRecordedSessionProcesses(state);
  json({ success: true, status: { account_id: accountID, running: false, status: "stopped" } });
}

async function purgeSession(args) {
  const accountID = Number(args["account-id"]);
  const stateDir = args["state-dir"];
  let state;
  try {
    state = await readState(stateDir, accountID);
  } catch (error) {
    if (!isMissingStateError(error)) throw error;
    state = {};
  }
  await stopRecordedSessionProcesses(state);
  await Promise.all([
    fs.rm(statePath(stateDir, accountID), { force: true }),
    fs.rm(profileDir(stateDir, accountID), { recursive: true, force: true }),
  ]);
  json({ success: true, status: { account_id: accountID, running: false, status: "stopped" } });
}

async function main() {
  const args = parseArgs(process.argv);
  const action = args.action;
  const accountID = Number(args["account-id"]);
  if (!action || !Number.isInteger(accountID) || accountID <= 0 || !args["state-dir"]) {
    fail("action, account-id, and state-dir are required");
    return;
  }
  try {
    if (action === "start") await startSession(args);
    else if (action === "status") await statusSession(args);
    else if (action === "screenshot") await screenshotSession(args);
    else if (action === "click") await clickSession(args);
    else if (action === "key") await keySession(args);
    else if (action === "press") await pressSession(args);
    else if (action === "extract") await extractSession(args);
    else if (action === "stop") await stopSession(args);
    else if (action === "purge") await purgeSession(args);
    else fail(`unsupported action: ${action}`);
  } catch (error) {
    fail(error.message || "opencode auth session failed");
  }
}

if (isDirectScriptExecution(import.meta.url, process.argv[1])) {
  main();
}
