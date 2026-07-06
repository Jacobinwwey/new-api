import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRolloutConfig,
  parseExecStartPath,
  redactText,
  shellQuote,
} from "./new-api-clean-rollout.mjs";

test("parseExecStartPath reads systemd structured ExecStart output", () => {
  const raw = "{ path=/srv/new-api/releases/current/new-api ; argv[]=/srv/new-api/releases/current/new-api --port 3000 ; }";

  assert.equal(parseExecStartPath(raw), "/srv/new-api/releases/current/new-api");
});

test("parseExecStartPath falls back to the first token for plain commands", () => {
  assert.equal(parseExecStartPath("/opt/new-api/new-api --port 3000"), "/opt/new-api/new-api");
  assert.equal(parseExecStartPath(""), "");
});

test("shellQuote preserves spaces and single quotes for bash", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("path with spaces"), "'path with spaces'");
  assert.equal(shellQuote("owner's path"), "'owner'\\''s path'");
});

test("redactText removes paths, private addresses, and secret-shaped fragments", () => {
  const message = [
    "failed at /opt/new-api/private/session.txt",
    `http://192.${"168"}.1.20:3000`,
    "operator@example.test",
    `api_${"key"}=live-secret-value`,
    `${"cook"}ie=session-secret-value`,
    `workspace_${"id"}=workspace-secret-value`,
    `${"Bea"}rer bearer-secret-value-12345`,
  ].join(" ");

  const redacted = redactText(message);

  assert.match(redacted, /<redacted-path>/);
  assert.match(redacted, /<redacted-ip>/);
  assert.match(redacted, /<redacted-email>/);
  assert.match(redacted, new RegExp(`api_${"key"}=<redacted>`));
  assert.match(redacted, new RegExp(`${"cook"}ie=<redacted>`));
  assert.match(redacted, new RegExp(`workspace_${"id"}=<redacted>`));
  assert.match(redacted, /Bearer <redacted>/);
  assert.doesNotMatch(redacted, /live-secret-value|session-secret-value|workspace-secret-value|bearer-secret-value/);
});

test("buildRolloutConfig defaults to verification-only rollout", () => {
  const config = buildRolloutConfig(
    ["node", "scripts/new-api-clean-rollout.mjs", "--revision", "abc123"],
    {},
  );

  assert.equal(config.revision, "abc123");
  assert.equal(config.apply, false);
  assert.equal(config.serviceName, "new-api");
  assert.equal(config.statusURL, "http://127.0.0.1:3000/api/status");
  assert.equal(config.runNodeChecks, true);
  assert.equal(config.runGoTests, true);
  assert.equal(config.runWebBuilds, true);
  assert.equal(config.runGoBuild, true);
});

test("buildRolloutConfig accepts explicit apply and gate overrides", () => {
  const config = buildRolloutConfig(
    [
      "node",
      "scripts/new-api-clean-rollout.mjs",
      "--revision",
      "abc123",
      "--apply",
      "true",
      "--node-checks",
      "false",
      "--go-tests",
      "false",
      "--web-builds",
      "false",
      "--go-build",
      "false",
      "--ready-timeout",
      "30",
      "--timeout",
      "120",
    ],
    {},
  );

  assert.equal(config.apply, true);
  assert.equal(config.runNodeChecks, false);
  assert.equal(config.runGoTests, false);
  assert.equal(config.runWebBuilds, false);
  assert.equal(config.runGoBuild, false);
  assert.equal(config.readyTimeoutSeconds, 30);
  assert.equal(config.timeoutSeconds, 120);
});

test("buildRolloutConfig rejects credential-bearing repository URLs", () => {
  assert.throws(
    () =>
      buildRolloutConfig(
        [
          "node",
          "scripts/new-api-clean-rollout.mjs",
          "--revision",
          "abc123",
          "--repo-url",
          "https://operator:secret@example.test/repo.git",
        ],
        {},
      ),
    /repo-url must not include credentials/,
  );

  assert.throws(
    () =>
      buildRolloutConfig(
        [
          "node",
          "scripts/new-api-clean-rollout.mjs",
          "--revision",
          "abc123",
          "--repo-url",
          "https://example.test/repo.git?token=secret",
        ],
        {},
      ),
    /repo-url must not include query or fragment data/,
  );
});
