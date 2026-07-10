import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

import {
  buildBrowserEnv,
  browserProcessArgsMatchState,
  buildOpenCodeBrowserStateExpression,
  isDirectScriptExecution,
  normalizeOpenCodeClickPoint,
  openCodeScreenshotDimensionsFromBase64,
  openCodePressKeySpec,
  openCodeXvfbDisplayCandidates,
  retryTransientBrowserAction,
  sanitizeBrowserStatusTitle,
  sanitizeBrowserStatusURL,
  openCodeBrowserPageKind,
  shouldProbeOpenCodeResourceURL,
  xvfbProcessArgsMatchState,
} from "./opencode-auth-session.mjs";

const execFileAsync = promisify(execFile);
const sidecarScriptPath = fileURLToPath(new URL("./opencode-auth-session.mjs", import.meta.url));

function pngHeaderBase64(width, height) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(24);
  pngSignature.copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

async function runSidecar(args) {
  const { stdout } = await execFileAsync(process.execPath, [sidecarScriptPath, ...args], {
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

test("retryTransientBrowserAction retries transient failures and returns the successful value", async () => {
  let attempts = 0;

  const result = await retryTransientBrowserAction(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`transient screenshot failure ${attempts}`);
      }
      return { image_base64: "png-data" };
    },
    { attempts: 3, delayMs: 1 },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(result, { image_base64: "png-data" });
});

test("retryTransientBrowserAction throws the last error after exhausting retries", async () => {
  let attempts = 0;

  await assert.rejects(
    retryTransientBrowserAction(
      async () => {
        attempts += 1;
        throw new Error(`still failing ${attempts}`);
      },
      { attempts: 2, delayMs: 1 },
    ),
    /still failing 2/,
  );

  assert.equal(attempts, 2);
});

test("openCodeScreenshotDimensionsFromBase64 reads PNG dimensions used for click mapping", () => {
  assert.deepEqual(openCodeScreenshotDimensionsFromBase64(pngHeaderBase64(1279, 812)), {
    width: 1279,
    height: 812,
  });
  assert.throws(() => openCodeScreenshotDimensionsFromBase64("not-png"), /screenshot is not a PNG/);
  assert.throws(() => openCodeScreenshotDimensionsFromBase64(pngHeaderBase64(0, 812)), /dimensions are invalid/);
});

test("shouldProbeOpenCodeResourceURL accepts only likely OpenCode JSON resources", () => {
  assert.equal(
    shouldProbeOpenCodeResourceURL("https://opencode.ai/api/account/quota", "https://opencode.ai/auth"),
    true,
  );
  assert.equal(
    shouldProbeOpenCodeResourceURL("https://auth.opencode.ai/api/workspace", "https://opencode.ai/auth"),
    true,
  );
  assert.equal(
    shouldProbeOpenCodeResourceURL("https://accounts.google.com/api/account", "https://opencode.ai/auth"),
    false,
  );
  assert.equal(
    shouldProbeOpenCodeResourceURL("https://opencode.ai/assets/app.js", "https://opencode.ai/auth"),
    false,
  );
  assert.equal(
    shouldProbeOpenCodeResourceURL(
      "https://auth.opencode.ai/authorize?client_id=app&state=oauth-state&code=oauth-code",
      "https://opencode.ai/auth",
    ),
    false,
  );
});

test("sanitizeBrowserStatusURL strips authorization payload from browser URLs", () => {
  const callbackURL = sanitizeBrowserStatusURL(
    "https://opencode.ai/auth/callback?code=oauth-code-secret&state=oauth-state-secret#fragment-secret",
  );
  const credentialURL = sanitizeBrowserStatusURL("https://operator:browser-pass@opencode.ai/auth?session=secret");

  assert.equal(callbackURL, "https://opencode.ai/auth/callback");
  assert.equal(credentialURL, "https://opencode.ai/auth");
  assert.equal(sanitizeBrowserStatusURL("about:blank"), "about:blank");
  assert.equal(sanitizeBrowserStatusURL("about:blank#fragment-secret"), "about:blank");
  assert.equal(sanitizeBrowserStatusURL("data:text/plain,embedded-secret"), "");
  assert.equal(sanitizeBrowserStatusURL("file:///local/browser-profile/token.txt"), "");
  assert.equal(sanitizeBrowserStatusURL("javascript:alert('embedded-secret')"), "");
  assert.equal(sanitizeBrowserStatusURL("not a url with oauth-code-secret"), "");

  for (const sanitized of [callbackURL, credentialURL]) {
    assert.doesNotMatch(sanitized, /oauth-code-secret|oauth-state-secret|fragment-secret|operator|browser-pass|secret/);
  }
});

test("sanitizeBrowserStatusURL redacts workspace identifiers from public browser URLs", () => {
  const sanitized = sanitizeBrowserStatusURL(
    "https://opencode.ai/workspace/workspace-fixture-private/keys?tab=active",
  );

  assert.equal(sanitized, "https://opencode.ai/workspace/<redacted>/keys");
  assert.doesNotMatch(sanitized, /workspace-fixture-private/);
});

test("OpenCode key-page kind is a secret-free status signal", () => {
  assert.equal(
    openCodeBrowserPageKind("https://opencode.ai/workspace/workspace-fixture-private/keys?tab=active"),
    "keys",
  );
  assert.equal(openCodeBrowserPageKind("https://opencode.ai/workspace/workspace-fixture-private/usage"), "workspace");
  assert.equal(openCodeBrowserPageKind("https://accounts.google.com/signin"), "");
});

test("workspace key-page resolution accepts only an OpenCode workspace URL", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const resolveKeyPage = sidecar.openCodeWorkspaceKeysURL ?? (() => "");

  assert.equal(
    resolveKeyPage("https://opencode.ai/workspace/workspace-fixture/usage"),
    "https://opencode.ai/workspace/workspace-fixture/keys",
  );
  assert.equal(resolveKeyPage("https://accounts.google.com/workspace/workspace-fixture/keys"), "");
  assert.equal(resolveKeyPage("https://opencode.ai/auth"), "");
});

