#!/usr/bin/env node
import { createHash } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PING_COUNT = 3;
const DEFAULT_PORTS = [3000, 24800];

export function buildTailscaleLinkPreflightConfig(argv = process.argv, env = process.env) {
  const args = parseArgs(argv);
  const target = String(args.target || env.TAILSCALE_PREFLIGHT_TARGET || "").trim();
  if (!target) {
    throw new Error("target is required; pass --target or set TAILSCALE_PREFLIGHT_TARGET");
  }
  const pingCount = readInteger(args["ping-count"] || env.TAILSCALE_PREFLIGHT_PING_COUNT, DEFAULT_PING_COUNT, 1, "ping-count");
  return {
    target,
    ports: readPorts(args.ports || env.TAILSCALE_PREFLIGHT_PORTS, DEFAULT_PORTS),
    timeoutMs: readInteger(args["timeout-ms"] || env.TAILSCALE_PREFLIGHT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, "timeout-ms"),
    pingCount,
    minPongs: readInteger(args["min-pongs"] || env.TAILSCALE_PREFLIGHT_MIN_PONGS, pingCount, 1, "min-pongs"),
    expectedIDHash: String(args["expected-id-hash"] || env.TAILSCALE_PREFLIGHT_EXPECTED_ID_HASH || "").trim(),
    expectedPublicKeyHash: String(
      args["expected-public-key-hash"] || env.TAILSCALE_PREFLIGHT_EXPECTED_PUBLIC_KEY_HASH || "",
    ).trim(),
    requireDirect: readBoolean(args["require-direct"] || env.TAILSCALE_PREFLIGHT_REQUIRE_DIRECT, true, "require-direct"),
    requireTun: readBoolean(args["require-tun"] || env.TAILSCALE_PREFLIGHT_REQUIRE_TUN, true, "require-tun"),
    requireTCP: readBoolean(args["require-tcp"] || env.TAILSCALE_PREFLIGHT_REQUIRE_TCP, true, "require-tcp"),
  };
}

export async function runTailscaleLinkPreflight(config) {
  const commandRunner = config.commandRunner || runCommand;
  const tcpChecker = config.tcpChecker || checkTCPPort;
  const summary = {
    target: {
      found: false,
      online: false,
      expired: false,
      id_hash: "",
      public_key_hash: "",
    },
    tailscale_ping: null,
    tun_ping: null,
    tcp: {
      ports: [],
    },
  };
  const checks = [];

  const statusResult = await commandRunner("tailscale", ["status", "--json"], { timeoutMs: config.timeoutMs });
  if (statusResult.exitCode !== 0) {
    checks.push({
      name: "tailscale_status",
      status: "failed",
      actual: "unavailable",
      expected: "json_status",
    });
    summary.checks = buildChecksSummary(checks);
    return summary;
  }

  let statusPayload;
  try {
    statusPayload = JSON.parse(statusResult.stdout || "{}");
  } catch {
    checks.push({
      name: "tailscale_status",
      status: "failed",
      actual: "invalid_json",
      expected: "json_status",
    });
    summary.checks = buildChecksSummary(checks);
    return summary;
  }

  checks.push({
    name: "tailscale_status",
    status: "passed",
    actual: String(statusPayload.BackendState || "unknown"),
    expected: "json_status",
  });

  const peer = findTargetPeer(statusPayload, config.target);
  if (peer) {
    summary.target = summarizePeer(peer);
  }
  checks.push({
    name: "target_peer_present",
    status: summary.target.found ? "passed" : "failed",
    actual: summary.target.found ? "found" : "missing",
    expected: "found",
  });
  if (summary.target.found) {
    checks.push({
      name: "target_peer_not_expired",
      status: !summary.target.expired ? "passed" : "failed",
      actual: summary.target.expired ? "expired" : "valid",
      expected: "valid",
    });
    checks.push({
      name: "target_peer_online",
      status: summary.target.online ? "passed" : "failed",
      actual: summary.target.online ? "online" : "offline",
      expected: "online",
    });
  }
  if (config.expectedIDHash || config.expectedPublicKeyHash) {
    const idMatches = config.expectedIDHash && summary.target.id_hash === config.expectedIDHash;
    const publicKeyMatches =
      config.expectedPublicKeyHash && summary.target.public_key_hash === config.expectedPublicKeyHash;
    checks.push({
      name: "target_identity_matches_expected",
      status: idMatches || publicKeyMatches ? "passed" : "failed",
      actual: summary.target.found ? "mismatch" : "missing",
      expected: "expected_hash",
    });
  }

  const pingTarget = peer?.address || config.target;
  summary.tailscale_ping = await runTailscalePing(commandRunner, pingTarget, config, []);
  checks.push({
    name: "tailscale_ping_pongs",
    status: summary.tailscale_ping.pongs >= config.minPongs ? "passed" : "failed",
    actual: summary.tailscale_ping.pongs,
    expected_min: config.minPongs,
  });
  checks.push({
    name: "tailscale_direct_path",
    status: !config.requireDirect || summary.tailscale_ping.direct > 0 ? "passed" : "failed",
    actual: summary.tailscale_ping.direct > 0 ? "direct" : summary.tailscale_ping.route,
    expected: "direct",
  });

  summary.tun_ping = await runTailscalePing(commandRunner, pingTarget, config, ["--icmp"]);
  checks.push({
    name: "tailscale_tun_ping",
    status: !config.requireTun || summary.tun_ping.pongs >= config.minPongs ? "passed" : "failed",
    actual: summary.tun_ping.pongs,
    expected_min: config.minPongs,
  });

  for (const port of config.ports) {
    const status = peer?.address
      ? await tcpChecker(peer.address, port, config.timeoutMs)
      : "skipped";
    summary.tcp.ports.push({ port, status });
    checks.push({
      name: `tcp_${port}`,
      status: !config.requireTCP || status === "open" ? "passed" : "failed",
      actual: status,
      expected: "open",
    });
  }

  summary.checks = buildChecksSummary(checks);
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith("--") ? argv[++index] : "true";
  }
  return args;
}

