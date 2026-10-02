#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const VERSION = '3.0.0';
const DEFAULT_CONFIG_PATH = '/etc/jtg-wings/config.yml';

let config = null;
let instance = null;
let allocations = [];
const servers = new Map();
const consoleStreams = new Map();
let cpuSample = null;

function log(level, message) {
  if (config && config.debug !== true && level === 'debug') return;
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] [wings:${level}] ${message}\n`);
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (value === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value !== '' && !isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    parent[key] = value;
  }
  return root;
}

function resolveConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx !== -1 && argv[idx + 1]) return path.resolve(argv[idx + 1]);
  const eq = argv.find((a) => a.startsWith('--config='));
  if (eq) return path.resolve(eq.slice('--config='.length));
  if (process.env.JTG_WINGS_CONFIG) return path.resolve(process.env.JTG_WINGS_CONFIG);
  return DEFAULT_CONFIG_PATH;
}

function loadConfig(argv) {
  const configPath = resolveConfigPath(argv);
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`[wings] config not found: ${configPath}\n`);
    process.exit(1);
  }
  const parsed = parseSimpleYaml(fs.readFileSync(configPath, 'utf8'));
  const cfg = {
    configPath,
    debug: parsed.debug === true,
    panelUrl: String(parsed.panel_url || '').replace(/\/+$/, ''),
    nodeId: String(parsed.node_id || ''),
    uuid: String(parsed.uuid || ''),
    apiSecret: String(parsed.api_secret || ''),
    port: Number(parsed.port) || 8080,
    bindAddress: String(parsed.bind_address || '0.0.0.0'),
    dataDir: String(parsed.data_dir || '/var/lib/jtg-wings'),
    heartbeatInterval: Number(parsed.heartbeat_interval) || 15000,
    offlineThreshold: Number(parsed.offline_threshold) || 90000,
    runtimeBackend: String(parsed.runtime_backend || 'docker'),
    defaultImage: String(parsed.default_image || ''),
    defaultInvocation: String(parsed.default_invocation || ''),
    gameServerType: String(parsed.game_server_type || 'PAPER'),
    serverMemory: Number(parsed.server_memory) || 1024,
    tlsCert: String(parsed.tls_cert || ''),
    tlsKey: String(parsed.tls_key || ''),
    allocations: [],
  };
  if (!cfg.panelUrl) {
    process.stderr.write('[wings] panel_url is required in config\n');
    process.exit(1);
  }
  if (!cfg.nodeId) {
    process.stderr.write('[wings] node_id is required in config\n');
    process.exit(1);
  }
  if (!cfg.apiSecret) {
    process.stderr.write('[wings] api_secret is required in config\n');
    process.exit(1);
  }
  if (parsed.allocations) {
    try {
      cfg.allocations = typeof parsed.allocations === 'string' ? JSON.parse(parsed.allocations) : parsed.allocations;
    } catch (e) {
      process.stderr.write('[wings] allocations is not valid JSON\n');
      process.exit(1);
    }
  }
  return cfg;
}

const serversDir = () => path.join(config.dataDir, 'servers');
const serverDir = (uuid) => path.join(serversDir(), uuid);
const serverFile = (uuid) => path.join(serverDir(uuid), 'server.json');
const allocationsFile = () => path.join(config.dataDir, 'allocations.json');
const accessLogFile = () => path.join(config.dataDir, 'access.log');
const instanceFile = () => path.join(config.dataDir, 'instance.json');

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function initState() {
  await fsp.mkdir(serversDir(), { recursive: true });

  let inst = await readJson(instanceFile());
  if (!inst) {
    inst = {
      instance_id: crypto.randomUUID(),
      node_id: config.nodeId,
      uuid: config.uuid,
      panel_url: config.panelUrl,
      first_boot: new Date().toISOString(),
    };
    await writeJsonAtomic(instanceFile(), inst);
  }
  inst.node_id = config.nodeId;
  inst.uuid = config.uuid;
  instance = inst;

  const stored = await readJson(allocationsFile());
  if (stored && Array.isArray(stored) && stored.length) {
    allocations = stored;
  } else {
    allocations = (config.allocations || []).map((a) => ({
      id: a.id || crypto.randomUUID(),
      ip: a.ip || '0.0.0.0',
      port: Number(a.port),
      assigned: false,
      server: null,
    }));
    await writeJsonAtomic(allocationsFile(), allocations);
  }

  const entries = await fsp.readdir(serversDir(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readJson(serverFile(entry.name));
    if (record) {
      servers.set(record.uuid, record);
      if (record.state === 'online') record.state = 'offline';
    }
  }
  await reconcileAllocations();
}

function allocationInUse(ip, port) {
  return allocations.find((a) => a.ip === ip && Number(a.port) === Number(port) && a.assigned);
}

async function reconcileAllocations() {
  let dirty = false;
  for (const alloc of allocations) {
    const owner = alloc.assigned && alloc.server && servers.has(alloc.server) ? alloc.server : null;
    if (alloc.assigned && !owner) {
      alloc.assigned = false;
      alloc.server = null;
      dirty = true;
    }
  }
  for (const [uuid, record] of servers) {
    const alloc = record.allocation;
    if (!alloc) continue;
    const existing = allocations.find((a) => a.ip === alloc.ip && Number(a.port) === Number(alloc.port));
    if (!existing) continue;
    if (existing.assigned !== true || existing.server !== uuid) {
      existing.assigned = true;
      existing.server = uuid;
      dirty = true;
    }
  }
  if (dirty) await writeJsonAtomic(allocationsFile(), allocations);
}

function dockerName(uuid) {
  return `jtg-${String(config.nodeId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}-${String(uuid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} ${args.join(' ')}: ${err.message}${stderr ? ` | ${String(stderr).trim()}` : ''}`;
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

function renderTemplate(template, values) {
  return String(template).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, key) =>
    values[key] !== undefined && values[key] !== null ? String(values[key]) : match
  );
}

function buildInvocation(record) {
  const template = config.defaultInvocation || record.invocation || '';
  return renderTemplate(template, {
    SERVER_MEMORY: record.build?.memory ?? config.serverMemory,
    SERVER_JARFILE: record.environment?.SERVER_JARFILE || 'server.jar',
    SERVER_PORT: record.allocation?.port,
    SERVER_IP: record.allocation?.ip,
    SERVER_NAME: record.meta?.name || record.uuid,
    SERVER_UUID: record.uuid,
  });
}

async function dockerInspect(name) {
  try {
    const out = await run('docker', ['inspect', '--format', '{{json .State}}', name]);
    return JSON.parse(out.trim());
  } catch (e) {
    if (/no such object|not found/i.test(e.message)) return null;
    throw e;
  }
}

const entrypointCache = new Map();

/**
 * Docker replaces CMD with the arguments after the image when an ENTRYPOINT is set.
 * If an image already declares an entrypoint, prepending `sh -c` would nest shells
 * and break the image, so we only supply the command when the image has none.
 */
async function imageHasEntrypoint(image) {
  if (entrypointCache.has(image)) return entrypointCache.get(image);
  let has = false;
  try {
    const out = await run('docker', ['inspect', '--format', '{{json .Config.Entrypoint}}', image]);
    const parsed = JSON.parse(out.trim());
    has = Array.isArray(parsed) && parsed.length > 0;
  } catch (e) {
    log('debug', `could not inspect entrypoint for ${image}: ${e.message}`);
    has = false;
  }
  entrypointCache.set(image, has);
  return has;
}

async function backendCreate(record) {
  if (config.runtimeBackend === 'process') {
    await fsp.mkdir(path.join(serverDir(record.uuid), 'logs'), { recursive: true });
    const logPath = path.join(serverDir(record.uuid), 'logs', 'output.log');
    const out = fs.openSync(logPath, 'a');
    const invocation = buildInvocation(record);
    const child = spawn('/bin/sh', ['-c', invocation], {
      cwd: serverDir(record.uuid),
      stdio: ['pipe', out, out],
      detached: true,
    });
    child.unref();
    consoleStreams.set(record.uuid, child.stdin);
    record.pid = child.pid;
    return;
  }

  const name = dockerName(record.uuid);
  const alloc = record.allocation;

  // Minecraft images refuse to boot until the EULA is accepted, so a server
  // provisioned on Wings used to exit immediately with code 1. The panel's own
  // sandbox backend already accepts it for the operator; Wings must match, or
  // the same server works locally and dies on a real node.
  const dir = serverDir(record.uuid);
  await fsp.mkdir(dir, { recursive: true });
  if (record.build?.eula !== false) {
    await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  }

  const args = ['create', '-i', '--name', name];
  const memory = `${record.build?.memory || config.serverMemory}m`;
  args.push('--memory', memory);
  const bindAddress = alloc && alloc.ip ? hostBindAddress(alloc.ip) : '0.0.0.0';
  if (alloc && alloc.ip && alloc.port) args.push('-p', `${bindAddress}:${alloc.port}:${alloc.port}/tcp`);
  if (config.serverMemory && record.build?.swap === 0) args.push('--memory-swap', memory);
  args.push('-e', `SERVER_MEMORY=${record.build?.memory || config.serverMemory}`);
  args.push('-e', `SERVER_PORT=${alloc ? alloc.port : ''}`);
  args.push('-e', `SERVER_IP=${alloc && alloc.ip && isLocalAddress(alloc.ip) ? alloc.ip : ''}`);
  args.push('-e', `SERVER_NAME=${record.meta?.name || record.uuid}`);
  args.push('-e', `SERVER_UUID=${record.uuid}`);
  args.push('-e', `JTG_NODE_ID=${config.nodeId}`);
  args.push(record.image);
  if (await imageHasEntrypoint(record.image)) {
    args.push(buildInvocation(record));
  } else {
    args.push('sh', '-c', buildInvocation(record));
  }
  await run('docker', args);
  record.container_name = name;
}

async function backendStart(record) {
  if (config.runtimeBackend === 'process') {
    if (record.pid && isPidAlive(record.pid)) {
      record.state = 'online';
      return;
    }
    await backendCreate(record);
    record.state = 'online';
    return;
  }
  await run('docker', ['start', record.container_name]);
  record.state = 'online';
  attachConsole(record);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function attachConsole(record) {
  if (config.runtimeBackend === 'process') return;
  if (consoleStreams.has(record.uuid)) return;
  // Docker 29 removed the `-i` flag from `attach` (stdin is attached by default),
  // while older versions accept it. Try the modern form first and fall back.
  let child = spawn('docker', ['attach', record.container_name], { stdio: ['pipe', 'pipe', 'pipe'] });
  let fellBack = false;
  child.on('error', (e) => {
    if (!fellBack && /unknown shorthand flag|unknown flag/i.test(e.message)) {
      fellBack = true;
      child = spawn('docker', ['attach', '-i', record.container_name], { stdio: ['pipe', 'pipe', 'pipe'] });
      wireConsole(record, child);
      return;
    }
    log('warn', `console attach failed for ${record.uuid}: ${e.message}`);
  });
  wireConsole(record, child);
}

function wireConsole(record, child) {
  const livePath = path.join(serverDir(record.uuid), 'logs', 'live.log');
  try {
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    const out = fs.openSync(livePath, 'a');
    child.stdout.pipe(fs.createWriteStream(null, { fd: out, autoClose: false }));
    child.stderr.pipe(fs.createWriteStream(null, { fd: out, autoClose: false }));
  } catch (e) {
    log('warn', `live log unavailable for ${record.uuid}: ${e.message}`);
  }
  child.on('error', (e) => log('warn', `console attach error for ${record.uuid}: ${e.message}`));
  consoleStreams.set(record.uuid, child.stdin);
}

async function backendStop(record, timeoutSec = 20) {
  if (config.runtimeBackend === 'process') {
    const stream = consoleStreams.get(record.uuid);
    if (stream && !stream.destroyed) stream.write('stop\n');
    if (record.pid) {
      const deadline = Date.now() + timeoutSec * 1000;
      while (Date.now() < deadline && isPidAlive(record.pid)) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (isPidAlive(record.pid)) {
        try { process.kill(record.pid, 'SIGKILL'); } catch (e) { log('debug', e.message); }
      }
    }
    closeConsole(record.uuid);
    record.state = 'offline';
    return;
  }
  const state = await dockerInspect(record.container_name);
  if (state && state.Running) {
    await run('docker', ['stop', '-t', String(timeoutSec), record.container_name]);
  }
  closeConsole(record.uuid);
  record.state = 'offline';
}

async function backendKill(record) {
  if (config.runtimeBackend === 'process') {
    if (record.pid) {
      try { process.kill(record.pid, 'SIGKILL'); } catch (e) { log('debug', e.message); }
    }
    closeConsole(record.uuid);
    record.state = 'offline';
    return;
  }
  const state = await dockerInspect(record.container_name);
  if (state) await run('docker', ['kill', '-s', 'KILL', record.container_name]);
  closeConsole(record.uuid);
  record.state = 'offline';
}

async function backendDelete(record) {
  await backendStop(record).catch(() => {});
  if (config.runtimeBackend === 'process') {
    await fsp.rm(serverDir(record.uuid), { recursive: true, force: true });
    return;
  }
  if (record.container_name) {
    await run('docker', ['rm', '-f', record.container_name]).catch((e) => log('warn', e.message));
  }
  await fsp.rm(serverDir(record.uuid), { recursive: true, force: true });
}

function closeConsole(uuid) {
  const stream = consoleStreams.get(uuid);
  if (stream) {
    try { stream.end(); } catch (e) { log('debug', e.message); }
    consoleStreams.delete(uuid);
  }
}

async function backendState(record) {
  if (config.runtimeBackend === 'process') {
    if (record.state !== 'online') return { running: false, status: record.state || 'offline', startedAt: record.started_at || null };
    if (!record.pid || !isPidAlive(record.pid)) {
      record.state = 'offline';
      return { running: false, status: 'exited', startedAt: record.started_at || null };
    }
    return { running: true, status: 'running', startedAt: record.started_at || null, pid: record.pid };
  }
  const state = record.container_name ? await dockerInspect(record.container_name) : null;
  if (!state) return { running: false, status: 'offline', startedAt: null };
  if (state.Running) {
    record.state = 'online';
    if (!record.started_at && state.StartedAt) record.started_at = state.StartedAt;
    return { running: true, status: 'running', startedAt: record.started_at, pid: state.Pid };
  }
  record.state = 'offline';
  return {
    running: false,
    status: 'exited',
    startedAt: null,
    exitCode: state.ExitCode,
    finishedAt: state.FinishedAt,
  };
}

async function backendLogs(record, lines) {
  if (config.runtimeBackend === 'process') {
    const logPath = path.join(serverDir(record.uuid), 'logs', 'output.log');
    if (!fs.existsSync(logPath)) return '';
    const content = await fsp.readFile(logPath, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  }
  if (!record.container_name) return '';
  const out = await run('docker', ['logs', '--tail', String(lines), record.container_name]).catch((e) => {
    log('warn', e.message);
    return '';
  });
  return out;
}

async function backendStats(record) {
  if (config.runtimeBackend === 'process') {
    if (!record.pid || !isPidAlive(record.pid)) return { cpu: 0, ram: 0, disk: 0 };
    let cpu = 0;
    let ram = 0;
    try {
      const out = await run('ps', ['-p', String(record.pid), '-o', '%cpu=,rss=']);
      const parts = out.trim().split(/\s+/);
      cpu = Math.round((parseFloat(parts[0]) || 0) * 10) / 10;
      ram = Math.round(((parseInt(parts[1], 10) || 0) / 1024) * 10) / 10;
    } catch (e) { log('debug', e.message); }
    let disk = 0;
    try {
      const du = await run('du', ['-sm', serverDir(record.uuid)]);
      disk = Math.round(((parseInt(du.trim().split(/\s+/)[0], 10) || 0) / 1024) * 100) / 100;
    } catch (e) { disk = 0; }
    return { cpu, ram, disk };
  }
  if (!record.container_name) return { cpu: 0, ram: 0, disk: 0 };
  const state = await dockerInspect(record.container_name);
  if (!state || !state.Running) return { cpu: 0, ram: 0, disk: 0 };
  let cpu = 0;
  let ram = 0;
  try {
    const out = await run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', record.container_name]);
    const [cpuPerc, memUsage] = out.trim().split('|');
    cpu = Math.round((parseFloat(String(cpuPerc).replace('%', '')) || 0) * 10) / 10;
    const usedRaw = String(memUsage || '').split('/')[0].trim();
    const match = usedRaw.match(/([\d.]+)\s*([KMG]?i?B)/i);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2].toUpperCase();
      const mb = unit.startsWith('G') ? value * 1024 : unit.startsWith('K') ? value / 1024 : value;
      ram = Math.round(mb * 10) / 10;
    }
  } catch (e) { log('debug', e.message); }
  let disk = 0;
  try {
    const du = await run('du', ['-sm', serverDir(record.uuid)]);
    disk = Math.round(((parseInt(du.trim().split(/\s+/)[0], 10) || 0) / 1024) * 100) / 100;
  } catch (e) { disk = 0; }
  return { cpu, ram, disk };
}

async function backendCommand(record, command) {
  if (!consoleStreams.has(record.uuid) && config.runtimeBackend !== 'process' && record.container_name) {
    const state = await dockerInspect(record.container_name);
    if (state && state.Running) attachConsole(record);
  }
  const stream = consoleStreams.get(record.uuid);
  if (!stream || stream.destroyed) {
    throw new Error('server console is not available (server is not running)');
  }
  stream.write(command + '\n');
}

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const key of Object.keys(cpu.times)) total += cpu.times[key];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuPercent() {
  if (!cpuSample) return 0;
  const now = sampleCpu();
  const idleDelta = now.idle - cpuSample.idle;
  const totalDelta = now.total - cpuSample.total;
  cpuSample = now;
  if (totalDelta <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 1000) / 10) * 10) / 10;
}

function diskUsage() {
  try {
    const st = fs.statfsSync(config.dataDir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return {
      total: Math.round(total / 1048576),
      free: Math.round(free / 1048576),
      used: Math.round((total - free) / 1048576),
    };
  } catch (e) {
    return { total: 0, free: 0, used: 0 };
  }
}

async function heartbeatPayload() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  let running = 0;
  for (const record of servers.values()) {
    const state = await backendState(record).catch(() => ({ running: false }));
    if (state.running) running += 1;
  }
  return {
    nodeId: config.nodeId,
    instanceId: instance.instance_id,
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    cpu: cpuPercent(),
    memory: {
      total: Math.round(totalMem / 1048576),
      free: Math.round(freeMem / 1048576),
      used: Math.round((totalMem - freeMem) / 1048576),
    },
    disk: diskUsage(),
    systems: {
      arch: os.arch(),
      platform: os.platform(),
      hostname: os.hostname(),
      backend: config.runtimeBackend,
    },
    resources: {
      servers_total: servers.size,
      servers_running: running,
      allocations_total: allocations.length,
      allocations_assigned: allocations.filter((a) => a.assigned).length,
    },
  };
}

/**
 * Addresses actually configured on this host's interfaces.
 *
 * On cloud NAT setups (AWS Elastic IP, GCP external IP, most NAT gateways) the
 * address an allocation advertises is not bound to any local interface, so
 * Docker cannot publish to it: "cannot assign requested address". Cached because
 * it is consulted once per container create.
 */
let localAddressCache = null;
function localAddresses() {
  if (localAddressCache && Date.now() - localAddressCache.at < 60000) return localAddressCache.set;
  const set = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) set.add(a.address);
    }
  }
  localAddressCache = { at: Date.now(), set };
  return set;
}

function isLocalAddress(ip) {
  return localAddresses().has(String(ip));
}

/**
 * The address to publish a game port on.
 *
 * Uses the allocation IP when it is local. Otherwise falls back to every
 * interface, which still exposes the port through the cloud NAT and is what
 * makes nodes on Elastic-IP hosts work at all.
 */
function hostBindAddress(ip) {
  if (isLocalAddress(ip)) return String(ip);
  log(
    'warn',
    `allocation ${ip} is not configured on this host; publishing game ports on 0.0.0.0 instead`
  );
  return '0.0.0.0';
}

function postJson(target, pathname, payload, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(pathname, target);
    } catch (e) {
      return reject(e);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: 10000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('heartbeat timeout')));
    req.write(body);
    req.end();
  });
}

function getJson(target, pathname, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(pathname, target);
    } catch (e) {
      return reject(e);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', headers: { ...headers }, timeout: 10000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('invalid JSON from panel'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

/**
 * Re-read the node's configuration from the panel.
 *
 * config.yml is written once by the installer, so without this an operator who
 * changes a node's runtime backend or default image sees no effect until they
 * re-run the installer on every node. Applies the panel's values to the live
 * config; local values are kept if the panel is unreachable, so an unreachable
 * panel never stops a running daemon.
 */
async function refreshConfigFromPanel() {
  try {
    const res = await getJson(config.panelUrl, '/api/wings/config', {
      Authorization: `Bearer ${config.apiSecret}`,
    });
    if (!res || res.success !== true || typeof res.config !== 'string' || !res.config.trim()) {
      return false;
    }
    const parsed = parseSimpleYaml(res.config);
    const changed = [];

    if (parsed.runtime_backend && parsed.runtime_backend !== config.runtimeBackend) {
      changed.push(`runtime_backend ${config.runtimeBackend} -> ${parsed.runtime_backend}`);
      config.runtimeBackend = parsed.runtime_backend;
    }
    if (typeof parsed.default_image === 'string' && parsed.default_image !== config.defaultImage) {
      changed.push(`default_image ${JSON.stringify(config.defaultImage)} -> ${JSON.stringify(parsed.default_image)}`);
      config.defaultImage = parsed.default_image;
    }
    if (typeof parsed.default_invocation === 'string' && parsed.default_invocation !== config.defaultInvocation) {
      changed.push('default_invocation updated');
      config.defaultInvocation = parsed.default_invocation;
    }
    if (parsed.server_memory && Number(parsed.server_memory) !== config.serverMemory) {
      changed.push(`server_memory ${config.serverMemory} -> ${Number(parsed.server_memory)}`);
      config.serverMemory = Number(parsed.server_memory);
    }
    if (Array.isArray(parsed.allocations)) {
      allocations = parsed.allocations;
    }

    if (changed.length) {
      log('info', `applied config change from panel: ${changed.join(', ')}`);
    } else {
      log('debug', 'config is in sync with the panel');
    }
    return true;
  } catch (e) {
    log('warn', `could not refresh config from panel: ${e.message} (continuing with local config)`);
    return false;
  }
}

async function sendHeartbeat() {
  try {
    const payload = await heartbeatPayload();
    const status = await postJson(config.panelUrl, '/api/wings/heartbeat', payload, {
      Authorization: `Bearer ${config.apiSecret}`,
    });
    if (status >= 400) log('warn', `heartbeat rejected with status ${status}`);
    else log('debug', `heartbeat ok (${payload.cpu}% cpu, ${payload.resources.servers_running}/${payload.resources.servers_total} running)`);
  } catch (e) {
    log('warn', `heartbeat failed: ${e.message}`);
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function appendAccess(entry) {
  try {
    fs.appendFileSync(accessLogFile(), JSON.stringify(entry) + '\n');
  } catch (e) { log('debug', e.message); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/api/system') {
    const stats = diskUsage();
    return sendJson(res, 200, {
      status: 'online',
      version: VERSION,
      architecture: os.arch(),
      platform: os.platform(),
      hostname: os.hostname(),
      node_id: config.nodeId,
      node_uuid: config.uuid,
      instance_id: instance.instance_id,
      uptime: Math.floor(process.uptime()),
      backend: config.runtimeBackend,
      tls: Boolean(config.tlsCert && config.tlsKey),
      disk: stats,
    });
  }

  if (method === 'GET' && url.pathname === '/api/allocations') {
    await reconcileAllocations();
    return sendJson(res, 200, allocations);
  }

  if (url.pathname === '/api/servers' && method === 'GET') {
    const out = [];
    for (const record of servers.values()) {
      const state = await backendState(record).catch(() => ({ running: false, status: 'unknown' }));
      out.push({ uuid: record.uuid, state: state.running ? 'online' : 'offline', is_suspended: false, meta: record.meta, allocation: record.allocation });
    }
    return sendJson(res, 200, out);
  }

  if (url.pathname === '/api/servers' && method === 'POST') {
    const payload = await readBody(req);
    const uuid = payload.uuid;
    if (!uuid) return sendJson(res, 400, { error: 'uuid is required' });
    if (servers.has(uuid)) return sendJson(res, 409, { error: 'server already exists on this node' });

    const alloc = payload.allocations?.default || (payload.allocation ? payload.allocation : null);
    if (!alloc || !alloc.ip || !alloc.port) return sendJson(res, 400, { error: 'allocation is required' });

    const known = allocations.find((a) => a.ip === alloc.ip && Number(a.port) === Number(alloc.port));
    if (!known) return sendJson(res, 422, { error: `allocation ${alloc.ip}:${alloc.port} is not defined on this node` });
    if (known.assigned && known.server !== uuid) {
      return sendJson(res, 409, { error: `allocation ${alloc.ip}:${alloc.port} is already assigned on this node` });
    }

    const record = {
      uuid,
      meta: payload.meta || {},
      build: payload.build || {},
      environment: payload.environment || {},
      invocation: payload.invocation || '',
      image: config.defaultImage || payload.container?.image || '',
      allocation: { id: known.id, ip: known.ip, port: Number(known.port) },
      backend: config.runtimeBackend,
      state: 'offline',
      started_at: null,
      created_at: new Date().toISOString(),
    };
    if (!record.image) return sendJson(res, 400, { error: 'no container image is configured on this node' });

    servers.set(uuid, record);
    await fsp.mkdir(path.join(serverDir(uuid), 'logs'), { recursive: true });
    await writeJsonAtomic(serverFile(uuid), record);
    try {
      await backendCreate(record);
    } catch (e) {
      servers.delete(uuid);
      await fsp.rm(serverDir(uuid), { recursive: true, force: true }).catch(() => {});
      return sendJson(res, 500, { error: `failed to create server on node: ${e.message}` });
    }
    await reconcileAllocations();
    await writeJsonAtomic(serverFile(uuid), record);
    return sendJson(res, 201, { uuid, state: 'offline', allocation: record.allocation });
  }

  if (segments[0] === 'api' && segments[1] === 'servers' && segments[2]) {
    const uuid = segments[2];
    const record = servers.get(uuid);
    if (!record) return sendJson(res, 404, { error: 'server not found on this node' });

    if (method === 'GET' && segments.length === 3) {
      const state = await backendState(record);
      return sendJson(res, 200, {
        uuid,
        state: state.running ? 'online' : 'offline',
        is_suspended: false,
        meta: record.meta,
        allocation: record.allocation,
        started_at: state.running ? state.startedAt : null,
        exit_code: state.exitCode ?? null,
      });
    }

    if (method === 'DELETE' && segments.length === 3) {
      await backendDelete(record);
      servers.delete(uuid);
      closeConsole(uuid);
      await reconcileAllocations();
      return sendJson(res, 200, { success: true });
    }

    if (method === 'POST' && segments[3] === 'power') {
      const payload = await readBody(req);
      const action = String(payload.action || '').toLowerCase();
      const state = await backendState(record);

      if (action === 'start') {
        if (state.running) return sendJson(res, 200, { success: true, already: true });
        await backendStart(record);
        record.started_at = new Date().toISOString();
        await writeJsonAtomic(serverFile(uuid), record);
        return sendJson(res, 200, { success: true, started_at: record.started_at });
      }
      if (action === 'stop') {
        if (!state.running) return sendJson(res, 200, { success: true, already: true });
        await backendStop(record);
        record.started_at = null;
        await writeJsonAtomic(serverFile(uuid), record);
        return sendJson(res, 200, { success: true });
      }
      if (action === 'kill') {
        if (!state.running) return sendJson(res, 200, { success: true, already: true });
        await backendKill(record);
        record.started_at = null;
        await writeJsonAtomic(serverFile(uuid), record);
        return sendJson(res, 200, { success: true });
      }
      if (action === 'restart') {
        await backendStop(record).catch(() => {});
        await backendStart(record);
        record.started_at = new Date().toISOString();
        await writeJsonAtomic(serverFile(uuid), record);
        return sendJson(res, 200, { success: true, started_at: record.started_at });
      }
      return sendJson(res, 400, { error: `unknown power action '${action}'` });
    }

    if (method === 'GET' && segments[3] === 'logs') {
      const lines = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('lines') || '200', 10)));
      const text = await backendLogs(record, lines);
      return sendJson(res, 200, { logs: text });
    }

    if (method === 'GET' && segments[3] === 'stats') {
      const state = await backendState(record);
      const stats = await backendStats(record);
      return sendJson(res, 200, {
        uuid,
        state: state.running ? 'online' : 'offline',
        started_at: state.running ? state.startedAt : null,
        cpu: stats.cpu,
        memory: { used: stats.ram, used_bytes: Math.round(stats.ram * 1048576) },
        disk: { used: stats.disk, used_bytes: Math.round(stats.disk * 1073741824) },
      });
    }

    if (method === 'POST' && segments[3] === 'commands') {
      const payload = await readBody(req);
      if (!payload.command) return sendJson(res, 400, { error: 'command is required' });
      await backendCommand(record, String(payload.command));
      return sendJson(res, 200, { success: true });
    }
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

function createServer() {
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const started = Date.now();
    let status = 500;
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || !safeEqual(token, config.apiSecret)) {
        status = 401;
        log('warn', `unauthorized ${req.method} ${url.pathname}`);
        return sendJson(res, 401, { error: 'Unauthorized Wings Request' });
      }
      status = await handleApi(req, res, url);
      if (typeof status !== 'number') status = res.statusCode;
    } catch (e) {
      status = e.message === 'invalid JSON body' || e.message === 'payload too large' ? 400 : 500;
      log('error', `${req.method} ${url.pathname} failed: ${e.message}`);
      if (!res.headersSent) sendJson(res, status, { error: e.message });
    } finally {
      appendAccess({
        at: new Date().toISOString(),
        node_id: config.nodeId,
        instance_id: instance.instance_id,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  };

  if (config.tlsCert && config.tlsKey) {
    if (!fs.existsSync(config.tlsCert) || !fs.existsSync(config.tlsKey)) {
      process.stderr.write('[wings] tls_cert/tls_key configured but not readable\n');
      process.exit(1);
    }
    return https.createServer(
      { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) },
      handler
    );
  }
  return http.createServer(handler);
}

function listen(server) {
  const attempts = ['::', '0.0.0.0'];
  let i = 0;
  let listening = false;
  server.on('error', (e) => {
    if (listening) log('error', `server error after bind: ${e.message}`);
  });
  const tryListen = () => {
    server.once('error', (e) => {
      if (i < attempts.length - 1) {
        log('warn', `bind ${attempts[i]} failed (${e.code}), trying ${attempts[i + 1]}`);
        i += 1;
        tryListen();
      } else {
        process.stderr.write(`[wings] failed to listen on port ${config.port}: ${e.message}\n`);
        process.exit(1);
      }
    });
    server.listen(config.port, attempts[i], () => {
      listening = true;
      log('info', `listening on ${attempts[i]}:${config.port} (${config.tlsCert ? 'https' : 'http'}, backend=${config.runtimeBackend})`);
      log('info', `node=${config.nodeId} instance=${instance.instance_id}`);
      log('info', `panel=${config.panelUrl}`);
      log('info', `servers=${servers.size} allocations=${allocations.length}`);
    });
  };
  tryListen();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'JTG Wings daemon ' + VERSION + '\n' +
      'Usage: node wings.cjs [--config <path>] [--version] [--help]\n' +
      'Config resolution: --config, then JTG_WINGS_CONFIG, then /etc/jtg-wings/config.yml\n'
    );
    process.exit(0);
  }

  config = loadConfig(argv);
  fs.mkdirSync(config.dataDir, { recursive: true });
  await initState();
  cpuSample = sampleCpu();

  const server = createServer();
  listen(server);
  await sendHeartbeat();
  setInterval(sendHeartbeat, config.heartbeatInterval).unref();

  // Pick up node edits (runtime backend, default image/invocation, allocations)
  // without requiring the installer to be re-run on every node. Runs on the same
  // cadence as the heartbeat so one request pattern is enough to stay in sync.
  await refreshConfigFromPanel();
  setInterval(refreshConfigFromPanel, Math.max(config.heartbeatInterval, 30000)).unref();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('info', `received ${signal}, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
  process.on('uncaughtException', (e) => log('error', `uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log('error', `unhandled rejection: ${e}`));
}

main().catch((e) => {
  process.stderr.write(`[wings] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