test("API key clipboard validation rejects masked or unsafe values", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const isValidClipboardKey = sidecar.isOpenCodeAPIKeyClipboardValue ?? (() => false);

  assert.equal(isValidClipboardKey("oc_fixture_key_0123456789abcdef"), true);
  assert.equal(isValidClipboardKey("oc_fixture_key_0123456789abcdef\n"), true);
  assert.equal(isValidClipboardKey("sk-••••••••••••"), false);
  assert.equal(isValidClipboardKey("short-key"), false);
  assert.equal(isValidClipboardKey("key with spaces 0123456789"), false);
});

test("API key copy-control expression selects only a visible key-semantic copy control", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const buildCopyControlExpression = sidecar.buildOpenCodeAPIKeyCopyControlExpression ?? (() => "null");
  const makeElement = ({ label, left, top, width, height }) => ({
    getAttribute: (name) => (name === "aria-label" ? label : ""),
    innerText: "",
    textContent: "",
    value: "",
    getBoundingClientRect: () => ({ left, top, width, height }),
  });
  const context = {
    URL,
    window: { location: { href: "https://opencode.ai/workspace/workspace-fixture/keys" } },
    document: {
      querySelectorAll: () => [
        makeElement({ label: "Copy", left: 20, top: 20, width: 20, height: 20 }),
        makeElement({ label: "Copy API key", left: 480, top: 248, width: 24, height: 24 }),
      ],
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    }),
  };

  const result = new vm.Script(buildCopyControlExpression()).runInNewContext(context);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    workspace_id: "workspace-fixture",
    copy_control: { x: 492, y: 260 },
  });
});

test("API key copy-control expression accepts a generic Copy control in a key container", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const buildCopyControlExpression = sidecar.buildOpenCodeAPIKeyCopyControlExpression ?? (() => "null");
  const context = {
    URL,
    window: { location: { href: "https://opencode.ai/workspace/workspace-fixture/keys" } },
    document: {
      querySelectorAll: () => [
        {
          getAttribute: (name) => (name === "aria-label" ? "Copy" : ""),
          innerText: "",
          textContent: "",
          value: "",
          parentElement: { innerText: "API Key" },
          getBoundingClientRect: () => ({ left: 480, top: 248, width: 24, height: 24 }),
        },
      ],
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    }),
  };

  const result = new vm.Script(buildCopyControlExpression()).runInNewContext(context);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    workspace_id: "workspace-fixture",
    copy_control: { x: 492, y: 260 },
  });
});

test("API key copy-control expression rejects a generic copy control", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const buildCopyControlExpression = sidecar.buildOpenCodeAPIKeyCopyControlExpression ?? (() => "null");
  const context = {
    URL,
    window: { location: { href: "https://opencode.ai/workspace/workspace-fixture/keys" } },
    document: {
      querySelectorAll: () => [
        {
          getAttribute: (name) => (name === "aria-label" ? "Copy" : ""),
          innerText: "",
          textContent: "",
          value: "",
          getBoundingClientRect: () => ({ left: 20, top: 20, width: 20, height: 20 }),
        },
      ],
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    }),
  };

  const result = new vm.Script(buildCopyControlExpression()).runInNewContext(context);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    workspace_id: "workspace-fixture",
    copy_control: null,
  });
});

