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
  browserProcessArgsMatchState,
  buildOpenCodeBrowserStateExpression,
  isDirectScriptExecution,
  retryTransientBrowserAction,
  sanitizeBrowserStatusURL,
  shouldProbeOpenCodeResourceURL,
  xvfbProcessArgsMatchState,
} from "./opencode-auth-session.mjs";

const execFileAsync = promisify(execFile);
const sidecarScriptPath = fileURLToPath(new URL("./opencode-auth-session.mjs", import.meta.url));

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

test("buildOpenCodeBrowserStateExpression collects same-site JSON responses", async () => {
  const fetched = [];
  const storage = {
    length: 1,
    key: () => "account",
    getItem: () => "{\"email\":\"operator@example.test\"}",
  };
  const context = {
    URL,
    window: {
      location: { href: "https://opencode.ai/auth" },
      localStorage: storage,
      sessionStorage: { length: 0, key: () => null, getItem: () => null },
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
  assert.deepEqual(Array.from(result.jsonResponses), ["{\"quota\":{\"limit\":100,\"used\":1}}"]);
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
