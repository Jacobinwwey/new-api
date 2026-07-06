import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildTailscaleLinkPreflightConfig,
  runTailscaleLinkPreflight,
} from "./tailscale-link-preflight.mjs";

test("buildTailscaleLinkPreflightConfig reads target and gates from argv/env", () => {
  const config = buildTailscaleLinkPreflightConfig(
    [
      "node",
      "scripts/tailscale-link-preflight.mjs",
      "--target",
      "remote-box",
      "--ports",
      "3000,24800",
      "--require-direct",
      "false",
      "--require-tun",
      "false",
      "--require-tcp",
      "true",
      "--min-pongs",
      "2",
    ],
    {},
  );

  assert.equal(config.target, "remote-box");
  assert.deepEqual(config.ports, [3000, 24800]);
  assert.equal(config.requireDirect, false);
  assert.equal(config.requireTun, false);
  assert.equal(config.requireTCP, true);
  assert.equal(config.minPongs, 2);
});

test("runTailscaleLinkPreflight passes direct Tailscale, TUN, and TCP checks", async () => {
  const status = statusPayload({
    peer: {
      HostName: "remote-box",
      DNSName: "remote-box.tailnet.test.",
      ID: "stable-node-id",
      PublicKey: "nodekey:stable-public-key",
      Online: true,
      Expired: false,
      TailscaleIPs: ["100.64.0.10"],
    },
  });
  const summary = await runTailscaleLinkPreflight({
    target: "remote-box",
    ports: [3000, 24800],
    timeoutMs: 1000,
    pingCount: 3,
    minPongs: 3,
    expectedIDHash: hash("stable-node-id"),
    expectedPublicKeyHash: "",
    requireDirect: true,
    requireTun: true,
    requireTCP: true,
    commandRunner: fakeTailscaleRunner({
      status,
      discoPing: directPongs(3),
      icmpPing: directPongs(3),
    }),
    tcpChecker: async () => "open",
  });

  assert.equal(summary.checks.status, "passed");
  assert.equal(summary.target.found, true);
  assert.equal(summary.target.id_hash, hash("stable-node-id"));
  assert.equal(summary.tailscale_ping.direct, 3);
  assert.equal(summary.tun_ping.pongs, 3);
  assert.deepEqual(summary.tcp.ports, [
    { port: 3000, status: "open" },
    { port: 24800, status: "open" },
  ]);
});

test("runTailscaleLinkPreflight exposes stale target and DERP-only/TUN/TCP failures without raw node data", async () => {
  const status = statusPayload({
    peer: {
      HostName: "operator-remote-box",
      DNSName: "remote-box.tailnet.test.",
      ID: "expired-node-id",
      PublicKey: "nodekey:expired-public-key",
      Online: false,
      Expired: true,
      TailscaleIPs: ["100.64.0.20"],
    },
  });
  const summary = await runTailscaleLinkPreflight({
    target: "remote-box",
    ports: [3000, 24800],
    timeoutMs: 1000,
    pingCount: 3,
    minPongs: 3,
    expectedIDHash: "",
    expectedPublicKeyHash: "",
    requireDirect: true,
    requireTun: true,
    requireTCP: true,
    commandRunner: fakeTailscaleRunner({
      status,
      discoPing: derpPongs(3),
      icmpPing: "",
    }),
    tcpChecker: async () => "timeout",
  });

  assert.equal(summary.checks.status, "failed");
  assert.equal(summary.target.expired, true);
  assert.equal(summary.target.online, false);
  assert.equal(summary.tailscale_ping.route, "derp");
  assert.equal(summary.tun_ping.pongs, 0);
  assert.deepEqual(
    summary.checks.items
      .filter((item) => item.status === "failed")
      .map((item) => item.name),
    [
      "target_peer_not_expired",
      "target_peer_online",
      "tailscale_direct_path",
      "tailscale_tun_ping",
      "tcp_3000",
      "tcp_24800",
    ],
  );
  const encoded = JSON.stringify(summary);
  assert.doesNotMatch(encoded, /remote-box/);
  assert.doesNotMatch(encoded, /operator-remote-box/);
  assert.doesNotMatch(encoded, /100\.64\.0\.20/);
  assert.doesNotMatch(encoded, /expired-node-id/);
  assert.doesNotMatch(encoded, /expired-public-key/);
});

test("runTailscaleLinkPreflight fails expected identity mismatches", async () => {
  const status = statusPayload({
    peer: {
      HostName: "remote-box",
      ID: "current-node-id",
      PublicKey: "nodekey:current-public-key",
      Online: true,
      Expired: false,
      TailscaleIPs: ["100.64.0.30"],
    },
  });
  const summary = await runTailscaleLinkPreflight({
    target: "remote-box",
    ports: [],
    timeoutMs: 1000,
    pingCount: 1,
    minPongs: 1,
    expectedIDHash: hash("different-node-id"),
    expectedPublicKeyHash: "",
    requireDirect: true,
    requireTun: false,
    requireTCP: false,
    commandRunner: fakeTailscaleRunner({
      status,
      discoPing: directPongs(1),
      icmpPing: "",
    }),
    tcpChecker: async () => "open",
  });

  const identityCheck = summary.checks.items.find(
    (item) => item.name === "target_identity_matches_expected",
  );
  assert.deepEqual(identityCheck, {
    name: "target_identity_matches_expected",
    status: "failed",
    actual: "mismatch",
    expected: "expected_hash",
  });
  assert.equal(summary.checks.status, "failed");
  assert.doesNotMatch(JSON.stringify(summary), /current-node-id|current-public-key/);
});

test("runTailscaleLinkPreflight can allow DERP-only diagnostics when strict gates are disabled", async () => {
  const status = statusPayload({
    peer: {
      HostName: "remote-box",
      ID: "derp-node-id",
      PublicKey: "nodekey:derp-public-key",
      Online: true,
      Expired: false,
      TailscaleIPs: ["100.64.0.40"],
    },
  });
  const summary = await runTailscaleLinkPreflight({
    target: "remote-box",
    ports: [24800],
    timeoutMs: 1000,
    pingCount: 3,
    minPongs: 3,
    expectedIDHash: "",
    expectedPublicKeyHash: "",
    requireDirect: false,
    requireTun: false,
    requireTCP: false,
    commandRunner: fakeTailscaleRunner({
      status,
      discoPing: derpPongs(3),
      icmpPing: "",
    }),
    tcpChecker: async () => "timeout",
  });

  assert.equal(summary.checks.status, "passed");
  assert.equal(summary.tailscale_ping.route, "derp");
  assert.deepEqual(summary.tcp.ports, [{ port: 24800, status: "timeout" }]);
});

function fakeTailscaleRunner({ status, discoPing, icmpPing }) {
  return async (_command, args) => {
    if (args[0] === "status") {
      return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    }
    if (args[0] === "ping" && args.includes("--icmp")) {
      return { exitCode: icmpPing ? 0 : 1, stdout: icmpPing, stderr: "" };
    }
    if (args[0] === "ping") {
      return { exitCode: discoPing ? 0 : 1, stdout: discoPing, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
}

function statusPayload({ peer }) {
  return {
    BackendState: "Running",
    Self: {
      Online: true,
      Expired: false,
    },
    Peer: {
      [peer.PublicKey]: peer,
    },
  };
}

function directPongs(count) {
  return Array.from({ length: count }, (_value, index) => `pong from peer direct ${index + 1}ms`).join("\n");
}

function derpPongs(count) {
  return Array.from({ length: count }, (_value, index) => `pong from peer via DERP(tok) ${index + 1}ms`).join("\n");
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}