test("clipboard reader returns a validated API key without retaining surrounding whitespace", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const readCopiedAPIKey = sidecar.readCopiedOpenCodeAPIKey ?? (async () => "");

  const value = await readCopiedAPIKey(async () => "\n  oc_fixture_key_0123456789abcdef  \n");

  assert.equal(value, "oc_fixture_key_0123456789abcdef");
});

test("clipboard reader rejects an invalid copied value without echoing it", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const readCopiedAPIKey = sidecar.readCopiedOpenCodeAPIKey ?? (async () => "");
  const invalidValue = "invalid copied value with spaces";

  await assert.rejects(readCopiedAPIKey(async () => invalidValue), /copied OpenCode API key is invalid/);
});

test("key-page sync clicks the semantic copy control and returns only the validated candidate", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const syncKeyFromPage = sidecar.syncOpenCodeKeyFromPage ?? (async () => ({ workspace_id: "", api_key: "" }));
  const calls = [];
  let evaluateCount = 0;
  const cdp = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method !== "Runtime.evaluate") return {};
      evaluateCount += 1;
      if (evaluateCount === 1) {
        return { result: { value: { workspace_id: "workspace-fixture", copy_control: { x: 492, y: 260 } } } };
      }
      return { result: { value: "oc_fixture_key_0123456789abcdef" } };
    },
  };

  const result = await syncKeyFromPage(cdp, "https://opencode.ai/workspace/workspace-fixture/keys");

  assert.deepEqual(result, {
    workspace_id: "workspace-fixture",
    api_key: "oc_fixture_key_0123456789abcdef",
  });
  assert.deepEqual(
    calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => [call.params.x, call.params.y]),
    [[492, 260], [492, 260], [492, 260]],
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params.expression === "navigator.clipboard.writeText('')",
    ),
  );
});

test("key-page sync rejects a page without a semantic API key copy control", async () => {
  const sidecar = await import("./opencode-auth-session.mjs");
  const syncKeyFromPage = sidecar.syncOpenCodeKeyFromPage ?? (async () => ({ workspace_id: "", api_key: "" }));
  const cdp = {
    send: async () => ({ result: { value: { workspace_id: "workspace-fixture", copy_control: null } } }),
  };

  await assert.rejects(
    syncKeyFromPage(cdp, "https://opencode.ai/workspace/workspace-fixture/keys"),
    /OpenCode API key copy control is unavailable/,
  );
});

test("sanitizeBrowserStatusTitle redacts account and authorization fragments", () => {
  const sanitized = sanitizeBrowserStatusTitle(
    [
      "Sign in as operator@example.test",
      "https://operator:browser-pass@opencode.ai/auth/callback?code=oauth-code-secret&state=oauth-state-secret#fragment",
      "Bearer title-token",
      `workspace_` + `id=workspace-secret`,
      "D:\\Profiles\\operator\\profile",
      "/home/operator/profile",
    ].join(" "),
  );

  assert.match(sanitized, /Sign in as/);
  assert.match(sanitized, /https:\/\/opencode\.ai\/auth\/callback/);
  assert.doesNotMatch(
    sanitized,
    /operator@example\.test|operator:browser-pass|oauth-code-secret|oauth-state-secret|fragment|title-token|workspace-secret|\/home\/operator/,
  );
});

test("buildOpenCodeBrowserStateExpression collects same-site JSON responses", async () => {
  const fetched = [];
  const storage = {
    length: 1,
    key: () => "account",
    getItem: () => "{\"email\":\"operator@example.test\"}",
  };
  const context = {
    URL,
    document: {
      body: {
        innerText: "Continue with Google",
      },
      querySelectorAll: () => [
        {
          tagName: "BUTTON",
          innerText: "Continue with Google",
          textContent: "Continue with Google",
          value: "",
          getAttribute: () => "",
          getBoundingClientRect: () => ({
            left: 120,
            top: 48,
            width: 220,
            height: 44,
          }),
        },
      ],
    },
    window: {
      location: { href: "https://opencode.ai/workspace/workspace-fixture/keys" },
      localStorage: storage,
      sessionStorage: { length: 0, key: () => null, getItem: () => null },
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        pointerEvents: "auto",
      }),
    },
    performance: {
      getEntriesByType: () => [
        { name: "https://opencode.ai/api/account/quota" },
        { name: "https://accounts.google.com/api/account" },
        { name: "https://opencode.ai/assets/app.js" },
      ],
    },
    fetch: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => "{\"quota\":{\"limit\":100,\"used\":1}}",
      };
    },
  };

  const result = await new vm.Script(buildOpenCodeBrowserStateExpression()).runInNewContext(context);

  assert.deepEqual(fetched, ["https://opencode.ai/api/account/quota"]);
  assert.equal(result.localStorage.account, "{\"email\":\"operator@example.test\"}");
  assert.equal(result.workspace_id, "workspace-fixture");
  assert.deepEqual(Array.from(result.jsonResponses), ["{\"quota\":{\"limit\":100,\"used\":1}}"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.hotspots)), [
    {
      id: "google-120-48-220-44",
      label: "Continue with Google",
      provider: "google",
      x: 120,
      y: 48,
      width: 220,
      height: 44,
    },
  ]);
});

