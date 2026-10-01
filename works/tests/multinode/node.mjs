import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  api, sleep as _sleep, waitFor, BASE, NODE_ROOT, ensureDirs,
  nodeDir, nodeConfigPath, nodeAccessLog, nodePid, nodeAlive, waitPortFree,
  stopNodeProcess, portOpen, readJson, GAME_IMAGE,
} from "./harness.mjs";

const execFileAsync = promisify(execFile);

/**
 * Create a Wings node through the same endpoint the UI uses, then install it by
 * fetching the panel's real install script and executing it in --local-test mode.
 */
export async function createAndInstallNode(token, spec) {
  const {
    label, name, fqdn, ipv4, wingsPort, allocationPort,
    protocol = "http", tlsCert, tlsKey, extraAllocations = [],
    heartbeatInterval = 3000, offlineThreshold = 12000,
    memory = 512, cpuLimit = 1, swap = 0, image = GAME_IMAGE,
    invocation = "node /srv/server.js",
    install = true,
  } = spec;

  const allocations = [{ ip: ipv4, port: allocationPort, alias: `${name} alloc` }, ...extraAllocations];

  const created = await api("/api/nodes", {
    method: "POST",
    token,
    body: {
      name,
      fqdn,
      hostname: fqdn,
      publicIpV4: ipv4,
      wingsPort,
      protocol,
      ssl: protocol === "https",
      allocations,
      heartbeatInterval,
      offlineThreshold,
      memory,
      cpuLimit,
      disk: 50000,
      swap,
      defaultImage: image,
      defaultInvocation: invocation,
      tlsCert,
      tlsKey,
    },
  });

  if (!created?.node?.id) {
    const err = new Error(`node create failed for ${name}: ${JSON.stringify(created)}`);
    err.response = created;
    throw err;
  }

  const node = created.node;
  // The create response deliberately strips secrets from `node`; the token is top-level.
  const registrationToken = created.registrationToken;
  if (!registrationToken) {
    throw new Error(`node create response has no registrationToken: ${JSON.stringify(created).slice(0, 300)}`);
  }
  if (!install) return { node: { ...node, registrationToken }, label, spec };

  const dir = nodeDir(label);
  await fs.mkdir(dir, { recursive: true });

  // A previous run or an aborted attempt may still hold this port; the installer
  // would then fail with EADDRINUSE for a reason unrelated to what we test.
  const free = await waitPortFree(wingsPort, 20000);
  if (!free) throw new Error(`Wings port ${wingsPort} for ${name} is still in use before install`);

  const cfg = await api(`/api/nodes/${node.id}/configuration`, { token });
  if (!cfg?.registrationToken || !cfg?.localTestCommand) {
    throw new Error(`configuration endpoint incomplete for ${name}: ${JSON.stringify(cfg).slice(0, 400)}`);
  }
  const installUrl = `${cfg.panelUrl}/api/wings/install`;

  // Runs the exact command the panel shows operators, piped through curl, so the
  // real documented path is exercised rather than a test-only shortcut.
  let proc;
  try {
    proc = await execFileAsync(
      "bash",
      [
        "-c",
        'set -euo pipefail; curl -fsSL "$1" | bash -s -- "${@:2}"',
        "wings-install",
        installUrl,
        registrationToken,
        "--local-test",
        "--dir", dir,
        "--data-dir", path.join(dir, "data"),
        "--log-dir", path.join(dir, "logs"),
        "--port", String(wingsPort),
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120000 }
    );
  } catch (err) {
    throw new Error(
      `installer failed for ${name} (exit ${err.code ?? "?"}):\n${err.stdout || ""}\n${err.stderr || ""}`
    );
  }

  await waitFor(async () => nodeAlive(label), { timeout: 20000, label: `wings process for ${name}` });

  const online = await waitFor(async () => {
    const n = await api(`/api/nodes/${node.id}`, { token });
    return n?.status === "online" ? n : null;
  }, { timeout: 30000, interval: 500, label: `node ${name} online` });

  return { node: online, label, spec, registrationToken, installOutput: proc.stdout, installStderr: proc.stderr };
}

/** Call a Wings API endpoint directly with a node's own credentials. */
export async function wingsCall(label, endpoint, { method = "GET", body, secret, port, scheme = "http" } = {}) {
  const apiSecret = secret ?? (await readNodeSecret(label));
  const headers = { Authorization: `Bearer ${apiSecret}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${scheme}://127.0.0.1:${port ?? (await readNodePort(label))}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers };
}

export async function readNodeSecret(label) {
  const cfg = await fs.readFile(nodeConfigPath(label), "utf8");
  const m = cfg.match(/^api_secret:\s*"?([^"\n]+)"?\s*$/m);
  if (!m) throw new Error(`api_secret not found in config for ${label}`);
  return m[1].trim();
}

export async function readNodePort(label) {
  const cfg = await fs.readFile(nodeConfigPath(label), "utf8");
  const m = cfg.match(/^port:\s*(\d+)\s*$/m);
  if (!m) throw new Error(`port not found in config for ${label}`);
  return Number(m[1]);
}

export async function readNodeConfigText(label) {
  return fs.readFile(nodeConfigPath(label), "utf8");
}

/** Give a just-registered node its TLS material, restart it, and wait for a secure heartbeat. */
export async function enableTlsOnNode(token, nodeId, { certPath, keyPath }) {
  const res = await api(`/api/nodes/${nodeId}/tls`, {
    method: "POST", token, body: { cert: certPath, key: keyPath },
  });
  if (!res?.success) throw new Error(`tls enable failed: ${JSON.stringify(res)}`);
  return res;
}

export { sleep, waitFor, api, portOpen, readJson, stopNodeProcess, nodeAlive, nodePid, nodeAccessLog, NODE_ROOT, BASE, ensureDirs };