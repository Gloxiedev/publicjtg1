import { spawn, execSync, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PANEL, login, api, waitFor } from "./lib.mjs";

export const ROOT = "/home/glox/jtgsecret";
export const BASE = "/tmp/opencode/multinode";
export const NODE_ROOT = path.join(BASE, "nodes");
export const TLS_DIR = path.join(BASE, "tls");
export const LOGS = path.join(BASE, "logs");
export const PANEL_LOG = path.join(LOGS, "panel.log");
export const OWNER_USER = process.env.JTG_OWNER_USER || "jtgowner";
export const OWNER_PASS = process.env.JTG_OWNER_PASS || "jtgOwnerPass123";
export const CA_CERT = path.join(TLS_DIR, "ca.crt");
export const GAME_IMAGE = "jtg-test-gameserver:local";

export function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

export async function ensureDirs() {
  for (const dir of [BASE, NODE_ROOT, LOGS, TLS_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

let panelProc = null;

export function panelRunning() {
  try {
    const out = sh(`ss -tlnp 2>/dev/null | grep ':6767' || true`);
    return /node/.test(out);
  } catch {
    return false;
  }
}

export async function stopPanel() {
  if (panelProc) {
    try { process.kill(-panelProc.pid, "SIGKILL"); } catch {}
    panelProc = null;
  }
  try {
    const out = sh("ss -tlnp 2>/dev/null | grep ':6767' | grep -o 'pid=[0-9]*' | cut -d= -f2 || true");
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch {}
    }
  } catch {}
  for (let i = 0; i < 40; i++) {
    if (!panelRunning()) return;
    await sleep(200);
  }
  throw new Error("panel did not stop");
}

export async function startPanel() {
  await fs.mkdir(LOGS, { recursive: true });
  const logFd = await fs.open(PANEL_LOG, "a");
  panelProc = spawn("node", ["dist/server.cjs"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    env: {
      ...process.env,
      PORT: "6767",
      NODE_ENV: "production",
      // Must satisfy the production JWT rules: >= 32 chars and not the value
      // that used to be hardcoded in this repository's source.
      JWT_SECRET: "local-multinode-test-secret-value-not-public",
      NODE_EXTRA_CA_CERTS: CA_CERT,
    },
  });
  panelProc.unref();
  await fs.writeFile(path.join(BASE, "panel.pid"), String(panelProc.pid));

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(PANEL + "/api/health");
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("panel did not become healthy\n" + (await fs.readFile(PANEL_LOG, "utf8").catch(() => "")));
}

export async function panelToken() {
  return login(OWNER_USER, OWNER_PASS);
}

/** Wipe every trace of panel state and containers, then start a pristine panel. */
export async function resetPanel({ keepLogs = true } = {}) {
  await stopPanel();
  await cleanupTestContainers();
  await stopAllTestNodes();
  await sleep(1000);
  await fs.rm(path.join(ROOT, ".data"), { recursive: true, force: true });
  await fs.rm(path.join(ROOT, "backups"), { recursive: true, force: true });
  if (!keepLogs) await fs.rm(path.join(ROOT, "crash.log"), { force: true });
  await fs.rm(NODE_ROOT, { recursive: true, force: true });
  await ensureDirs();
  execSync(
    `cd ${ROOT} && JTG_OWNER_USER=${OWNER_USER} JTG_OWNER_PASS=${OWNER_PASS} npx tsx scripts/createuser.ts`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  await startPanel();
  return panelToken();
}

export function cleanupTestContainers() {
  try {
    sh("docker ps -aq --filter 'name=jtg-' | xargs -r docker rm -f >/dev/null 2>&1 || true");
  } catch {}
}

export function testContainers() {
  try {
    return sh("docker ps -a --filter 'name=jtg-' --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' || true")
      .split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function stopAllTestNodes() {
  const seen = new Set();

  // Tracked pid files first.
  let pidFiles = [];
  try {
    pidFiles = execFileSync("find", [NODE_ROOT, "-maxdepth", "3", "-name", "wings.pid"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
  } catch {}
  for (const pidFile of pidFiles) {
    const pid = Number(readTextFile(pidFile));
    if (pid > 0) seen.add(pid);
  }

  // Then sweep any stray daemon left behind by an aborted run or manual debug,
  // so a previous run can never hold a port that the next run needs.
  try {
    const out = execSync(
      "pgrep -af 'wings.cjs' | grep -v pgrep || true",
      { encoding: "utf8", shell: "/bin/bash" }
    );
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const m = line.match(/^(\d+)\s/);
      if (m) seen.add(Number(m[1]));
    }
  } catch {}

  for (const pid of seen) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  return seen.size;
}

export function readTextFile(file) {
  try { return execSync(`cat ${JSON.stringify(file)} 2>/dev/null || true`, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

export function nodeDir(label) {
  return path.join(NODE_ROOT, label);
}

export function nodeConfigPath(label) {
  return path.join(nodeDir(label), "config.yml");
}

export function nodeAccessLog(label) {
  return path.join(nodeDir(label), "data", "access.log");
}

export function nodeInstanceFile(label) {
  return path.join(nodeDir(label), "data", "instance.json");
}

export function nodePidFile(label) {
  return path.join(nodeDir(label), "wings.pid");
}

export function nodeAlive(label) {
  const pid = nodePid(label);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function nodePid(label) {
  return Number(readTextFile(nodePidFile(label))) || null;
}

export async function stopNodeProcess(label, signal = "SIGKILL") {
  const pid = nodePid(label);
  if (!pid) return false;
  try { process.kill(pid, signal); } catch { return false; }
  // SIGKILL is delivered asynchronously, so the process can still be alive on the
  // very next line. Wait for it to actually disappear rather than racing.
  const gone = await waitFor(() => !nodeAlive(label), { timeout: 15000, interval: 100 })
    .then(() => true).catch(() => false);
  // Drop the stale pid so a recycled PID can never masquerade as our daemon.
  try { fsSync.rmSync(nodePidFile(label), { force: true }); } catch { /* ignore */ }
  return gone;
}

export function waitPortFree(port, timeoutMs = 15000) {
  return (async () => {
    const net = await import("node:net");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const free = await new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(false); });
        s.on("error", () => resolve(true));
        s.setTimeout(500, () => { s.destroy(); resolve(true); });
      });
      if (free) return true;
      await sleep(250);
    }
    return false;
  })();
}

export async function portOpen(port, host = "127.0.0.1", timeoutMs = 4000) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
  });
}

export async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

export async function readAccessLog(label) {
  const raw = await fs.readFile(nodeAccessLog(label), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/jtg_ws_[a-f0-9]{6,}/g, "jtg_ws_<redacted>")
    .replace(/jtg_reg_[a-f0-9]{6,}/g, "jtg_reg_<redacted>");
}

export async function wingsGet(endpoint, port, secret, scheme = "http") {
  const res = await fetch(`${scheme}://127.0.0.1:${port}${endpoint}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

export { api, sleep, waitFor, login };