test("isDirectScriptExecution accepts symlinked argv script paths", () => {
  const realScript = "/workspace/release-a/scripts/opencode-auth-session.mjs";
  const symlinkScript = "/workspace/current/scripts/opencode-auth-session.mjs";
  const resolvePath = (candidate) => (candidate === symlinkScript ? realScript : candidate);

  assert.equal(
    isDirectScriptExecution(pathToFileURL(realScript).href, symlinkScript, resolvePath),
    true,
  );
});

test("recorded process matching only accepts sidecar-owned browser processes", () => {
  const state = {
    port: 43123,
    profile: "/tmp/opencode-auth/profile-7",
    display: ":207",
  };

  assert.equal(
    browserProcessArgsMatchState(
      [
        "chromium",
        "--remote-debugging-port=43123",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=/tmp/opencode-auth/profile-7",
      ],
      state,
    ),
    true,
  );
  assert.equal(browserProcessArgsMatchState(["node", "unrelated-test-process"], state), false);
  assert.equal(browserProcessArgsMatchState(["chromium", "--remote-debugging-port=43123"], state), false);
  assert.equal(
    browserProcessArgsMatchState(
      [
        "chromium",
        "--remote-debugging-port=431230",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=/tmp/opencode-auth/profile-7",
      ],
      state,
    ),
    false,
  );
  assert.equal(
    browserProcessArgsMatchState(
      [
        "chromium",
        "--remote-debugging-port=43123",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=/tmp/opencode-auth/profile-70",
      ],
      state,
    ),
    false,
  );

  assert.equal(xvfbProcessArgsMatchState(["Xvfb", ":207", "-screen", "0", "1280x900x24"], state), true);
  assert.equal(xvfbProcessArgsMatchState(["Xvfb", ":208", "-screen", "0", "1280x900x24"], state), false);
  assert.equal(xvfbProcessArgsMatchState(["Xvfb", ":2070", "-screen", "0", "1280x900x24"], state), false);
  assert.equal(xvfbProcessArgsMatchState(["node", "Xvfb", ":207"], state), false);
  assert.equal(xvfbProcessArgsMatchState(["node", ":207"], state), false);
});

test("recorded process matching accepts Windows command line strings without prefix collisions", () => {
  const state = {
    port: 43123,
    profile: String.raw`D:\OpenCode Auth\profile-7`,
  };

  assert.equal(
    browserProcessArgsMatchState(
      [
        String.raw`"C:\Program Files\Chromium\Application\chrome.exe" "--remote-debugging-port=43123" "--user-data-dir=D:\OpenCode Auth\profile-7"`,
      ],
      state,
    ),
    true,
  );
  assert.equal(
    browserProcessArgsMatchState(
      [
        String.raw`"C:\Program Files\Chromium\Application\chrome.exe" "--remote-debugging-port=431230" "--user-data-dir=D:\OpenCode Auth\profile-7"`,
      ],
      state,
    ),
    false,
  );
});

