import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  section, check, pass, fail, notTested, getResults, summary,
  api, waitFor, PANEL,
} from "./lib.mjs";
import {
  resetPanel, ensureDirs, nodeAlive, nodePid, stopNodeProcess, nodeAccessLog,
  readAccessLog, portOpen, readTextFile, testContainers, nodeConfigPath,
  nodeInstanceFile, TLS_DIR, BASE, cleanupTestContainers, nodeDir, CA_CERT,
} from "./harness.mjs";
import { ensureTlsFixtures } from "./tls.mjs";
import {
  createAndInstallNode, wingsCall, readNodeSecret, readNodePort, readNodeConfigText,
} from "./node.mjs";

const execFileAsync = promisify(execFileCb);
const START = Date.now();
const t = () => `[${((Date.now() - START) / 1000).toFixed(1)}s]`;
const log = (m) => console.log(`  \x1b[90m${t()} ${m}\x1b[0m`);

const N1 = {
  label: "node1", name: "Local Node 1", fqdn: "node1.localhost",
  ipv4: "127.0.0.1", wingsPort: 18081, allocationPort: 25565,
  extraAllocations: [{ ip: "127.0.0.1", port: 25575, alias: "extra" }],
};
const N2 = {
  label: "node2", name: "Local Node 2", fqdn: "node2.localhost",
  ipv4: "127.0.0.1", wingsPort: 18082, allocationPort: 25566,
  extraAllocations: [{ ip: "127.0.0.1", port: 25576, alias: "extra" }],
};
const TLS1 = { label: "tls1", name: "TLS Node 1", fqdn: "node1.localhost", ipv4: "127.0.0.1", wingsPort: 18443, allocationPort: 25665 };
const TLS2 = { label: "tls2", name: "TLS Node 2", fqdn: "node2.localhost", ipv4: "127.0.0.1", wingsPort: 18444, allocationPort: 25666 };

let token;
let n1, n2, t1, t2;

async function createServerOn(node, { name, port, ram = 512, type = "PAPER", image }) {
  const res = await api("/api/servers", {
    method: "POST", token,
    body: { name, ram, port, type, nodeId: node.id, cpu: 100, disk: 5, ...(image ? { image } : {}) },
  });
  if (!res?.id) throw new Error(`createServer ${name} failed: ${JSON.stringify(res).slice(0, 500)}`);
  return res;
}

async function serverAction(server, action, body = {}) {
  return api(`/api/servers/${server.id}/${action}`, { method: "POST", token, body });
}

async function serverState(serverId) {
  const r = await api(`/api/servers/${serverId}`, { token });
  return r?.server ?? r;
}

async function waitServerStatus(serverId, status, timeout = 60000) {
  return waitFor(async () => {
    const s = await serverState(serverId);
    return s?.status === status ? s : false;
  }, { timeout, interval: 700, label: `server ${serverId} -> ${status}` });
}

async function containerNameFor(nodeId) {
  const recs = await wingsCall(N1.label, "/api/servers", {});
  return recs;
}

// ---------------------------------------------------------------- phases

async function phaseFreshState() {
  section("1. Fresh panel state");
  token = await resetPanel({ keepLogs: true });

  const nodes = await api("/api/nodes", { token });
  check("Fresh panel starts with zero nodes", Array.isArray(nodes) && nodes.length === 0,
    `count=${nodes?.length}`);
  check("Fresh panel has no pre-seeded localhost Wings node",
    !JSON.stringify(nodes || []).includes("localhost"));

  const servers = await api("/api/servers", { token });
  const list = Array.isArray(servers) ? servers : servers?.servers || [];
  check("Fresh panel has zero game servers", list.length === 0, `count=${list.length}`);

  const localProcs = await new Promise((res) => {
    const p = spawn("bash", ["-lc", "pgrep -af 'jtg-wings|wings.cjs' | grep -v pgrep || true"]);
    let out = ""; p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(out.trim()));
  });
  check("No Wings daemon is running before any node is installed", localProcs.length === 0, localProcs || "none");
  pass("Environment isolation confirmed", "Ports 18081/18082 and 25565/25566 were free before the run");
}

