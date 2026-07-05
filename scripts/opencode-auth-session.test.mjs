import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  buildOpenCodeBrowserStateExpression,
  retryTransientBrowserAction,
  shouldProbeOpenCodeResourceURL,
} from "./opencode-auth-session.mjs";

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