test("openCodePressKeySpec accepts only fixed browser-control keys", () => {
  assert.deepEqual(openCodePressKeySpec("Enter"), {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  assert.deepEqual(openCodePressKeySpec("ArrowLeft"), {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
  });
  assert.equal(openCodePressKeySpec(" enter "), null);
  assert.equal(openCodePressKeySpec("Control+L"), null);
  assert.equal(openCodePressKeySpec("secret pasted into key field"), null);
});

test("normalizeOpenCodeClickPoint accepts only finite in-viewport coordinates", () => {
  assert.deepEqual(normalizeOpenCodeClickPoint("120.4", "80.5"), { x: 120, y: 81 });
  assert.deepEqual(normalizeOpenCodeClickPoint(1279, 899), { x: 1279, y: 899 });
  assert.throws(() => normalizeOpenCodeClickPoint("NaN", 80), /coordinates are invalid/);
  assert.throws(() => normalizeOpenCodeClickPoint(1280, 80), /outside the viewport/);
  assert.throws(() => normalizeOpenCodeClickPoint(120, -1), /outside the viewport/);
});

test("openCodeXvfbDisplayCandidates starts from account-derived display and then probes alternatives", () => {
  assert.deepEqual(openCodeXvfbDisplayCandidates(900001, 4), [":201", ":202", ":203", ":204"]);
  assert.deepEqual(openCodeXvfbDisplayCandidates(900299, 3), [":499", ":200", ":201"]);
  assert.deepEqual(openCodeXvfbDisplayCandidates(-1, 3), [":499", ":200", ":201"]);
});

test("buildBrowserEnv preserves proxy variables needed for external auth pages", () => {
  const env = buildBrowserEnv({
    HTTP_PROXY: "http://127.0.0.1:18080",
    HTTPS_PROXY: "http://127.0.0.1:18080",
    ALL_PROXY: "socks5://127.0.0.1:18080",
    NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "http://127.0.0.1:18080",
    https_proxy: "http://127.0.0.1:18080",
    all_proxy: "socks5://127.0.0.1:18080",
    no_proxy: "localhost,127.0.0.1",
    DISPLAY: ":201",
  });

  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:18080");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:18080");
  assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:18080");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(env.DISPLAY, ":201");
});

test("press action rejects unsupported keys without echoing the raw key", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-press-key-test-"));
  const accountID = 46;

  const result = await runSidecar([
    "--action",
    "press",
    "--account-id",
    String(accountID),
    "--state-dir",
    stateDir,
    "--key",
    "secret pasted into key field",
  ]);

  assert.equal(result.success, false);
  assert.match(result.message, /unsupported opencode login key/);
  assert.doesNotMatch(result.message, /secret pasted/);
});

test("purge action removes account state and browser profile artifacts", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-purge-test-"));
  const accountID = 42;
  const stateFile = path.join(stateDir, `account-${accountID}.json`);
  const profileDir = path.join(stateDir, `profile-${accountID}`);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, "profile-cookie-store"), "browser profile residue");
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      accountID,
      browserPid: 0,
      xvfbPid: 0,
      port: 1,
      startedAt: 1,
    }),
  );

  const result = await runSidecar([
    "--action",
    "purge",
    "--account-id",
    String(accountID),
    "--state-dir",
    stateDir,
  ]);

  assert.equal(result.success, true);
  assert.equal(result.status.status, "stopped");
  assert.equal(existsSync(stateFile), false);
  assert.equal(existsSync(profileDir), false);
});

test("purge action rejects invalid state without deleting browser profile artifacts", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-invalid-state-test-"));
  const accountID = 43;
  const stateFile = path.join(stateDir, `account-${accountID}.json`);
  const profileDir = path.join(stateDir, `profile-${accountID}`);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, "profile-cookie-store"), "browser profile residue");
  await fs.writeFile(stateFile, "{invalid json");

  const result = await runSidecar([
    "--action",
    "purge",
    "--account-id",
    String(accountID),
    "--state-dir",
    stateDir,
  ]);

  assert.equal(result.success, false);
  assert.match(result.message, /opencode auth state for account 43 is invalid/);
  assert.equal(existsSync(stateFile), true);
  assert.equal(existsSync(profileDir), true);
});

test("status action treats only missing state as a stopped session", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-missing-state-test-"));

  const result = await runSidecar([
    "--action",
    "status",
    "--account-id",
    "44",
    "--state-dir",
    stateDir,
  ]);

  assert.equal(result.success, true);
  assert.equal(result.status.status, "stopped");
});

test("sync action resolves browser state before attempting key extraction", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sync-missing-state-test-"));

  const result = await runSidecar([
    "--action",
    "sync",
    "--account-id",
    "47",
    "--state-dir",
    stateDir,
  ]);

  assert.equal(result.success, false);
  assert.match(result.message, /opencode auth state is missing/);
});

test("status action rejects invalid state", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-status-invalid-state-test-"));
  const accountID = 45;
  await fs.writeFile(path.join(stateDir, `account-${accountID}.json`), "{invalid json");

  const result = await runSidecar([
    "--action",
    "status",
    "--account-id",
    String(accountID),
    "--state-dir",
    stateDir,
  ]);

  assert.equal(result.success, false);
  assert.match(result.message, /opencode auth state for account 45 is invalid/);
});