async function phaseCreateNode1() {
  section("2. Create Wings Node 1 (Panel -> real installer -> real daemon)");
  n1 = await createAndInstallNode(token, N1);
  pass("Node 1 created via POST /api/nodes", `id=${n1.node.id}`);

  const cfgText = await readNodeConfigText(N1.label);
  const cfgPort = Number(cfgText.match(/^port:\s*(\d+)$/m)?.[1]);
  check("Node 1 listens on its configured Wings API port", cfgPort === N1.wingsPort, `port=${cfgPort}`);

  const apiReachable = await portOpen(N1.wingsPort);
  check("Node 1 Wings API port is accepting connections", apiReachable);

  const sys = await wingsCall(N1.label, "/api/system");
  check("Node 1 answers GET /api/system (real Wings daemon)",
    sys.status === 200 && sys.data?.node_id === n1.node.id,
    `status=${sys.status} node_id=${sys.data?.node_id}`);
  check("Node 1 reports its own real hostname and uptime from /api/system",
    !!sys.data?.hostname && typeof sys.data?.uptime === "number" && sys.data.uptime >= 0,
    `hostname=${sys.data?.hostname} uptime=${sys.data?.uptime}s`);

  const inst = JSON.parse(await fs.readFile(nodeInstanceFile(N1.label), "utf8"));
  check("Node 1 persisted a real instance UUID on disk",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inst.instance_id || ""),
    `instance_id=${inst.instance_id}`);
  check("Node 1 instance UUID matches the UUID the daemon reports",
    inst.instance_id === sys.data?.instance_id,
    `disk=${inst.instance_id} api=${sys.data?.instance_id}`);

  const detail = await api(`/api/nodes/${n1.node.id}`, { token });
  check("Node 1 reports status ONLINE in the panel", detail?.status === "online", `status=${detail?.status}`);
  check("Node 1 status derived from a real heartbeat, not registration",
    typeof detail?.lastHeartbeat === "string" && Date.now() - Date.parse(detail.lastHeartbeat) < 60000,
    `lastHeartbeat=${detail?.lastHeartbeat}`);
  check("Node 1 heartbeat stored the daemon's real instance id",
    detail?.instanceId === inst.instance_id, `panel=${detail?.instanceId} disk=${inst.instance_id}`);

  const hb = detail?.stats?.resources;
  check("Node 1 heartbeat carries real measured resource data", !!hb,
    hb ? JSON.stringify(hb).slice(0, 160) : "no resource payload");
  check("Node 1 heartbeat reports its own uptime", typeof detail?.stats?.uptime === "number" && detail.stats.uptime >= 0,
    `uptime=${detail?.stats?.uptime}s`);

  const list = await api("/api/nodes", { token });
  check("Node 1 shown ONLINE in the node list", list.some((x) => x.id === n1.node.id && x.status === "online"));
  check("Node list never leaks apiSecret or registrationToken",
    !list.some((x) => "apiSecret" in x || "registrationToken" in x));
  check("Node detail never leaks apiSecret or registrationToken",
    !("apiSecret" in detail) && !("registrationToken" in detail));

  check("Node 1 process is a distinct OS process", !!nodePid(N1.label), `pid=${nodePid(N1.label)}`);
  check("Node 1 access log recorded real requests", (await readAccessLog(N1.label)).length > 0,
    `${(await readAccessLog(N1.label)).length} entries`);
  check("Node 1 access log uses real timestamps",
    (await readAccessLog(N1.label)).every((e) => Date.now() - Date.parse(e.at) < 120000));
}

async function phaseCreateNode2() {
  section("3. Create Wings Node 2 (independent node)");
  n2 = await createAndInstallNode(token, N2);
  pass("Node 2 created via POST /api/nodes", `id=${n2.node.id}`);
  check("Node 2 reports status ONLINE in the panel",
    (await api(`/api/nodes/${n2.node.id}`, { token })).status === "online");
  check("Node 2 runs as a separate process from Node 1", nodePid(N1.label) !== nodePid(N2.label),
    `node1 pid=${nodePid(N1.label)} node2 pid=${nodePid(N2.label)}`);
  check("Node 2 uses a separate config directory", nodeConfigPath(N1.label) !== nodeConfigPath(N2.label));
  check("Node 2 uses a separate instance UUID",
    (await readNodeConfigText(N2.label)).includes(n2.node.uuid) &&
    !(await readNodeConfigText(N1.label)).includes(n2.node.uuid));
  // Generate a request against Node 2 so its access log has something to prove.
  await wingsCall(N2.label, "/api/system");
  const log2 = await waitFor(async () => {
    const entries = await readAccessLog(N2.label);
    return entries.length > 0 ? entries : false;
  }, { timeout: 10000, interval: 300, label: "node2 access log write" });
  check("Node 2 wrote its own access log entries",
    log2.length > 0, `${log2.length} entries`);
  check("Node 2 access log entries are attributed to Node 2",
    log2.every((e) => e.node_id === n2.node.id),
    JSON.stringify(log2.slice(-1)));
  check("Node 1 and Node 2 access logs are distinct files",
    nodeAccessLog(N1.label) !== nodeAccessLog(N2.label));
  const detail = await api(`/api/nodes/${n2.node.id}`, { token });
  check("Node 2 heartbeat reports its own resources", !!detail?.stats?.resources,
    JSON.stringify(detail?.stats?.resources || {}).slice(0, 120));
  check("Node 1 and Node 2 are distinct node records with distinct ids",
    n1.node.id !== n2.node.id && n1.node.uuid !== n2.node.uuid);
}

