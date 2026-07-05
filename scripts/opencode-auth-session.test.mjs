import assert from "node:assert/strict";
import test from "node:test";

import { retryTransientBrowserAction } from "./opencode-auth-session.mjs";

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
