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
const MAX_JSON_RESPONSE_COUNT = 20;
const MAX_JSON_RESPONSE_CHARS = 262144;

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
    if (!["http:", "https:"].includes(url.protocol)) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
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
  return { url: page.url || "", ws: page.webSocketDebuggerUrl };
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
    }
  } catch (error) {
    if (!isMissingStateError(error)) throw error;
    /* no prior session */
  }

  const port = await allocatePort();
  const display = `:${200 + (accountID % 300)}`;
  let xvfb;
  let xvfbStartup;
  const env = { ...process.env };
  if (os.platform() !== "win32" && !env.DISPLAY) {
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

  const startupChecks = [waitForBrowser(port), browserStartup.promise];
  if (xvfbStartup) startupChecks.push(xvfbStartup.promise);
  const startupResult = await Promise.race(startupChecks);
  if (startupResult instanceof Error) throw startupResult;
  browserStartup.ready();
  if (xvfbStartup) xvfbStartup.ready();
  const state = {
    accountID,
    port,
    display,
    profile,
    browserPid: browser.pid,
    xvfbPid: xvfb?.pid || 0,
    startedAt: Math.floor(Date.now() / 1000),
  };
  await writeState(stateDir, accountID, state);
  json({ success: true, status: await statusFromState(state) });
}

async function statusFromState(state) {
  let url = "";
  let running = pidRunning(state.browserPid);
  if (running) {
    try {
      const target = await pageWebSocketURL(state.port);
      url = sanitizeBrowserStatusURL(target.url);
    } catch {
      running = false;
    }
  }
  return {
    account_id: state.accountID,
    running,
    status: running ? "running" : "stopped",
    url,
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
  const x = Number(args.x);
  const y = Number(args.y);
  await withPage(state, async (cdp) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
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
  await Promise.all([stopProcess(state.browserPid), stopProcess(state.xvfbPid)]);
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
  await Promise.all([stopProcess(state.browserPid), stopProcess(state.xvfbPid)]);
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