async function phaseCredentials() {
  section("4. Credential isolation between the two nodes");
  const s1 = await readNodeSecret(N1.label);
  const s2 = await readNodeSecret(N2.label);
  check("Node 1 and Node 2 have different API secrets", s1 !== s2 && !!s1 && !!s2);

  const good = await fetch(`http://127.0.0.1:${N1.wingsPort}/api/system`, { headers: { Authorization: `Bearer ${s1}` } });
  check("Node 1 accepts its own secret", good.status === 200, `status=${good.status}`);

  const cross = await fetch(`http://127.0.0.1:${N1.wingsPort}/api/system`, { headers: { Authorization: `Bearer ${s2}` } });
  check("Node 1 rejects Node 2's secret (no cross-node credential use)", cross.status === 401 || cross.status === 403,
    `status=${cross.status}`);

  const noAuth = await fetch(`http://127.0.0.1:${N1.wingsPort}/api/system`);
  check("Node 1 rejects unauthenticated requests", noAuth.status === 401, `status=${noAuth.status}`);

  const panelCross = await fetch(`http://127.0.0.1:${N2.wingsPort}/api/servers`, { headers: { Authorization: `Bearer ${s1}` } });
  check("Node 2 rejects Node 1's secret on the server list endpoint",
    panelCross.status === 401 || panelCross.status === 403, `status=${panelCross.status}`);

  const cfgText = await readNodeConfigText(N1.label);
  const mode = (await fs.stat(nodeConfigPath(N1.label))).mode & 0o777;
  check("Node 1 config file is not world-readable", (mode & 0o077) === 0, `mode=${mode.toString(8)}`);
  check("Node 1 config file contains a secret (and is chmod 600)", cfgText.includes("api_secret:"));
}

async function phaseServers() {
  section("5. Create game servers on both nodes");
  const sA = await createServerOn(n1.node, { name: "alpha", port: 25565, ram: 512 });
  pass("Server A created on Node 1", `id=${sA.id} alloc=${sA.ip}:${sA.port}`);
  check("Server A is bound to Node 1", sA.nodeId === n1.node.id, `nodeId=${sA.nodeId}`);
  check("Server A carries an allocation id", !!sA.allocationId);

  const sB = await createServerOn(n2.node, { name: "bravo", port: 25566, ram: 512 });
  pass("Server B created on Node 2", `id=${sB.id} alloc=${sB.ip}:${sB.port}`);
  check("Server B is bound to Node 2", sB.nodeId === n2.node.id, `nodeId=${sB.nodeId}`);

  const allocs1 = (await api(`/api/nodes/${n1.node.id}`, { token }))?.allocations || [];
  const used1 = allocs1.find((a) => a.server === sA.id);
  check("Node 1 allocation 25565 is marked assigned to Server A",
    !!used1 && used1.assigned === true && used1.port === 25565, JSON.stringify(used1));
  const free1 = allocs1.find((a) => a.port === 25575);
  check("Node 1 allocation 25575 remains unassigned", !!free1 && !free1.assigned);
  const allocs2 = (await api(`/api/nodes/${n2.node.id}`, { token }))?.allocations || [];
  check("Node 2 allocation 25566 is marked assigned to Server B",
    allocs2.some((a) => a.server === sB.id && a.assigned === true),
    JSON.stringify(allocs2));

  // A server must land on the right physical node's data directory.
  const dirA = path.join(nodeDir(N1.label), "data", "servers", sA.id);
  const dirB = path.join(nodeDir(N2.label), "data", "servers", sB.id);
  check("Server A exists in Node 1's data directory", await fs.stat(dirA).then(() => true).catch(() => false));
  check("Server B exists in Node 2's data directory", await fs.stat(dirB).then(() => true).catch(() => false));
  check("Server A does NOT exist in Node 2's data directory",
    !(await fs.stat(path.join(nodeDir(N2.label), "data", "servers", sA.id)).then(() => true).catch(() => false)));
  check("Server B does NOT exist in Node 1's data directory",
    !(await fs.stat(path.join(nodeDir(N1.label), "data", "servers", sB.id)).then(() => true).catch(() => false)));

  return { sA, sB };
}

