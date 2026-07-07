import assert from "node:assert/strict";
import test from "node:test";

import {
  GO_ROLLOUT_CHECK_COMMANDS,
  NODE_ROLLOUT_CHECK_COMMANDS,
  RUNTIME_SCRIPTS,
  WEB_DEFAULT_CHECK_COMMANDS,
  buildAuthRuntimeSmokeCommand,
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
    `http://100.${"64"}.0.20:3000`,
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
  assert.doesNotMatch(redacted, /100\.64\.0\.20|192\.168\.1\.20/);
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
  assert.equal(config.runAuthRuntimeSmoke, true);
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
      "--auth-runtime-smoke",
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
  assert.equal(config.runAuthRuntimeSmoke, false);
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

test("runtime script install set includes live E2E orchestration dependencies", () => {
  assert.deepEqual(
    new Set(RUNTIME_SCRIPTS),
    new Set([
      "opencode-auth-session.mjs",
      "opencode-auth-session-smoke.mjs",
      "opencode-e2e-preflight.mjs",
      "glm-cache-smoke.mjs",
      "tailscale-link-preflight.mjs",
      "opencode-live-e2e.mjs",
    ]),
  );
});

test("node rollout checks cover the auth sidecar runtime smoke runner", () => {
  assert.deepEqual(NODE_ROLLOUT_CHECK_COMMANDS, [
    "node --test scripts/glm-cache-smoke.test.mjs scripts/opencode-e2e-preflight.test.mjs scripts/opencode-auth-session.test.mjs scripts/opencode-auth-session-smoke.test.mjs scripts/new-api-clean-rollout.test.mjs scripts/tailscale-link-preflight.test.mjs scripts/opencode-live-e2e.test.mjs",
    "node --check scripts/glm-cache-smoke.mjs",
    "node --check scripts/opencode-e2e-preflight.mjs",
    "node --check scripts/opencode-auth-session.mjs",
    "node --check scripts/opencode-auth-session-smoke.mjs",
    "node --check scripts/new-api-clean-rollout.mjs",
    "node --check scripts/tailscale-link-preflight.mjs",
    "node --check scripts/opencode-live-e2e.mjs",
  ]);
});

test("buildAuthRuntimeSmokeCommand runs the installed sidecar smoke without credential-bearing inputs", () => {
  const command = buildAuthRuntimeSmokeCommand(
    {
      workingDirectory: "/srv/new-api/current",
    },
    60,
  );

  assert.equal(
    command,
    "node '/srv/new-api/current/scripts/opencode-auth-session-smoke.mjs' --sidecar-path '/srv/new-api/current/scripts/opencode-auth-session.mjs' --url about:blank --timeout '60'",
  );
  assert.doesNotMatch(command, /api[_-]?key|cookie|workspace[_-]?id|token|Bearer|code=|state=/i);
});

test("web default checks cover OpenCode account UI behavior before rollout build", () => {
  assert.deepEqual(WEB_DEFAULT_CHECK_COMMANDS, [
    "bun test src/features/opencode-accounts/lib.test.ts",
    "bunx oxlint -c .oxlintrc.json src/features/opencode-accounts src/routes/_authenticated/opencode-accounts",
    "bun run typecheck",
  ]);
});

test("go rollout checks include the cross-package isolation gate", () => {
  assert.deepEqual(GO_ROLLOUT_CHECK_COMMANDS, [
    "go test ./service/relayconvert -run TestUsageFromChatUsagePreservesCachedTokensForBothAccountingPaths -count=1",
    "go test ./service -run 'TestObserveChannelAffinityUsageCacheByRelayFormat|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped' -count=1",
    "go test ./controller -run 'TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestOpenCodeAccountResponseDoesNotExposeSecrets' -count=1",
    "go test ./common ./model ./service ./controller ./router ./service/relayconvert -count=1",
  ]);
});
