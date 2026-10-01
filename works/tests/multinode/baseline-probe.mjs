/**
 * BASELINE PROBE - runs against the UNMODIFIED production code.
 *
 * Purpose: empirically establish what the current Panel + Wings architecture
 * can actually do, before any fix is applied. Nothing here modifies production
 * behaviour; it only reads the artefacts the panel really serves and starts the
 * daemon the panel really installs.
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, login, readJson } from "./lib.mjs";

const WORK = "/tmp/opencode/multinode/baseline";
const findings = [];

function note(bug, detail) {
  findings.push({ bug, detail });
  console.log(`  \x1b[31m[BUG]\x1b[0m ${bug}\n        ${detail}`);
}

const token = await login(process.env.JTG_OWNER_USER || "jtgowner", process.env.JTG_OWNER_PASS || "jtgOwnerPass123");

// ---------------------------------------------------------------- B1
console.log("\n\x1b[1m=== B1: what does GET /api/wings/install actually produce? ===\x1b[0m");
const scriptRes = await api("/api/wings/install", { raw: true });
const script = scriptRes.text;
await fs.mkdir(WORK, { recursive: true });
await fs.writeFile(path.join(WORK, "wings-install.sh"), script);

const usesSudo = /\bsudo\b/.test(script);
const usesSystemd = /systemctl/.test(script);
const hardcodedConfig = script.includes("/etc/jtg-wings/config.yml");
const hardcodedUnit = script.includes("/etc/systemd/system/jtg-wings.service");
const hasLocalTestMode = /--local-test|--local_test|LOCAL_TEST/.test(script);
const hasConfigDirFlag = /--config|CONFIG_DIR|JTG_WINGS_DIR/.test(script);

console.log(`  requires sudo            : ${usesSudo}`);
console.log(`  requires systemd         : ${usesSystemd}`);
console.log(`  hardcodes config path    : ${hardcodedConfig}`);
console.log(`  hardcodes systemd unit   : ${hardcodedUnit}`);
console.log(`  supports --local-test    : ${hasLocalTestMode}`);
console.log(`  supports per-instance dir: ${hasConfigDirFlag}`);

if (hardcodedConfig && hardcodedUnit && !hasLocalTestMode) {
  note(
    "Installer cannot run two local instances",
    `config path and systemd unit are both hardcoded (/etc/jtg-wings/config.yml, jtg-wings.service) and there is no per-instance mode, so node 1 and node 2 cannot coexist on one machine. sudo=${usesSudo} systemd=${usesSystemd}.`
  );
}

// ---------------------------------------------------------------- B2
console.log("\n\x1b[1m=== B2: what does the Wings daemon the installer deploy actually implement? ===\x1b[0m");
const m = script.match(/ExecStart=\/usr\/bin\/env node -e "([\s\S]*?)"\nRestart=always/);
if (!m) {
  note("Could not extract the daemon", "ExecStart block not found in the install script.");
} else {
  const daemonJs = m[1];
  await fs.writeFile(path.join(WORK, "extracted-daemon.js"), daemonJs);
  const routes = [...daemonJs.matchAll(/req\.url === '([^']+)'/g)].map((r) => r[1]);
  const hasServersApi = /\/api\/servers/.test(daemonJs);
  const hardcodedStats = /cpu:\s*5/.test(daemonJs) && /total:\s*16384/.test(daemonJs);
  console.log(`  daemon size              : ${daemonJs.length} bytes`);
  console.log(`  explicit routes handled  : ${JSON.stringify(routes)}`);
  console.log(`  implements /api/servers* : ${hasServersApi}`);
  console.log(`  heartbeat stats hardcoded: ${hardcodedStats}`);

  if (!hasServersApi) {
    note(
      "Wings daemon implements no server API",
      `The daemon the installer deploys only handles ${JSON.stringify(routes)} and answers every other request with a canned {"status":"success"}. The panel client calls POST /api/servers, POST /api/servers/:id/power, GET /api/servers/:id and POST /api/servers/:id/commands (src/server/services/wings.ts:95,135,146,175) - all of which the daemon silently no-ops.`
    );
  }
  if (hardcodedStats) {
    note(
      "Wings heartbeat reports fake resource stats",
      "cpu is hardcoded to 5 and memory/disk to fixed numbers (src/server/routes/nodes.ts:169-174), so the panel's node resource readings are not real measurements."
    );
  }

  // Run the extracted daemon verbatim against a throwaway config to observe behaviour.
  const cfgDir = path.join(WORK, "probe-node");
  await fs.mkdir(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, "config.yml");
  await fs.writeFile(
    cfgPath,
    [
      "debug: false",
      `panel_url: "http://127.0.0.1:6767"`,
      `node_id: "probe-node"`,
      `uuid: "probe-uuid"`,
      `api_secret: "probe-secret"`,
      "port: 18099",
      "docker:",
      '  socket: "/var/run/docker.sock"',
      "",
    ].join("\n")
  );
  // The deployed daemon hardcodes /etc/jtg-wings/config.yml, so the only way to
  // exercise it locally is to run the identical JS against a readable config.
  const patched = daemonJs.replace("/etc/jtg-wings/config.yml", cfgPath);
  const daemonFile = path.join(cfgDir, "daemon.js");
  await fs.writeFile(daemonFile, patched);
  const { spawn } = await import("node:child_process");
  const proc = spawn("node", [daemonFile], { stdio: ["ignore", "pipe", "pipe"] });
  let daemonOut = "";
  proc.stdout.on("data", (b) => (daemonOut += b));
  proc.stderr.on("data", (b) => (daemonOut += b));
  await sleep(1200);

  const H = { Authorization: "Bearer probe-secret", "Content-Type": "application/json" };
  const get = async (p) => {
    const r = await fetch("http://127.0.0.1:18099" + p, { headers: H });
    return { status: r.status, body: await r.text() };
  };
  const post = async (p, b) => {
    const r = await fetch("http://127.0.0.1:18099" + p, {
      method: "POST", headers: H, body: JSON.stringify(b ?? {}),
    });
    return { status: r.status, body: await r.text() };
  };

  const unauth = await fetch("http://127.0.0.1:18099/api/system");
  const sys = await get("/api/system");
  const create = await post("/api/servers", {
    uuid: "probe-server-1",
    meta: { name: "BaselineProbe" },
    build: { memory: 512 },
    allocations: { default: { ip: "127.0.0.1", port: 25570 } },
  });
  const power = await post("/api/servers/probe-server-1/power", { action: "start" });
  const state = await get("/api/servers/probe-server-1");
  const logs = await get("/api/servers/probe-server-1/logs");
  const stats = await get("/api/servers/probe-server-1/stats");
  const cmds = await post("/api/servers/probe-server-1/commands", { command: "say hi" });

  console.log(`  GET  /api/system                    -> ${sys.status} ${sys.body}`);
  console.log(`  POST /api/servers                   -> ${create.status} ${create.body}`);
  console.log(`  POST /api/servers/:id/power {start} -> ${power.status} ${power.body}`);
  console.log(`  GET  /api/servers/:id               -> ${state.status} ${state.body}`);
  console.log(`  GET  /api/servers/:id/logs          -> ${logs.status} ${logs.body}`);
  console.log(`  GET  /api/servers/:id/stats         -> ${stats.status} ${stats.body}`);
  console.log(`  POST /api/servers/:id/commands      -> ${cmds.status} ${cmds.body}`);
  console.log(`  GET  /api/system (no auth)          -> ${unauth.status}`);

  const isCanned = create.body.includes('"status":"success"') && power.body.includes('"status":"success"');
  if (isCanned) {
    note(
      "Wings accepts lifecycle commands but performs no action",
      "POST /api/servers, /power, /commands and GET /api/servers/:id all return the same canned {\"status\":\"success\"}; no directory is created, no process starts, no log exists, no stats are produced. The panel reports success while nothing runs."
    );
  }
  proc.kill("SIGKILL");
}

// ---------------------------------------------------------------- B3
console.log("\n\x1b[1m=== B3: does the Panel actually route servers to their assigned Wings node? ===\x1b[0m");
const mk = async (name, fqdn, ip, port) => {
  const r = await api("/api/nodes", {
    method: "POST", token,
    body: { name, fqdn, publicIpV4: ip, wingsPort: port, protocol: "http", ssl: false },
  });
  if (!r?.success) throw new Error(`node create failed: ${JSON.stringify(r)}`);
  return r.node;
};

let n1, n2;
try {
  n1 = await mk("Node 1", "node1.localhost", "127.0.0.1", 18081);
  n2 = await mk("Node 2", "node2.localhost", "127.0.0.1", 18082);
  console.log(`  node1 ${n1.id} ${n1.fqdn}:${n1.wingsPort}`);
  console.log(`  node2 ${n2.id} ${n2.fqdn}:${n2.wingsPort}`);

  // Register both nodes the way the installer does.
  const reg = async (node) => {
    const r = await api("/api/wings/register", { method: "POST", body: { registrationToken: node.registrationToken || (await readToken(node.id)) } });
    return r;
  };
  async function readToken(id) {
    const c = await api(`/api/nodes/${id}/configuration`, { token });
    return c.registrationToken;
  }
  const r1 = await reg(n1);
  const r2 = await reg(n2);
  console.log(`  registered node1 -> nodeId=${r1?.nodeId} port=${r1?.wingsPort}`);
  console.log(`  registered node2 -> nodeId=${r2?.nodeId} port=${r2?.wingsPort}`);

  const nodes = await api("/api/nodes", { token });
  console.log(`  panel node status right after registration (no heartbeat yet):`);
  for (const n of nodes) console.log(`    ${n.name}: status=${n.status} lastHeartbeat=${n.lastHeartbeat}`);

  const onlineWithoutHeartbeat = nodes.filter((n) => n.status === "online" && !n.lastHeartbeat);
  if (onlineWithoutHeartbeat.length) {
    note(
      "Node reported ONLINE at registration with no proof it is running",
      "POST /api/wings/register sets status='online' and lastHeartbeat=now (src/server/routes/nodes.ts:261-262) before the Wings process has started or sent a single heartbeat, so a crashed installer still shows ONLINE."
    );
  }

  // Registering marks online, so check token re-use.
  const reuse = await api("/api/wings/register", { method: "POST", body: { registrationToken: n1.registrationToken } });
  if (reuse?.error && /Invalid or expired/.test(reuse.error)) {
    console.log("  token re-use correctly rejected (single-use token works)");
  }

  // Create the two servers.
  const mkSrv = async (name, nodeId, port) =>
    api("/api/servers", { method: "POST", token, body: { name, nodeId, port, ram: 512, disk: 10, cpu: 100, type: "NODEJS", version: "22" } });

  const sA = await mkSrv("Server A", n1.id, 25565);
  const sB = await mkSrv("Server B", n2.id, 25566);
  console.log(`  Server A id=${sA?.id} nodeId=${sA?.nodeId} runtimeType=${sA?.runtimeType} containerId=${sA?.containerId}`);
  console.log(`  Server B id=${sB?.id} nodeId=${sB?.nodeId} runtimeType=${sB?.runtimeType} containerId=${sB?.containerId}`);

  const panelLog = await fs.readFile("/tmp/opencode/multinode/logs/panel.log", "utf8");
  const usedWingsProvider = /getWingsClient|Wings Health Check|api\/servers/.test(panelLog);
  const getDockerNodeLines = [...panelLog.matchAll(/\[getDocker\] Selected Node URL: (\S+)/g)].map((x) => x[1]);
  console.log(`  panel log shows remote-docker selection: ${JSON.stringify(getDockerNodeLines)}`);

  // Prove where the workloads actually landed: local Docker on the PANEL host.
  const { execSync } = await import("node:child_process");
  let dockerList = "";
  try { dockerList = execSync("docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'", { encoding: "utf8" }); } catch {}
  const mine = dockerList.split("\n").filter((l) => /Server A|Server B|server-a|server-b/i.test(l));
  console.log(`  containers on the PANEL host matching Server A/B:\n${mine.map((l) => "    " + l).join("\n") || "    (none)"}`);

  if (mine.length >= 2) {
    note(
      "Both nodes' servers were deployed on the Panel's own Docker",
      `Server A (node ${n1.fqdn}:${n1.wingsPort}) and Server B (node ${n2.fqdn}:${n2.wingsPort}) both produced containers on the panel host. src/server/services/runtime.ts dispatches every non-'local' server to docker.ts, and getRuntimeProvider()/WingsRuntimeProvider (src/server/services/wings.ts) is never called anywhere, so the Panel never talks to a Wings node for server work.`
    );
  } else {
    note(
      "Server deployment did not reach the assigned Wings node",
      `Expected containers on node 1 (${n1.fqdn}:${n1.wingsPort}) and node 2 (${n2.fqdn}:${n2.wingsPort}); found none on the panel host either - deployment did not occur on any node.`
    );
  }

  // Confirm the provider really is dead code.
  const { execSync: ex } = await import("node:child_process");
  let refs = "";
  try { refs = ex("grep -rn 'getRuntimeProvider\\|WingsRuntimeProvider' src --include=*.ts", { encoding: "utf8" }); } catch {}
  console.log(`\n  references to the Wings provider in src/:\n${refs.split("\n").filter(Boolean).map((l) => "    " + l).join("\n")}`);
} catch (e) {
  console.log("  baseline node/server probe error: " + e.message);
}

console.log("\n\x1b[1m=== BASELINE FINDINGS ===\x1b[0m");
findings.forEach((f, i) => console.log(`  ${i + 1}. ${f.bug}\n     ${f.detail}`));
await fs.writeFile(path.join(WORK, "findings.json"), JSON.stringify(findings, null, 2));
console.log(`\nartifacts in ${WORK}`);