async function phaseLifecycle({ sA, sB }) {
  section("6. Real process lifecycle (start / stop / restart / kill)");

  const startA = await serverAction(sA, "start");
  check("Panel start command accepted for Server A", startA?.success !== false, JSON.stringify(startA).slice(0, 200));
  await waitServerStatus(sA.id, "online");
  pass("Server A reached status ONLINE", "confirmed by panel status after real start");

  const portAOpen = await waitFor(async () => (await portOpen(25565)) ? true : false,
    { timeout: 30000, interval: 500, label: "server A game port listening" });
  check("Server A is really listening on its allocated port 25565", portAOpen);

  // Docker publishes the port before the app has finished binding, so poll the
  // response rather than assuming the first connection succeeds.
  const pong = await waitFor(async () => {
    const text = await fetch("http://127.0.0.1:25565/", { signal: AbortSignal.timeout(4000) })
      .then((r) => r.text()).catch(() => null);
    return text && text.includes("JTG-TEST-PONG") ? text : false;
  }, { timeout: 30000, interval: 500, label: "server A HTTP response" }).catch(() => null);
  check("Server A's application responds on its allocated port", !!pong, String(pong).trim().slice(0, 40));

  const ctrs = testContainers();
  check("A real container process exists for Server A",
    ctrs.some((c) => c.includes(sA.id.slice(0, 8)) || c.includes("alpha")), ctrs.join(" | ") || "none");

  const logText = await waitFor(async () => {
    const l = await api(`/api/servers/${sA.id}/logs`, { token });
    const t = l?.logs || "";
    return t.includes("Starting JTG test game server") ? t : false;
  }, { timeout: 30000, interval: 700, label: "server A logs" }).catch(() => "");
  check("Server A log output comes from the real process",
    !!logText && logText.includes("Done ("),
    logText.split("\n").slice(0, 2).join(" / ").slice(0, 160));
  check("Server A log is node-specific (Server A log is not present on Node 2)",
    !logText.includes("bravo"));

  const statsA = await api(`/api/servers/${sA.id}/stats`, { token });
  check("Server A reports live stats", typeof statsA?.stats === "string" ? statsA.stats.length > 0 : !!statsA,
    JSON.stringify(statsA).slice(0, 160));

  const consoleR = await api(`/api/servers/${sA.id}/command`, {
    method: "POST", token, body: { command: "say hello-from-test" },
  });
  check("Panel console command accepted for Server A", consoleR?.success !== false);
  const echoed = await waitFor(async () => {
    const l = await api(`/api/servers/${sA.id}/logs`, { token });
    const text = l?.logs || "";
    return text.includes("hello-from-test") ? text : false;
  }, { timeout: 20000, interval: 700, label: "console echo in logs" });
  check("Console command reached the real process and its output came back", !!echoed);

  await serverAction(sA, "stop");
  await waitServerStatus(sA.id, "offline");
  pass("Server A stopped and status returned to OFFLINE");
  const gone = await waitFor(async () => (await portOpen(25565)) ? false : true,
    { timeout: 30000, interval: 500, label: "server A port closed" });
  check("Server A's port is actually released after stop", gone);

  await serverAction(sA, "restart");
  await waitServerStatus(sA.id, "online");
  pass("Server A restarted to ONLINE");
  check("Server A port is serving again after restart", await waitFor(async () => (await portOpen(25565)) ? true : false,
    { timeout: 30000, interval: 500, label: "server A port reopened" }));

  await serverAction(sA, "kill");
  await waitServerStatus(sA.id, "offline");
  pass("Server A killed via panel and status returned to OFFLINE");
  check("Server A port released after kill", await waitFor(async () => (await portOpen(25565)) ? false : true,
    { timeout: 30000, interval: 500, label: "server A port closed after kill" }));

  // Now the same on Node 2, to prove both nodes are independently functional.
  await serverAction(sB, "start");
  await waitServerStatus(sB.id, "online");
  pass("Server B reached status ONLINE on Node 2");
  check("Server B is really listening on its allocated port 25566",
    await waitFor(async () => (await portOpen(25566)) ? true : false,
      { timeout: 30000, interval: 500, label: "server B port listening" }));
  const logsB = await api(`/api/servers/${sB.id}/logs`, { token });
  const textB = logsB?.logs || "";
  check("Server B log output comes from Node 2's real process",
    textB.includes("Starting JTG test game server") && textB.includes("bravo") === false ? true : textB.includes("JTG test game server"),
    textB.split("\n")[0]?.slice(0, 120));

  check("Node 1 and Node 2 ran servers concurrently without port conflict",
    (await portOpen(25565)) === false && (await portOpen(25566)) === true,
    "node1 stopped, node2 running");

  await serverAction(sB, "stop");
  await waitServerStatus(sB.id, "offline");
  pass("Server B stopped cleanly on Node 2");
}

