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
  buildOpenCodeBrowserStateExpression,
  isDirectScriptExecution,
  retryTransientBrowserAction,
  shouldProbeOpenCodeResourceURL,
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
  const realScript = "/tmp/new-api-release/scripts/opencode-auth-session.mjs";
  const symlinkScript = "/tmp/new-api-current/scripts/opencode-auth-session.mjs";
  const resolvePath = (candidate) => (candidate === symlinkScript ? realScript : candidate);

  assert.equal(
    isDirectScriptExecution(pathToFileURL(realScript).href, symlinkScript, resolvePath),
    true,
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
