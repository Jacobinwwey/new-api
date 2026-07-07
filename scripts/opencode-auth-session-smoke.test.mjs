import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthSessionSmokeConfig,
  buildAuthSessionSmokeReport,
  isPNGBase64,
  redactAuthSessionSmokeText,
  summarizeAuthSessionStatus,
} from "./opencode-auth-session-smoke.mjs";

test("buildAuthSessionSmokeConfig defaults to a non-credentialed about:blank smoke", () => {
  const config = buildAuthSessionSmokeConfig(["node", "scripts/opencode-auth-session-smoke.mjs"], {});

  assert.equal(config.accountID, 900001);
  assert.equal(config.url, "about:blank");
  assert.equal(config.runScreenshot, true);
  assert.equal(config.pressKey, "Escape");
  assert.match(config.sidecarPath, /opencode-auth-session\.mjs$/);
});

test("buildAuthSessionSmokeConfig rejects credential-bearing or payload-bearing smoke URLs", () => {
  assert.throws(
    () =>
      buildAuthSessionSmokeConfig(
        [
          "node",
          "scripts/opencode-auth-session-smoke.mjs",
          "--url",
          "https://operator:secret@example.test/auth",
        ],
        {},
      ),
    /url must not include credentials/,
  );

  assert.throws(
    () =>
      buildAuthSessionSmokeConfig(
        [
          "node",
          "scripts/opencode-auth-session-smoke.mjs",
          "--url",
          "https://example.test/callback?code=oauth-code&state=oauth-state",
        ],
        {},
      ),
    /url must not include query or fragment data/,
  );
});

test("redactAuthSessionSmokeText strips paths, hosts, emails, and secret-shaped fragments", () => {
  const text = [
    "failed at /opt/new-api/private/session.txt",
    "https://example.test/callback?code=oauth-code&state=oauth-state",
    "operator@example.test",
    `api_${"key"}=live-secret-value`,
    `${"cook"}ie=session-secret-value`,
    `${"Bea"}rer bearer-secret-value-12345`,
  ].join(" ");

  const redacted = redactAuthSessionSmokeText(text);

  assert.match(redacted, /<redacted-path>/);
  assert.match(redacted, /<redacted-url>/);
  assert.match(redacted, /<redacted-email>/);
  assert.match(redacted, new RegExp(`api_${"key"}=<redacted>`));
  assert.match(redacted, new RegExp(`${"cook"}ie=<redacted>`));
  assert.match(redacted, /Bearer <redacted>/);
  assert.doesNotMatch(redacted, /oauth-code|oauth-state|live-secret-value|session-secret-value|bearer-secret-value/);
});

test("summarizeAuthSessionStatus exposes only fixed categories", () => {
  const summary = summarizeAuthSessionStatus({
    account_id: 42,
    running: true,
    status: "running",
    url: "https://opencode.ai/auth/callback",
    title: "Sign in as operator@example.test",
    started_at: 123,
  });

  assert.deepEqual(summary, {
    account_id: 42,
    running: true,
    status: "running",
    url_kind: "http",
    has_title: true,
    has_started_at: true,
  });
  assert.equal(JSON.stringify(summary).includes("opencode.ai"), false);
  assert.equal(JSON.stringify(summary).includes("operator@example.test"), false);
});

test("isPNGBase64 accepts PNG screenshots and rejects other base64 payloads", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");
  const textPayload = Buffer.from("not a png").toString("base64");

  assert.equal(isPNGBase64(pngHeader), true);
  assert.equal(isPNGBase64(textPayload), false);
  assert.equal(isPNGBase64("not-base64"), false);
});

test("buildAuthSessionSmokeReport summarizes steps without leaking browser details", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");
  const report = buildAuthSessionSmokeReport({
    start: { status: { account_id: 7, running: true, status: "running", url: "about:blank", title: "" } },
    status: { status: { account_id: 7, running: true, status: "running", url: "about:blank", title: "" } },
    press: { status: { account_id: 7, running: true, status: "running", url: "about:blank", title: "" } },
    screenshot: {
      screenshot: { image_base64: pngHeader },
      status: { account_id: 7, running: true, status: "running", url: "about:blank", title: "" },
    },
    stop: { status: { account_id: 7, running: false, status: "stopped" } },
  });

  assert.equal(report.success, true);
  assert.equal(report.checks.start_running, true);
  assert.equal(report.checks.status_running, true);
  assert.equal(report.checks.press_running, true);
  assert.equal(report.checks.screenshot_png, true);
  assert.equal(report.checks.stop_stopped, true);
  assert.equal(JSON.stringify(report).includes(pngHeader), false);
});