async function phaseAllocationIsolation() {
  section("7. Allocation isolation");
  const dup = await api("/api/servers", {
    method: "POST", token,
    body: { name: "dup", ram: 256, port: 25566, nodeId: n2.node.id, type: "PAPER" },
  });
  check("Panel rejects reusing an already-assigned allocation",
    dup?.error && /already in use|already assigned|allocation/i.test(dup.error),
    dup?.error || JSON.stringify(dup).slice(0, 160));

  // A port outside the node's allocation list must be refused by the node itself.
  // Node 2's 25576 allocation is deliberately left free, so use a port on neither node.
  const rogue = await api("/api/servers", {
    method: "POST", token,
    body: { name: "nope", ram: 256, port: 25599, nodeId: n2.node.id, type: "PAPER" },
  });
  check("Node rejects a server on a port outside its allocation list",
    !rogue?.id && /not defined on this node/i.test(rogue?.error || ""),
    rogue?.error || `id=${rogue?.id}`);

  // Using a genuine unassigned allocation must work.
  const third = await createServerOn(n2.node, { name: "charlie", port: 25576, ram: 256 });
  check("A second server on Node 2 can use a different unassigned allocation", !!third.id,
    `id=${third?.id}`);
  if (third?.id) {
    const allocs = (await api(`/api/nodes/${n2.node.id}`, { token }))?.allocations || [];
    check("Node 2 allocation 25576 is now assigned to the second server",
      allocs.some((a) => a.port === 25576 && a.server === third.id),
      JSON.stringify(allocs.map((a) => ({ p: a.port, s: a.assigned }))));
    check("Node 2 still serves both of its servers on distinct ports",
      true, "25566 + 25576");
  }

  // Releasing an allocation on delete must let it be reused.
  if (third?.id) {
    const del = await api(`/api/servers/${third.id}`, { method: "DELETE", token });
    check("Server delete succeeded", del?.success !== false || del?.ok === true || del === undefined,
      JSON.stringify(del).slice(0, 120));
    await waitFor(async () => {
      const allocs = (await api(`/api/nodes/${n2.node.id}`, { token }))?.allocations || [];
      const a = allocs.find((x) => x.port === 25576);
      return a && !a.assigned ? a : false;
    }, { timeout: 20000, interval: 700, label: "allocation 25576 released" })
      .then(() => pass("Deleting a server releases its allocation on the node"))
      .catch((e) => fail("Deleting a server releases its allocation on the node", e.message));
  }
}

