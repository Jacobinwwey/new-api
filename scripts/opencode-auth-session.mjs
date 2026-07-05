#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

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
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
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
      json({ success: true, status: await statusFromState(existing) });
      return;
    }
  } catch {
    /* no prior session */
  }

  const port = await allocatePort();
  const display = `:${200 + (accountID % 300)}`;
  let xvfb;
  const env = { ...process.env };
  if (os.platform() !== "win32" && !env.DISPLAY) {
    xvfb = spawn("Xvfb", [display, "-screen", "0", `${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}x24`], {
      detached: true,
      stdio: "ignore",
    });
    xvfb.unref();
    env.DISPLAY = display;
  }

  const profile = profileDir(stateDir, accountID);
  await ensureDir(profile);
  const browser = spawn(chromiumBinary(), [
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
  browser.unref();

  await waitForBrowser(port);
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
      url = target.url;
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
  } catch {
    json({ success: true, status: { account_id: accountID, running: false, status: "stopped" } });
    return;
  }
  json({ success: true, status: await statusFromState(state) });
}

async function screenshotSession(args) {
  const state = await readState(args["state-dir"], Number(args["account-id"]));
  const screenshot = await withPage(state, async (cdp) => {
    const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    return { image_base64: result.data || "" };
  });
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
    const cookiesResult = await cdp.send("Network.getAllCookies");
    const storageResult = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const copy = (storage) => {
          const out = {};
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            out[key] = storage.getItem(key);
          }
          return out;
        };
        return { localStorage: copy(window.localStorage), sessionStorage: copy(window.sessionStorage) };
      })()`,
    });
    const storage = storageResult.result?.value || {};
    return {
      cookies: (cookiesResult.cookies || [])
        .filter((cookie) => String(cookie.domain || "").includes("opencode.ai"))
        .map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain })),
      local_storage: storage.localStorage || {},
      session_storage: storage.sessionStorage || {},
      json_responses: [],
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
  } catch {
    json({ success: true, status: { account_id: accountID, running: false, status: "stopped" } });
    return;
  }
  for (const pid of [state.browserPid, state.xvfbPid]) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  }
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
    else fail(`unsupported action: ${action}`);
  } catch (error) {
    fail(error.message || "opencode auth session failed");
  }
}

main();