function readInteger(raw, fallback, minimum, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function readBoolean(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  switch (String(raw).trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
      return false;
    default:
      throw new Error(`${name} must be true or false`);
  }
}

function readPorts(raw, fallback) {
  const value = raw === undefined || raw === null || raw === "" ? fallback.join(",") : String(raw);
  if (value.trim().toLowerCase() === "none") return [];
  const ports = value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0 && item < 65536);
  if (ports.length === 0 && value.trim()) {
    throw new Error("ports must be a comma-separated list of TCP port numbers or none");
  }
  return Array.from(new Set(ports));
}

function findTargetPeer(statusPayload, target) {
  const normalizedTarget = normalizePeerName(target);
  const peers = statusPayload?.Peer && typeof statusPayload.Peer === "object" ? statusPayload.Peer : {};
  const candidates = [];
  for (const [mapKey, peer] of Object.entries(peers)) {
    const names = peerNames(peer, mapKey);
    const candidate = { peer, mapKey, names };
    candidates.push(candidate);
    if (names.exact.includes(normalizedTarget)) {
      return { ...peer, mapKey, address: firstTailnetAddress(peer) };
    }
  }
  if (normalizedTarget.length >= 5 && !looksLikeAddress(normalizedTarget)) {
    const fuzzy = candidates.find(({ names }) =>
      names.fuzzy.some((name) => name.includes(normalizedTarget) || normalizedTarget.includes(name)),
    );
    if (fuzzy) {
      return { ...fuzzy.peer, mapKey: fuzzy.mapKey, address: firstTailnetAddress(fuzzy.peer) };
    }
  }
  return null;
}

function peerNames(peer, mapKey) {
  const humanNames = [peer.HostName, peer.DNSName, peer.ComputedName].map(normalizePeerName).filter(Boolean);
  return {
    exact: [
      ...humanNames,
      normalizePeerName(mapKey),
      ...(Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []).map(normalizePeerName),
    ].filter(Boolean),
    fuzzy: humanNames,
  };
}

function summarizePeer(peer) {
  return {
    found: true,
    online: peer.Online === true,
    expired: peerExpired(peer),
    id_hash: anonymizedHash(peer.ID),
    public_key_hash: anonymizedHash(peer.PublicKey || peer.mapKey),
  };
}

function peerExpired(peer) {
  if (peer.Expired === true) return true;
  if (!peer.KeyExpiry) return false;
  const timestamp = Date.parse(peer.KeyExpiry);
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

function firstTailnetAddress(peer) {
  return Array.isArray(peer?.TailscaleIPs) && peer.TailscaleIPs.length > 0
    ? String(peer.TailscaleIPs[0])
    : "";
}

function normalizePeerName(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function looksLikeAddress(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":");
}

function anonymizedHash(value) {
  const raw = String(value || "");
  if (!raw) return "";
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

async function runTailscalePing(commandRunner, target, config, extraArgs) {
  const result = await commandRunner(
    "tailscale",
    [
      "ping",
      ...extraArgs,
      "--c",
      String(config.pingCount),
      "--until-direct=false",
      "--timeout",
      `${Math.ceil(config.timeoutMs / 1000)}s`,
      target,
    ],
    { timeoutMs: Math.max(config.timeoutMs * config.pingCount + 1000, config.timeoutMs) },
  );
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const pongs = countMatches(text, /\bpong from\b/gi);
  const direct = countMatches(text, /\bdirect\b/gi);
  const derp = countMatches(text, /\bvia DERP\b/gi);
  return {
    status: pongs > 0 ? "ok" : "failed",
    pongs,
    direct,
    derp,
    route: direct > 0 ? "direct" : derp > 0 ? "derp" : "none",
    exit_code: Number(result.exitCode ?? 0),
  };
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

async function checkTCPPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", () => finish("closed"));
    socket.connect(port, host);
  });
}

function buildChecksSummary(items) {
  return {
    status: items.some((item) => item.status === "failed") ? "failed" : "passed",
    items,
  };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : null;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: Number(exitCode ?? 1), signal, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      stderr += error.message || "command failed";
      finish(1, null);
    });
    child.once("close", finish);
  });
}

async function main() {
  try {
    const config = buildTailscaleLinkPreflightConfig(process.argv, process.env);
    const summary = await runTailscaleLinkPreflight(config);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.checks.status === "failed") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message || "tailscale link preflight failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