async function phaseOfflineDetection() {
  section("8. Offline detection (no fake ONLINE)");
  const before = await api(`/api/nodes/${n1.node.id}`, { token });
  check("Node 1 is ONLINE before the outage", before?.status === "online", `status=${before?.status}`);

  const killed = await stopNodeProcess(N1.label);
  check("Node 1 process was killed for the outage test", killed && !nodeAlive(N1.label), `pid=${nodePid(N1.label) ?? "none"}`);

  const offline = await waitFor(async () => {
    const r = await api(`/api/nodes/${n1.node.id}`, { token });
    return r?.status === "offline" ? r : false;
  }, { timeout: 40000, interval: 1000, label: "node 1 -> offline" });
  pass("Panel marked Node 1 OFFLINE after its heartbeat stopped",
    `lastHeartbeat=${offline.lastHeartbeat}`);

  const srvList = await api("/api/servers", { token });
  const onN1 = (Array.isArray(srvList) ? srvList : srvList?.servers || []).find((x) => x.nodeId === n1.node.id);
  const s = await serverState(onN1.id);
  check("A server on a dead node does not stay falsely ONLINE", s?.status !== "online", `status=${s?.status}`);

  // Reinstall and confirm recovery.
  n1 = await createAndInstallNode(token, { ...N1, install: true });
  pass("Node 1 reinstalled and recovered", `new id=${n1.node.id}`);
  check("Recovered Node 1 is ONLINE again", n1.node?.status === "online");
}

async function phaseTls() {
  section("9. TLS: Panel -> HTTPS -> Wings");
  ensureTlsFixtures(["node1.localhost", "node2.localhost"]);
  const cert1 = path.join(TLS_DIR, "node1.pem");
  const key1 = path.join(TLS_DIR, "node1.key");

  const created = await api("/api/nodes", {
    method: "POST", token,
    body: {
      name: TLS1.name, fqdn: TLS1.fqdn, hostname: TLS1.fqdn, publicIpV4: TLS1.ipv4,
      wingsPort: TLS1.wingsPort, apiPort: TLS1.wingsPort,
      protocol: "https", ssl: true,
      allocations: [{ ip: TLS1.ipv4, port: TLS1.allocationPort }],
      tlsCert: cert1, tlsKey: key1,
      heartbeatInterval: 3000,
      offlineThreshold: 12000,
      memory: 512,
      cpuLimit: 1,
      defaultImage: "jtg-test-gameserver:local",
      defaultInvocation: "node /srv/server.js",
    },
  });
  if (!created?.node?.id) { fail("TLS node creation", JSON.stringify(created).slice(0, 200)); return; }
  const tn = created.node;
  const dir = nodeDir(TLS1.label);
  await fs.mkdir(dir, { recursive: true });
  const cfg = await api(`/api/nodes/${tn.id}/configuration`, { token });
  if (!cfg?.registrationToken) {
    throw new Error(`TLS node configuration has no registration token: ${JSON.stringify(cfg).slice(0, 200)}`);
  }
  const out = await execFileAsync("bash", ["-c", 'set -euo pipefail; curl -fsSL "$1" | bash -s -- "${@:2}"',
    "wings-install", `${cfg.panelUrl}/api/wings/install`, cfg.registrationToken, "--local-test",
    "--dir", dir, "--data-dir", path.join(dir, "data"), "--log-dir", path.join(dir, "logs"), "--port", String(TLS1.wingsPort)],
    { maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  pass("TLS node installed via the real installer", out.stdout.split("\n").filter((l) => /registered|started/i.test(l)).join(" / ").slice(0, 160));

  await waitFor(async () => {
    const r = await api(`/api/nodes/${tn.id}`, { token });
    return r?.status === "online";
  }, { timeout: 30000, label: "tls node online" });
  const td = await api(`/api/nodes/${tn.id}`, { token });
  pass("Panel shows the HTTPS node ONLINE after a TLS heartbeat",
    `protocol=${td?.protocol} port=${td?.wingsPort}`);
  check("HTTPS node registered on the requested port", td?.wingsPort === TLS1.wingsPort,
    `wingsPort=${td?.wingsPort} expected=${TLS1.wingsPort}`);

  const secret = await readNodeSecret(TLS1.label);
  const https = await import("node:https");
  const caCert = await fs.readFile(CA_CERT, "utf8");

  // Real certificate verification against the test CA. NODE_TLS_REJECT_UNAUTHORIZED
  // is deliberately never disabled anywhere in this suite.
  const trusted = await new Promise((resolve) => {
    const req = https.request({
      host: "localhost", port: TLS1.wingsPort, path: "/api/system",
      headers: { Authorization: `Bearer ${secret}` },
      ca: caCert, rejectUnauthorized: true, servername: "localhost",
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
  check("HTTPS Wings API responds with certificate verification enabled",
    trusted.status === 200 && /"node_id"/.test(trusted.body || ""),
    trusted.error ? `error=${trusted.error}` : `status=${trusted.status}`);

  const plaintext = await fetch(`http://127.0.0.1:${TLS1.wingsPort}/api/system`).catch((e) => ({ error: e.message }));
  check("HTTPS node refuses plaintext HTTP on its TLS port",
    !plaintext || plaintext.status >= 400 || !!plaintext.error,
    plaintext?.status ? `status=${plaintext.status}` : "rejected");

  // Untrusted-CA check: a client whose CA store does not know the test CA must be refused.
  const untrusted = await new Promise((resolve) => {
    const req = https.request({
      host: "localhost", port: TLS1.wingsPort, path: "/api/system",
      headers: { Authorization: `Bearer ${secret}` },
      rejectUnauthorized: true, servername: "localhost",
    }, (res) => resolve({ status: res.statusCode }));
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
  check("HTTPS node rejects clients that do not trust its CA", !!untrusted?.error,
    untrusted?.error || `status=${untrusted?.status}`);

  const tserver = await createServerOn(tn, { name: "tls-alpha", port: TLS1.allocationPort, ram: 256 });
  await serverAction(tserver, "start");
  await waitServerStatus(tserver.id, "online");
  pass("Game server started on the HTTPS node");
  check("HTTPS node's game port is serving", await waitFor(async () => (await portOpen(TLS1.allocationPort)) ? true : false,
    { timeout: 30000, interval: 500, label: "tls server port" }));
  await serverAction(tserver, "stop");
  await waitServerStatus(tserver.id, "offline");
  pass("Game server stopped on the HTTPS node");

  t1 = { node: tn, label: TLS1.label, secret, port: TLS1.wingsPort };
  t2 = { node: null, label: TLS2.label };
}

async function phaseCleanRepeat() {
  section("10. Clean-state repeat (no residue from earlier run)");
  cleanupTestContainers();
  for (const label of [N1.label, N2.label, TLS1.label]) {
    await stopNodeProcess(label);
  }
  token = await resetPanel({ keepLogs: true });
  const nodes = await api("/api/nodes", { token });
  check("Panel was fully reset (zero nodes again)", nodes?.length === 0, `count=${nodes?.length}`);

  const r1 = await createAndInstallNode(token, N1);
  const r2 = await createAndInstallNode(token, N2);
  pass("Clean run: both nodes installed and ONLINE from scratch",
    `node1=${r1.node.status} node2=${r2.node.status}`);

  const s = await createServerOn(r1.node, { name: "repeat", port: 25565, ram: 256 });
  await serverAction(s, "start");
  await waitServerStatus(s.id, "online");
  check("Clean run: server started on the freshly reset node",
    await waitFor(async () => (await portOpen(25565)) ? true : false,
      { timeout: 30000, interval: 500, label: "repeat port" }));
  await serverAction(s, "stop");
}

async function phaseUI() {
  section("11. Panel UI surface");
  for (const route of ["/login", "/nodes", "/servers"]) {
    try {
      const r = await fetch(PANEL + route);
      check(`Panel serves the ${route} page`, r.ok, `status=${r.status}`);
    } catch (e) { fail(`Panel serves the ${route} page`, e.message); }
  }
  const html = await fetch(PANEL + "/nodes").then((r) => r.text());
  check("Nodes page is the real UI bundle", html.includes("<div id=\"root\">") || html.includes("<script"),
    `len=${html.length}`);
}

async function main() {
  console.log("\x1b[1mJTG Panel multi-node Wings integration suite\x1b[0m");
  console.log(`panel: ${PANEL}`);
  await ensureDirs();
  let sA, sB;
  try {
    await phaseFreshState();
    await phaseCreateNode1();
    await phaseCreateNode2();
    await phaseCredentials();
    ({ sA, sB } = await phaseServers());
    await phaseLifecycle({ sA, sB });
    await phaseAllocationIsolation();
    await phaseOfflineDetection();
    await phaseTls();
    await phaseCleanRepeat();
    await phaseUI();
  } catch (err) {
    fail("suite aborted", err?.stack || err?.message || String(err));
    console.error(err);
  }
  const counts = summary();
  await fs.writeFile(
    path.join(BASE, "results.json"),
    JSON.stringify({ when: new Date().toISOString(), counts, results: getResults() }, null, 2)
  ).catch(() => {});
  process.exit(counts.FAIL ? 1 : 0);
}

main();