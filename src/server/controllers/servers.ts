import { Request, Response } from "express";
import { readJSON, writeJSON } from "../services/db.js";
import {
  createServerRuntime,
  startServerRuntime,
  stopServerRuntime,
  restartServerRuntime,
  killServerRuntime,
  deleteServerRuntime,
  getServerRuntimeStatus,
  getServerRuntimeStats,
  sendServerRuntimeCommand,
  attachServerRuntimeSocket
} from "../services/runtime.js";
import { getLocalProcessInfo } from "../services/local.js";
import { createSftpUser, deleteSftpUser } from "../services/sftp.js";
import { downloadJar } from "../services/jarDownloader.js";
import { isSandbox, isNodeSandbox, checkNodeSandbox } from "../services/docker.js";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import { ZipArchive } from "archiver";
import extract from "extract-zip";
import { extractArchive } from "../utils/extract.js";
import { getServerDir, resolveWithin } from "../utils/safePath.js";

const serverOperationLocks = new Set<string>();

export const getServers = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  
  // Filter for normal users
  const userServers = user.role === "admin" || user.role === "owner" ? servers : servers.filter((s: any) => s.owner === user.id);

  // Update statuses
  const updatedServers = await Promise.all(userServers.map(async (server: any) => {
    if (server.containerId) {
      const status = await getServerRuntimeStatus(server);
      const isRunning = !!status?.State?.Running;
      server.status = isRunning ? "online" : "offline";
      server.startedAt = isRunning ? (status?.State?.StartedAt || server.startedAt || new Date().toISOString()) : null;
      if (server.runtimeType === 'local') {
          const info = getLocalProcessInfo(server.id);
          if (info) {
              server.pid = info.pid;
              server.jarPath = info.jarPath;
              server.logPath = info.logPath;
          }
      }
    }
    return server;
  }));

  res.json(updatedServers);
};

export const getServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const status = await getServerRuntimeStatus(server);
  const isRunning = !!status?.State?.Running;
  server.status = isRunning ? "online" : "offline";
  server.startedAt = isRunning ? (status?.State?.StartedAt || server.startedAt || new Date().toISOString()) : null;
  if (server.runtimeType === 'local') {
      const info = getLocalProcessInfo(server.id);
      if (info) {
          server.pid = info.pid;
          server.jarPath = info.jarPath;
          server.logPath = info.logPath;
      }
  }
  res.json(server);
};

export const getServerStats = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const status = await getServerRuntimeStatus(server);
  const isRunning = !!status?.State?.Running;
  const startedAt = isRunning ? (status?.State?.StartedAt || server.startedAt || null) : null;
  let uptimeSeconds = 0;
  if (isRunning && startedAt) {
    const startedMs = new Date(startedAt).getTime();
    if (!isNaN(startedMs) && startedMs > 0) {
      uptimeSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    }
  }

  if (server.containerId) {
    const stats = await getServerRuntimeStats(server);
    res.json({
      ...stats,
      isRunning,
      status: isRunning ? "online" : "offline",
      startedAt,
      uptimeSeconds,
      limitRam: server.ram ? server.ram * 1024 : 1024,
      limitCpu: server.cpu || 100,
      limitDisk: server.disk || 10
    });
  } else {
    res.json({
      cpu: 0,
      ram: 0,
      disk: 0,
      isRunning: false,
      status: "offline",
      startedAt: null,
      uptimeSeconds: 0,
      limitRam: server.ram ? server.ram * 1024 : 1024,
      limitCpu: server.cpu || 100,
      limitDisk: server.disk || 10
    });
  }
};

export const checkPort = async (req: Request, res: Response) => {
  const { port } = req.query;
  if (!port) return res.status(400).json({ error: "Port is required" });
  
  const servers = await readJSON("servers.json") || [];
  const inUse = servers.some((s: any) => s.port == port);
  
  res.json({ inUse });
};

// Simple in-memory mutex to prevent race conditions on server creation
let isCreatingServer = false;

export const createServer = async (req: Request, res: Response) => {
  if (isCreatingServer) {
    return res.status(409).json({ error: "Server creation in progress, please try again in a few seconds." });
  }
  isCreatingServer = true;
  try {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") {
    return res.status(403).json({ error: "Only admins can create servers" });
  }
  let { name, ram, port, version, theme, cpu, disk, owner, ownerId, ipAlias, type, nodeId, runtimeType, javaVersion, ip, image, invocation, runtimeBackend } = req.body;
  const settings = await readJSON("settings.json") || {};
  const isDevPanel = (process.env.PANEL_TYPE === "dev" || process.env.PORT === "3000") && !process.env.FORCE_MAIN_PANEL;
  if (!isDevPanel) {
    runtimeType = settings.defaultRuntime || "wings";
  }
  if (!name || !ram || !port) {
    res.status(400).json({ error: "Missing required fields (name, ram, port)" });
    return;
  }

  const nodes = (await readJSON("nodes.json")) || (await readJSON("wings_nodes.json")) || [];
  if (!nodeId && nodes.length > 0) {
    nodeId = nodes[0].id;
  }
  if (!nodeId) {
    res.status(400).json({ error: "No Wings node available. Please create a Node first." });
    return;
  }

  const selectedNodeIndex = nodes.findIndex((n: any) => n.id === nodeId);
  if (selectedNodeIndex === -1) {
    res.status(400).json({ error: "Selected Node does not exist." });
    return;
  }
  const selectedNode = nodes[selectedNodeIndex];

  const id = crypto.randomUUID();
  const serverIp = ip || selectedNode.publicIpV4 || "127.0.0.1";
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    res.status(400).json({ error: "Port must be a valid TCP port (1-65535)" });
    return;
  }

  if (!Array.isArray(selectedNode.allocations)) {
    selectedNode.allocations = [];
  }
  const nodeAllocations = selectedNode.allocations;
  let allocation = nodeAllocations.find(
    (a: any) => Number(a.port) === portNumber && a.ip === serverIp
  );

  if (allocation && allocation.assigned) {
    res.status(400).json({
      error: `Allocation ${serverIp}:${portNumber} is already assigned on this node.`
    });
    return;
  }

  if (allocation) {
    allocation.assigned = true;
    allocation.server = id;
  } else {
    allocation = { id: crypto.randomUUID(), ip: serverIp, port: portNumber, assigned: true, server: id };
    nodeAllocations.push(allocation);
  }
  nodes[selectedNodeIndex] = selectedNode;
  await writeJSON("nodes.json", nodes);
  await writeJSON("wings_nodes.json", nodes);

  const serverData = {
    id,
    name,
    owner: owner || ownerId || user.id,
    ram,
    cpu: cpu || 100,
    disk: disk || 10,
    port: portNumber,
    ip: serverIp,
    allocationId: allocation.id,
    ipAlias: ipAlias || "",
    runtimeType: runtimeType || "wings",
    nodeId: nodeId,
    type: type || "PAPER",
    version: version || "26.3",
    javaVersion: javaVersion || "",
    theme: theme || "default",
    // Resolve the runtime configuration now, from the node's defaults, so the
    // server is self-describing. Previously these were left unset and the node's
    // defaultImage/defaultInvocation were only ever read from the daemon's cached
    // config - so editing the node after the daemon booted had no effect and the
    // server failed to start with an opaque 500.
    image: image || selectedNode.defaultImage || "",
    invocation: invocation || selectedNode.defaultInvocation || "",
    runtimeBackend: runtimeBackend || selectedNode.runtimeBackend || "docker",
    status: "installing",
    createdAt: new Date().toISOString(),
    containerId: null as string | null,
  };

  let servers = await readJSON("servers.json") || [];

  if (servers.find((s: any) => s.nodeId === nodeId && s.port == portNumber)) {
    res.status(400).json({ error: "Port is already in use by another server on this node." });
    return;
  }

  servers.push(serverData);
  await writeJSON("servers.json", servers);

  // Pre-seed files for Node.js and Python applications
  try {
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    await fs.ensureDir(serverDir);
    const upperType = (type || "PAPER").toUpperCase();
    if (upperType === "NODEJS" || upperType === "NODE") {
      const indexPath = path.join(serverDir, "index.js");
      const pkgPath = path.join(serverDir, "package.json");
      if (!fs.existsSync(indexPath)) {
        await fs.writeFile(indexPath, `// Node.js Application on JTG Panel\nconst http = require('http');\nconst port = process.env.PORT || process.env.SERVER_PORT || ${port};\n\nconsole.log('==============================================');\nconsole.log('🚀 Node.js Application Running on port ' + port);\nconsole.log('Node Version: ' + process.version);\nconsole.log('Upload your files in File Manager to customize!');\nconsole.log('==============================================');\n\nconst server = http.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify({\n    status: 'online',\n    runtime: 'node.js',\n    time: new Date().toISOString()\n  }));\n});\n\nserver.listen(port, '0.0.0.0', () => {\n  console.log(\`[Server] Listening on http://0.0.0.0:\${port}\`);\n});\n`);
      }
      if (!fs.existsSync(pkgPath)) {
        await fs.writeFile(pkgPath, JSON.stringify({
          name: name.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || "node-app",
          version: "1.0.0",
          description: "Node.js application hosted on JTG Panel",
          main: "index.js",
          scripts: {
            "start": "node index.js"
          },
          dependencies: {}
        }, null, 2));
      }
    } else if (upperType === "PYTHON" || upperType === "PYTHON3") {
      const mainPath = path.join(serverDir, "main.py");
      const reqPath = path.join(serverDir, "requirements.txt");
      if (!fs.existsSync(mainPath)) {
        await fs.writeFile(mainPath, `# Python Application on JTG Panel\nimport os\nimport sys\nfrom http.server import HTTPServer, BaseHTTPRequestHandler\n\nport = int(os.environ.get("SERVER_PORT", os.environ.get("PORT", ${port})))\n\nprint("==============================================", flush=True)\nprint("🐍 Python Application Running", flush=True)\nprint(f"Python Version: {sys.version}", flush=True)\nprint(f"Listening Port: {port}", flush=True)\nprint("Upload your files in File Manager to customize!", flush=True)\nprint("==============================================", flush=True)\n\nclass RequestHandler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200)\n        self.send_header('Content-type', 'application/json')\n        self.end_headers()\n        self.wfile.write(b'{"status": "online", "runtime": "python"}')\n\n    def log_message(self, format, *args):\n        print(f"[{self.log_date_time_string()}] {format % args}", flush=True)\n\nserver = HTTPServer(('0.0.0.0', port), RequestHandler)\nprint(f"[Server] Listening on http://0.0.0.0:{port}", flush=True)\n\ntry:\n    server.serve_forever()\nexcept KeyboardInterrupt:\n    print("\\nStopping server...", flush=True)\n    server.server_close()\n`);
      }
      if (!fs.existsSync(reqPath)) {
        await fs.writeFile(reqPath, "# Add python dependencies here\n");
      }
    } else {
      // Minecraft Server Pre-seeding
      const eulaPath = path.join(serverDir, "eula.txt");
      if (!fs.existsSync(eulaPath)) {
        await fs.writeFile(eulaPath, "eula=true\n");
      }
      const propsPath = path.join(serverDir, "server.properties");
      if (!fs.existsSync(propsPath)) {
        await fs.writeFile(propsPath, `server-port=${port}\nquery.port=${port}\nenable-rcon=true\nrcon.port=${parseInt(port) + 10}\nrcon.password=admin\nmotd=A Minecraft Server on JTG Panel\n`);
      }
      // Only the panel-local runtime owns files under .data. For Wings nodes the
      // server files live on the node's own filesystem, so downloading a jar here
      // would only waste bandwidth and panel disk.
      if (!serverData.runtimeType || serverData.runtimeType === "local") {
        const jarPath = path.join(serverDir, "server.jar");
        if (!fs.existsSync(jarPath)) {
          try {
            console.log(`[createServer] Downloading initial server.jar for ${name} (${upperType} ${version})...`);
            await downloadJar(upperType, version || "26.2", jarPath);
          } catch (dlErr: any) {
            console.warn("[createServer] Initial jar download deferred to background:", dlErr.message);
          }
        }
      }
    }
  } catch (seedErr) {
    console.warn("Failed to pre-seed starter files:", seedErr);
  }

  try {
    const containerId = await createServerRuntime(serverData);
    serverData.containerId = containerId == null ? null : String(containerId);
    serverData.status = "offline";
    await writeJSON("servers.json", Object.assign(servers, servers.map((s:any)=>s.id===id?serverData:s)));
    await createSftpUser(id).catch(e => console.error("SFTP user creation failed:", e));
    res.json(serverData);
  } catch (err: any) {
    console.error(err);
    await releaseNodeAllocation(nodeId, serverIp, portNumber, id);
    servers = (await readJSON("servers.json") || []).filter((s: any) => s.id !== id);
    await writeJSON("servers.json", servers);
    res.status(500).json({ error: err.message });
  }
  } finally {
    isCreatingServer = false;
  }
};

const releaseNodeAllocation = async (nodeId: string, ip: string, port: number, serverId: string) => {
  try {
    const nodes = (await readJSON("nodes.json")) || (await readJSON("wings_nodes.json")) || [];
    const node = nodes.find((n: any) => n.id === nodeId);
    if (!node || !Array.isArray(node.allocations)) return;
    const alloc = node.allocations.find((a: any) => a.server === serverId || (a.ip === ip && Number(a.port) === Number(port)));
    if (alloc) {
      alloc.assigned = false;
      alloc.server = null;
      await writeJSON("nodes.json", nodes);
      await writeJSON("wings_nodes.json", nodes);
    }
  } catch (e) {
    console.error("Failed to release node allocation:", e);
  }
};

export const updateOwner = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") {
    return res.status(403).json({ error: "Only admins can update owner" });
  }

  const { id } = req.params;
  const { owner } = req.body;

  if (!owner) return res.status(400).json({ error: "Owner required" });

  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);

  if (!server) return res.status(404).json({ error: "Server not found" });

  server.owner = owner;
  await writeJSON("servers.json", servers);
  
  res.json({ success: true });
};

export const updateIpAlias = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { ipAlias } = req.body;

  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);

  if (!server) return res.status(404).json({ error: "Server not found" });

  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  server.ipAlias = ipAlias;
  await writeJSON("servers.json", servers);
  
  res.json({ success: true });
};

export const deleteServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    
    let servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Only admins can delete servers" });
    }

    if (server.containerId) {
      await deleteServerRuntime(server);
    }
    
    servers = servers.filter((s: any) => s.id !== id);
    await writeJSON("servers.json", servers);

    if (server.nodeId) {
      await releaseNodeAllocation(server.nodeId, server.ip, server.port, id);
    }

    // Remove files
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    try {
      await fs.remove(serverDir);
    } catch (e) {
      console.error("Failed to remove server directory", e);
    }
    
    await deleteSftpUser(id).catch(e => console.error("SFTP user deletion failed:", e));
    
    res.json({ success: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const startServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;

  if (serverOperationLocks.has(id)) {
    return res.status(409).json({ error: "Another operation is already in progress on this server. Please wait." });
  }
  serverOperationLocks.add(id);

  try {
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage this server" });
    }

    if (server.suspended) {
      return res.status(403).json({ error: "Server is suspended" });
    }

    // Check if already running
    const currentStatus = await getServerRuntimeStatus(server);
    if (currentStatus?.State?.Running) {
      return res.json({ success: true, message: "Server is already running", startedAt: server.startedAt });
    }

    const serverDir = path.join(process.cwd(), ".data", "servers", server.id);
    await fs.ensureDir(serverDir);

    // Preflight: a server with neither its own image nor a configured default
    // can never start, and the runtime failure that follows is opaque ("failed
    // to remain running"). Fail with the actual missing setting instead.
    if (!server.image && !server.invocation) {
      try {
        const nodes = (await readJSON("nodes.json")) || [];
        const node = nodes.find((n: any) => n.id === server.nodeId);
        const missing: string[] = [];
        if (!server.image && !node?.defaultImage) missing.push("default image");
        if (!server.invocation && !node?.defaultInvocation) missing.push("default invocation");
        if (missing.length) {
          return res.status(400).json({
            error:
              `This server has no ${missing.join(" or ")} configured. ` +
              `Set a default image and invocation on node "${node?.name || server.nodeId}", ` +
              `or set them on the server, then start it again.`,
          });
        }
      } catch {
        // Never let the preflight itself mask a start attempt.
      }
    }

    // If server has a mock container ID or missing container ID, and Docker is now enabled, recreate real container
    const isMockId = !server.containerId || server.containerId.startsWith("mock-container-id-");
    const isSandboxTarget = await checkNodeSandbox(server.nodeId);
    if (server.runtimeType !== "local" && isMockId && !isSandboxTarget) {
      console.log(`[startServer] Server ${server.id} has mock container ID. Creating real Docker container...`);
      server.containerId = await createServerRuntime(server);
      await writeJSON("servers.json", servers);
    } else if (!server.containerId) {
      server.containerId = await createServerRuntime(server);
      await writeJSON("servers.json", servers);
    }

    // Ensure server.jar is present for Minecraft servers before boot. Only the
    // panel-local runtime keeps files under .data; Wings nodes own their own files.
    const upperType = (server.type || "PAPER").toUpperCase();
    if (
      (!server.runtimeType || server.runtimeType === "local") &&
      !["NODEJS", "NODE", "PYTHON", "PYTHON3"].includes(upperType)
    ) {
      const jarPath = path.join(serverDir, "server.jar");
      if (!fs.existsSync(jarPath)) {
        try {
          console.log(`[startServer] server.jar missing for ${server.name || server.id}. Downloading now...`);
          await downloadJar(server.type || "paper", server.version || "26.2", jarPath);
        } catch (dlErr: any) {
          console.warn(`[startServer] JAR pre-download warning: ${dlErr.message}`);
        }
      }
    }
    
    // PRE-FLIGHT CHECKS
    try {
      // 1. Check for stale session locks and remove them if server is stopped
      const lockFiles = [
        path.join(serverDir, "world", "session.lock"),
        path.join(serverDir, "world_nether", "session.lock"),
        path.join(serverDir, "world_the_end", "session.lock")
      ];
      for (const lockFile of lockFiles) {
        if (await fs.pathExists(lockFile)) {
          try {
            await fs.remove(lockFile);
          } catch (e) {
            return res.status(500).json({ error: `Startup Pre-flight Failed: Unable to clean stale ${path.basename(lockFile)}` });
          }
        }
      }
      
      // 2. Check permissions on server folder
      await fs.access(serverDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (preflightErr: any) {
      console.error("Pre-flight check warning:", preflightErr.message);
    }

    const io = req.app.get("io");
    if (io) io.to(`server_${id}`).emit("clear_logs");
    
    try {
      await startServerRuntime(server);
    } catch (startErr: any) {
      const startErrMsg = String(startErr?.message || startErr);
      if (startErrMsg.includes("ECONNREFUSED") || startErrMsg.includes("docker.sock")) {
        console.warn(`Docker daemon unreachable on /var/run/docker.sock (${startErrMsg}). Reverting server ${server.id} to fallback runtime.`);
        server.containerId = "mock-container-id-" + server.id;
        await writeJSON("servers.json", servers);
        await startServerRuntime(server);
      } else if (startErr.statusCode === 404 || (startErr.message && startErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container missing for server ${server.id}. Recreating...`);
        server.containerId = await createServerRuntime(server);
        await startServerRuntime(server);
      } else {
        throw startErr;
      }
    }

    // REAL RUNTIME VERIFICATION
    const verifiedStatus = await getServerRuntimeStatus(server);
    if (!verifiedStatus?.State?.Running) {
      server.status = "offline";
      server.startedAt = null;
      await writeJSON("servers.json", servers);
      return res.status(500).json({ error: "Server process failed to remain running after start. Check server console for logs." });
    }

    server.status = "online";
    server.startedAt = verifiedStatus.State.StartedAt || new Date().toISOString();
    await writeJSON("servers.json", servers);

    await attachServerRuntimeSocket(server, server.id);
    if (io) io.to(`server_${id}`).emit("status_change", { status: "online", startedAt: server.startedAt });

    res.json({ success: true, startedAt: server.startedAt });
  } catch (err: any) {
    console.error("Start server error:", err);
    res.status(500).json({ error: err.message || "Failed to start server" });
  } finally {
    serverOperationLocks.delete(id);
  }
};

export const stopServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;

  if (serverOperationLocks.has(id)) {
    return res.status(409).json({ error: "Another operation is already in progress on this server. Please wait." });
  }
  serverOperationLocks.add(id);

  try {
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage this server" });
    }

    try {
      await stopServerRuntime(server);
    } catch (stopErr: any) {
      if (stopErr.statusCode === 404 || (stopErr.message && stopErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container already missing for server ${server.id}. Assuming stopped.`);
      } else {
        throw stopErr;
      }
    }

    // Verify server actually stopped; if lingering, force terminate
    const postStopStatus = await getServerRuntimeStatus(server);
    if (postStopStatus?.State?.Running) {
      await killServerRuntime(server);
    }

    server.status = "offline";
    server.startedAt = null;
    await writeJSON("servers.json", servers);

    const io = req.app.get("io");
    if (io) io.to(`server_${id}`).emit("status_change", { status: "offline", startedAt: null });

    res.json({ success: true });
  } catch (err: any) {
    console.error("Stop server error:", err);
    res.status(500).json({ error: err.message || "Failed to stop server" });
  } finally {
    serverOperationLocks.delete(id);
  }
};

export const killServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;

  if (serverOperationLocks.has(id)) {
    return res.status(409).json({ error: "Another operation is already in progress on this server." });
  }
  serverOperationLocks.add(id);

  try {
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage this server" });
    }

    await killServerRuntime(server);
    server.status = "offline";
    server.startedAt = null;
    await writeJSON("servers.json", servers);

    const io = req.app.get("io");
    if (io) io.to(`server_${id}`).emit("status_change", { status: "offline", startedAt: null });

    res.json({ success: true, message: "Server forcefully killed" });
  } catch (err: any) {
    console.error("Kill server error:", err);
    res.status(500).json({ error: err.message || "Failed to kill server" });
  } finally {
    serverOperationLocks.delete(id);
  }
};

export const restartServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;

  if (serverOperationLocks.has(id)) {
    return res.status(409).json({ error: "Another operation is already in progress on this server. Please wait." });
  }
  serverOperationLocks.add(id);

  try {
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to manage this server" });
    }

    // Step 1: STOP
    try {
      await stopServerRuntime(server);
    } catch (e) {}

    // Step 2: WAIT UNTIL ACTUALLY STOPPED
    let isStopped = false;
    for (let i = 0; i < 20; i++) {
      const status = await getServerRuntimeStatus(server);
      if (!status?.State?.Running) {
        isStopped = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!isStopped) {
      await killServerRuntime(server);
    }

    server.status = "offline";
    server.startedAt = null;
    await writeJSON("servers.json", servers);

    // Step 3: START
    const io = req.app.get("io");
    if (io) io.to(`server_${id}`).emit("clear_logs");

    await startServerRuntime(server);

    // Step 4: WAIT UNTIL ACTUALLY RUNNING & VERIFY
    const verifiedStatus = await getServerRuntimeStatus(server);
    if (!verifiedStatus?.State?.Running) {
      server.status = "offline";
      server.startedAt = null;
      await writeJSON("servers.json", servers);
      return res.status(500).json({ error: "Server failed to start during restart." });
    }

    server.status = "online";
    server.startedAt = verifiedStatus.State.StartedAt || new Date().toISOString();
    await writeJSON("servers.json", servers);

    await attachServerRuntimeSocket(server, server.id);
    if (io) io.to(`server_${id}`).emit("status_change", { status: "online", startedAt: server.startedAt });

    res.json({ success: true, startedAt: server.startedAt });
  } catch (err: any) {
    console.error("Restart server error:", err);
    res.status(500).json({ error: err.message || "Failed to restart server" });
  } finally {
    serverOperationLocks.delete(id);
  }
};

export const sendCommand = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { command } = req.body;
    const user = (req as any).user;

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to send commands to this server" });
    }

    await sendServerRuntimeCommand(server, command);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Command error:", err);
    res.status(500).json({ error: err.message || "Failed to send command" });
  }
};

export const changeServerVersion = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { version, type, javaVersion, dockerImage, serverJar, startupCommand } = req.body;
    const user = (req as any).user;
    
    if (!version) return res.status(400).json({ error: "Version is required" });
    
    let servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Only admins or owners can change version" });
    }

    if (server.containerId) {
      const status = await getServerRuntimeStatus(server);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Server must be stopped before changing version. Please stop the server first." });
      }
      // Delete old container
      await deleteServerRuntime(server);
    }
    
    // Automatically delete config files to avoid issues when switching versions/types
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    const filesToDelete = [
      "paper-global.yml", "paper-world-defaults.yml", "paper.yml",
      "config/paper-global.yml", "config/paper-world-defaults.yml",
      "world/data/random_sequences.dat"
    ];
    
    for (const file of filesToDelete) {
      const filePath = path.join(serverDir, file);
      try {
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
        }
      } catch (e) {
        console.error(`Failed to delete ${file}`, e);
      }
    }
    
    server.version = version;
    if (type) {
      server.type = type;
    }
    if (javaVersion !== undefined) {
      server.javaVersion = javaVersion;
    }
    if (dockerImage !== undefined) {
      server.dockerImage = dockerImage;
    }
    if (serverJar !== undefined) {
      server.serverJar = serverJar;
    }
    if (startupCommand !== undefined) {
      server.startupCommand = startupCommand;
    }

    // When changing version for Minecraft servers, download the new JAR.
    // Wings nodes manage their own server files, so only seed the panel-local runtime.
    const upperType = (server.type || type || "PAPER").toUpperCase();
    if (
      (!server.runtimeType || server.runtimeType === "local") &&
      !["NODEJS", "NODE", "PYTHON", "PYTHON3"].includes(upperType)
    ) {
      const jarPath = path.join(serverDir, "server.jar");
      try {
        console.log(`[changeServerVersion] Downloading new server.jar for ${server.name || id} (${upperType} ${version})...`);
        await downloadJar(type || server.type || "paper", version, jarPath);
      } catch (dlErr: any) {
        console.warn(`[changeServerVersion] Jar download warning during version switch: ${dlErr.message}`);
      }
    }

    // Recreate container with new version env
    const newContainerId = await createServerRuntime(server);
    server.containerId = newContainerId;
    
    await writeJSON("servers.json", servers);
    
    res.json({ success: true, version, type: server.type });
  } catch (err: any) {
    console.error("Change version error", err);
    res.status(500).json({ error: err.message });
  }
};

const checkServerFileAccess = async (req: Request, res: Response): Promise<boolean> => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return false;
  }
  if (user && user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    res.status(403).json({ error: "Forbidden: Access denied to this server's files" });
    return false;
  }
  return true;
};

const BACKUPS_ROOT = path.join(process.cwd(), ".data", "backups");

const getBackupDir = (id: unknown): string | null => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return path.join(BACKUPS_ROOT, id);
};

// File manager basics
export const getFiles = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const dirPath = req.query.path ? String(req.query.path) : "/";
  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverDir, dirPath);
  if (!targetPath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    const stats = await fs.stat(targetPath).catch(() => null);
    if (!stats) {
      // Return empty if not found
      return res.json([]);
    }
    if (stats.isFile()) {
       const content = await fs.readFile(targetPath, "utf-8");
       return res.json({ isFile: true, content });
    }
    const files = await fs.readdir(targetPath, { withFileTypes: true });
    res.json(files.map(f => ({
      name: f.name,
      isDirectory: f.isDirectory(),
      size: f.isDirectory() ? 0 : fs.statSync(path.join(targetPath, f.name)).size
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};


export const uploadChunk = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { uploadId, chunkIndex, fileName, path: dirPath } = req.body;
  
  if (!req.file || !uploadId || chunkIndex === undefined || !fileName) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverDir, dirPath || "/");
  const partFilePath = targetPath && resolveWithin(targetPath, fileName + ".part");
  if (!targetPath || !partFilePath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    await fs.ensureDir(targetPath);
    
    // If it's the first chunk, ensure we start fresh
    if (String(chunkIndex) === "0") {
      if (fs.existsSync(partFilePath)) {
        await fs.remove(partFilePath);
      }
    }

    // Read the uploaded chunk and append it
    const chunkData = await fs.readFile(req.file.path);
    await fs.appendFile(partFilePath, chunkData);
    
    // Cleanup multer temp file
    await fs.remove(req.file.path).catch(() => {});
    
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const completeUpload = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { uploadId, fileName, path: dirPath, totalChunks } = req.body;
  if (!uploadId || !fileName || !totalChunks) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverDir, dirPath || "/");
  const finalFilePath = targetPath && resolveWithin(targetPath, fileName);
  const partFilePath = targetPath && resolveWithin(targetPath, fileName + ".part");
  if (!targetPath || !finalFilePath || !partFilePath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    if (fs.existsSync(partFilePath)) {
      await fs.move(partFilePath, finalFilePath, { overwrite: true });
    } else {
      // In case totalChunks was 0 or something weird, but usually part file must exist.
      throw new Error("Part file missing");
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const uploadFile = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  let dirPath = req.body.path || "/";
  
  // If dirPath matches or ends with the uploaded file name, normalize to parent directory
  if (req.file) {
    if (dirPath === req.file.originalname || dirPath === `/${req.file.originalname}` || dirPath === `\\${req.file.originalname}`) {
      dirPath = "/";
    } else if (dirPath.endsWith(req.file.originalname)) {
      dirPath = path.dirname(dirPath);
    }
  }

  const serverBase = getServerDir(id);
  if (!serverBase) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverBase, dirPath);
  if (!targetPath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (req.file) {
    await fs.ensureDir(targetPath);
    const destFile = path.join(targetPath, req.file.originalname);
    await fs.move(req.file.path, destFile, { overwrite: true });
  }
  res.json({ success: true });
};

export const deleteFile = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const filePaths = req.body.paths || (req.body.path ? [req.body.path] : []);

  try {
    for (const filePath of filePaths) {
      const targetPath = resolveWithin(serverDir, filePath);
      if (!targetPath) {
        return res.status(400).json({ error: "Invalid path" });
      }
      if (path.resolve(targetPath) === path.resolve(serverDir)) {
        return res.status(400).json({ error: "Refusing to delete the server root directory" });
      }
      await fs.remove(targetPath);
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const zipFiles = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { dirPath, fileNames, outputName } = req.body;
  
  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const baseDir = resolveWithin(serverDir, dirPath);
  if (!baseDir) {
    return res.status(400).json({ error: "Invalid path" });
  }
  const outZipPath = resolveWithin(baseDir, outputName || "archive.zip");
  if (!outZipPath) {
    return res.status(400).json({ error: "Invalid output file name" });
  }

  try {
    const output = fs.createWriteStream(outZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => {
      res.json({ success: true, filename: outputName || "archive.zip" });
    });

    archive.on("error", (err: any) => {
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(output);

    for (const name of fileNames) {
      const filePath = path.join(baseDir, name);
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        archive.directory(filePath, name);
      } else {
        archive.file(filePath, { name });
      }
    }

    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

export const renameFile = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { oldPath, newPath } = req.body;

  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetOldPath = resolveWithin(serverDir, oldPath);
  const targetNewPath = resolveWithin(serverDir, newPath);

  if (!targetOldPath || !targetNewPath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    await fs.rename(targetOldPath, targetNewPath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export const downloadFile = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  let rawPaths: string[] = [];
  if (req.query.paths) {
    rawPaths = Array.isArray(req.query.paths) ? (req.query.paths as string[]) : String(req.query.paths).split(",");
  } else if (req.query.path) {
    rawPaths = [String(req.query.path)];
  }

  if (rawPaths.length === 0) {
    return res.status(400).json({ error: "No path specified" });
  }

  const serverBaseDir = getServerDir(id);
  if (!serverBaseDir) return res.status(400).json({ error: "Invalid server id" });

  try {
    if (rawPaths.length === 1) {
      const singlePath = rawPaths[0];
      const targetPath = resolveWithin(serverBaseDir, singlePath);

      if (!targetPath) {
        return res.status(400).json({ error: "Invalid path" });
      }

      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        return res.download(targetPath, path.basename(targetPath));
      }
    }

    // Multiple items OR a single directory -> stream as ZIP
    const zipName = rawPaths.length === 1 
      ? `${path.basename(rawPaths[0]) || "folder"}.zip`
      : `download-${Date.now()}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", (err: any) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    for (const relPath of rawPaths) {
      const targetPath = resolveWithin(serverBaseDir, relPath);
      if (!targetPath) continue;
      const itemName = path.basename(targetPath);
      const stat = await fs.stat(targetPath).catch(() => null);
      if (!stat) continue;

      if (stat.isDirectory()) {
        archive.directory(targetPath, itemName);
      } else {
        archive.file(targetPath, { name: itemName });
      }
    }

    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

export const unzipFile = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { path: filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: "Archive file path is required" });
  }

  const serverBaseDir = getServerDir(id);
  if (!serverBaseDir) return res.status(400).json({ error: "Invalid server id" });
  let targetPath = resolveWithin(serverBaseDir, filePath);
  if (!targetPath) {
    return res.status(400).json({ error: "Invalid path: Access outside server directory is forbidden" });
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` });
  }

  try {
    const stat = await fs.stat(targetPath);
    
    // If targetPath is a directory (e.g. a folder named 'Stad 2_0.zip')
    if (stat.isDirectory()) {
      const baseName = path.basename(targetPath);
      const nestedFilePath = path.join(targetPath, baseName);
      
      // Check if there is an actual archive file inside this folder with the same name
      if (fs.existsSync(nestedFilePath) && (await fs.stat(nestedFilePath)).isFile()) {
        targetPath = nestedFilePath;
      } else {
        // Look for any archive file inside this directory
        const filesInside = await fs.readdir(targetPath);
        const archiveInside = filesInside.find(f => /\.(zip|tar|gz|tgz|jar|rar|7z)$/i.test(f));
        if (archiveInside) {
          targetPath = path.join(targetPath, archiveInside);
        } else {
          return res.status(400).json({ error: `'${filePath}' is a folder directory, not an archive file.` });
        }
      }
    }

    const destDir = path.dirname(targetPath);
    const result = await extractArchive(targetPath, destDir);
    res.json({ success: true, method: result.method });
  } catch (e: any) {
    console.error("Extraction error:", e);
    res.status(500).json({ error: e.message || "Failed to extract archive file" });
  }
};


export const createFile = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { filePath } = req.body;
  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverDir, filePath);
  if (!targetPath) {
    return res.status(400).json({ error: "Invalid path" });
  }
  try {
    await fs.writeFile(targetPath, "", "utf-8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const createDirectory = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { filePath } = req.body;
  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverDir, filePath);
  if (!targetPath) {
    return res.status(400).json({ error: "Invalid path" });
  }
  try {
    await fs.mkdir(targetPath, { recursive: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const saveFileContent = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const { filePath, content } = req.body;

  const serverDir = getServerDir(id);
  if (!serverDir) return res.status(400).json({ error: "Invalid server id" });
  const targetPath = resolveWithin(serverDir, filePath);
  if (!targetPath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    await fs.writeFile(targetPath, content, "utf-8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export const getBackups = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const backupsDir = path.join(process.cwd(), ".data", "backups", id);
  await fs.ensureDir(backupsDir);

  try {
    const files = await fs.readdir(backupsDir);
    const backups = [];
    for (const file of files) {
      if (file.endsWith(".zip")) {
        const stats = await fs.stat(path.join(backupsDir, file));
        backups.push({
          filename: file,
          size: stats.size,
          createdAt: stats.birthtime,
        });
      }
    }
    backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json(backups);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const createBackup = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  const backupsDir = path.join(process.cwd(), ".data", "backups", id);
  await fs.ensureDir(backupsDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${timestamp}.zip`;
  const backupPath = path.join(backupsDir, filename);

  try {
    const serverExists = await fs.pathExists(serverDir);
    if (!serverExists) {
       await fs.ensureDir(serverDir); // ensure it acts properly if empty
    }

    const output = fs.createWriteStream(backupPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => {
      if (!res.headersSent) res.json({ success: true, filename });
    });

    archive.on("error", (err: any) => {
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(output);
    archive.directory(serverDir, false);
    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

export const downloadBackup = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id, filename } = req.params;
  const backupDir = getBackupDir(id);
  if (!backupDir) return res.status(400).send("Invalid server id");
  const backupPath = resolveWithin(backupDir, filename);
  if (!backupPath) {
    return res.status(400).send("Invalid path");
  }

  if (await fs.pathExists(backupPath)) {
    res.download(backupPath);
  } else {
    res.status(404).send("Backup not found");
  }
};

export const deleteBackup = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id, filename } = req.params;
  const backupDir = getBackupDir(id);
  if (!backupDir) return res.status(400).json({ error: "Invalid server id" });
  const backupPath = resolveWithin(backupDir, filename);
  if (!backupPath) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    await fs.remove(backupPath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};
// Helper to safely download a file without leaving corrupt or partial files on error
const downloadFileSafely = async (downloadUrl: string, targetDir: string, filename: string): Promise<string> => {
  const axios = (await import("axios")).default;
  await fs.ensureDir(targetDir);

  // Sanitize filename and ensure .jar extension
  let safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safeFilename.toLowerCase().endsWith(".jar")) {
    safeFilename += ".jar";
  }

  const finalFilePath = path.join(targetDir, safeFilename);
  const tempFilePath = path.join(targetDir, `${safeFilename}.${Date.now()}.download.tmp`);

  try {
    const response = await axios({
      url: downloadUrl,
      method: "GET",
      responseType: "stream",
      timeout: 60000,
      headers: {
        "User-Agent": "JTG-Panel/1.0 (Minecraft Server Manager)"
      }
    });

    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const stat = await fs.stat(tempFilePath).catch(() => null);
    if (!stat || stat.size === 0) {
      await fs.remove(tempFilePath).catch(() => {});
      throw new Error("Downloaded file was empty or incomplete.");
    }

    await fs.move(tempFilePath, finalFilePath, { overwrite: true });
    return safeFilename;
  } catch (err: any) {
    await fs.remove(tempFilePath).catch(() => {});
    throw err;
  }
};

// Helper to resolve best Modrinth version and file matching server type and version
const resolveModrinthVersionAndFile = async (
  projectId: string,
  serverType: string,
  serverVersion: string,
  specificVersionId?: string,
  specificFileUrl?: string,
  specificFileName?: string
) => {
  const axios = (await import("axios")).default;

  // 1. If exact file URL and filename were specified by the user
  if (specificFileUrl && specificFileName) {
    return {
      downloadUrl: specificFileUrl,
      filename: specificFileName,
      versionNumber: "Selected Release File"
    };
  }

  // 2. If a specific version was chosen by the user
  if (specificVersionId) {
    const vRes = await axios.get(`https://api.modrinth.com/v2/version/${specificVersionId}`, {
      headers: { "User-Agent": "JTG-Panel/1.0" }
    });
    if (vRes.data && vRes.data.files && vRes.data.files.length > 0) {
      const file = vRes.data.files.find((f: any) => f.primary) ||
                   vRes.data.files.find((f: any) => f.filename.endsWith(".jar")) ||
                   vRes.data.files[0];
      return {
        downloadUrl: file.url,
        filename: file.filename,
        versionNumber: vRes.data.version_number || vRes.data.name
      };
    }
  }

  // 3. Auto-detect based on server type & version
  const isMod = ["FABRIC", "FORGE", "NEOFORGE", "QUILT"].includes(serverType.toUpperCase());
  const loaders = isMod
    ? (serverType.toUpperCase() === "QUILT" ? ["quilt", "fabric"] : [serverType.toLowerCase()])
    : ["paper", "spigot", "purpur", "bukkit", "folia"];

  let gameVer = String(serverVersion || "1.21.4").trim();
  if (gameVer.startsWith("26") || gameVer.toLowerCase() === "latest") {
    gameVer = "1.21.4";
  }

  const verRes = await axios.get(`https://api.modrinth.com/v2/project/${projectId}/version`, {
    headers: { "User-Agent": "JTG-Panel/1.0" }
  });

  const versions = verRes.data;
  if (!versions || versions.length === 0) {
    return null;
  }

  // A. Try exact loader + exact game version
  let match = versions.find((v: any) =>
    Array.isArray(v.loaders) &&
    v.loaders.some((l: string) => loaders.includes(l.toLowerCase())) &&
    Array.isArray(v.game_versions) &&
    v.game_versions.includes(gameVer)
  );

  // B. Try exact loader + minor version prefix (e.g. "1.21")
  if (!match) {
    const minorVer = gameVer.split(".").slice(0, 2).join(".");
    match = versions.find((v: any) =>
      Array.isArray(v.loaders) &&
      v.loaders.some((l: string) => loaders.includes(l.toLowerCase())) &&
      Array.isArray(v.game_versions) &&
      v.game_versions.some((gv: string) => gv.startsWith(minorVer))
    );
  }

  // C. Try exact loader (latest release for that loader)
  if (!match) {
    match = versions.find((v: any) =>
      Array.isArray(v.loaders) &&
      v.loaders.some((l: string) => loaders.includes(l.toLowerCase()))
    );
  }

  // D. Fallback to newest version available
  if (!match) {
    match = versions[0];
  }

  if (!match || !match.files || match.files.length === 0) return null;

  const file = match.files.find((f: any) => f.primary) ||
               match.files.find((f: any) => f.filename.endsWith(".jar") && !f.filename.includes("-sources") && !f.filename.includes("-dev")) ||
               match.files.find((f: any) => f.filename.endsWith(".jar")) ||
               match.files[0];

  return {
    downloadUrl: file.url,
    filename: file.filename,
    versionNumber: match.version_number || match.name
  };
};

export const installPlugin = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const serversJSON = await readJSON("servers.json");
  const server = serversJSON?.find((s: any) => s.id === id);
  if (!server) return res.status(404).json({ error: "Server not found" });
  if (user && user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const serverType = (server.type || "").toUpperCase();

  // Explicitly check for Proxy software and reject
  const isProxy = ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(serverType);
  if (isProxy) {
    return res.status(400).json({
      error: "Plugin Manager is disabled for proxy servers (Velocity, BungeeCord, Waterfall). Proxy plugins must be placed manually via File Manager."
    });
  }

  const pluginCompatibleTypes = ["PAPER", "SPIGOT", "BUKKIT", "PURPUR"];
  if (!pluginCompatibleTypes.includes(serverType)) {
    return res.status(400).json({
      error: `Cannot install Bukkit/Spigot plugins on a ${server.type} server. This software does not support Bukkit plugins.`
    });
  }

  const { source, pluginId, pluginName, versionId, fileUrl, fileName } = req.body;

  // Direct downloadUrl fallback for manual/legacy downloads
  if (req.body.downloadUrl) {
    try {
      const serverDir = path.join(process.cwd(), ".data", "servers", id);
      const pluginsDir = path.join(serverDir, "plugins");
      const installedName = await downloadFileSafely(req.body.downloadUrl, pluginsDir, req.body.filename || `${pluginName}.jar`);
      return res.json({ success: true, message: `Plugin ${installedName} installed successfully!`, filename: installedName });
    } catch (e: any) {
      return res.status(500).json({ error: "Failed to install plugin: " + e.message });
    }
  }

  if (!pluginId) {
    return res.status(400).json({ error: "Missing pluginId" });
  }

  try {
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    const pluginsDir = path.join(serverDir, "plugins");
    let downloadUrl: string | null = null;
    let filename: string = fileName || `${(pluginName || pluginId).replace(/[^a-zA-Z0-9]/g, '_')}.jar`;
    let installedVersion = "";

    const currentSource = source || 'modrinth';

    if (currentSource === 'modrinth') {
      const resolved = await resolveModrinthVersionAndFile(
        pluginId,
        server.type,
        server.version,
        versionId,
        fileUrl,
        fileName
      );

      if (!resolved || !resolved.downloadUrl) {
        return res.status(404).json({ error: "Could not find a compatible plugin version on Modrinth for your server." });
      }

      downloadUrl = resolved.downloadUrl;
      filename = resolved.filename;
      installedVersion = resolved.versionNumber;
    } else if (currentSource === 'spigot') {
      const axios = (await import("axios")).default;
      const apiRes = await axios.get(`https://api.spiget.org/v2/resources/${pluginId}`);
      if (apiRes.data && apiRes.data.file) {
        downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/download`;
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({ error: "Could not find a valid download URL for this plugin." });
    }

    const installedFile = await downloadFileSafely(downloadUrl, pluginsDir, filename);

    res.json({
      success: true,
      message: `${pluginName || installedFile} (Version: ${installedVersion || 'Latest'}) installed successfully into plugins/! Restart your server to load it.`,
      filename: installedFile,
      version: installedVersion
    });
  } catch (error: any) {
    console.error("Plugin installation failed:", error.message);
    res.status(500).json({ error: "Plugin installation failed: " + error.message });
  }
};

export const getInstalledPlugins = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const pluginsDir = path.join(process.cwd(), ".data", "servers", id, "plugins");

  try {
    await fs.ensureDir(pluginsDir);
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    const plugins = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jar")) {
        const stat = await fs.stat(path.join(pluginsDir, entry.name)).catch(() => null);
        plugins.push({
          filename: entry.name,
          size: stat?.size || 0,
          modified: stat?.mtimeMs || 0
        });
      }
    }

    plugins.sort((a, b) => b.modified - a.modified);
    res.json({ plugins });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteInstalledPlugin = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id, filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(process.cwd(), ".data", "servers", id, "plugins", safeFilename);

  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
      return res.json({ success: true, message: `Uninstalled ${safeFilename}` });
    }
    res.status(404).json({ error: "Plugin file not found" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const installMod = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const serversJSON = await readJSON("servers.json");
  const server = serversJSON?.find((s: any) => s.id === id);
  if (!server) return res.status(404).json({ error: "Server not found" });
  if (user && user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const serverType = (server.type || "").toUpperCase();

  // Explicitly check for Proxy software and reject
  const isProxy = ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(serverType);
  if (isProxy) {
    return res.status(400).json({
      error: "Mod Manager is disabled for proxy servers (Velocity, BungeeCord, Waterfall)."
    });
  }

  const modCompatibleTypes = ["FABRIC", "FORGE", "NEOFORGE", "QUILT"];
  if (!modCompatibleTypes.includes(serverType)) {
    return res.status(400).json({
      error: `Cannot install Fabric/Forge mods on a ${server.type} server. This software does not support mods.`
    });
  }

  const { pluginId, pluginName, versionId, fileUrl, fileName } = req.body;

  if (!pluginId) {
    return res.status(400).json({ error: "Missing pluginId (mod ID)" });
  }

  try {
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    const modsDir = path.join(serverDir, "mods");

    const resolved = await resolveModrinthVersionAndFile(
      pluginId,
      server.type,
      server.version,
      versionId,
      fileUrl,
      fileName
    );

    if (!resolved || !resolved.downloadUrl) {
      return res.status(404).json({ error: "Could not find a compatible mod version on Modrinth for your server." });
    }

    const filename = resolved.filename || `${(pluginName || pluginId).replace(/[^a-zA-Z0-9]/g, '_')}.jar`;
    const installedFile = await downloadFileSafely(resolved.downloadUrl, modsDir, filename);

    res.json({
      success: true,
      message: `${pluginName || installedFile} (Version: ${resolved.versionNumber || 'Latest'}) installed successfully into mods/! Restart your server to load it.`,
      filename: installedFile,
      version: resolved.versionNumber
    });
  } catch (error: any) {
    console.error("Mod installation failed:", error.message);
    res.status(500).json({ error: "Mod installation failed: " + error.message });
  }
};

export const getInstalledMods = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id } = req.params;
  const modsDir = path.join(process.cwd(), ".data", "servers", id, "mods");

  try {
    await fs.ensureDir(modsDir);
    const entries = await fs.readdir(modsDir, { withFileTypes: true });
    const mods = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jar")) {
        const stat = await fs.stat(path.join(modsDir, entry.name)).catch(() => null);
        mods.push({
          filename: entry.name,
          size: stat?.size || 0,
          modified: stat?.mtimeMs || 0
        });
      }
    }

    mods.sort((a, b) => b.modified - a.modified);
    res.json({ mods });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteInstalledMod = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id, filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(process.cwd(), ".data", "servers", id, "mods", safeFilename);

  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
      return res.json({ success: true, message: `Uninstalled ${safeFilename}` });
    }
    res.status(404).json({ error: "Mod file not found" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const getModrinthProjectVersions = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { projectId } = req.params;
  const axios = (await import("axios")).default;

  try {
    const resp = await axios.get(`https://api.modrinth.com/v2/project/${projectId}/version`, {
      headers: { "User-Agent": "JTG-Panel/1.0" },
      timeout: 15000
    });
    res.json(resp.data);
  } catch (err: any) {
    res.status(err.response?.status || 500).json({ error: err.message || "Failed to fetch Modrinth versions" });
  }
};

export const updateResources = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { ram, cpu, disk } = req.body;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if ((req as any).user.role !== "admin" && (req as any).user.role !== "owner") return res.status(403).json({ error: "Unauthorized" });

    server.ram = Number(ram);
    server.cpu = Number(cpu);
    server.disk = Number(disk);
    await writeJSON("servers.json", servers);

    // Stop container if running
    if (server.containerId) {
       try {
         await stopServerRuntime(server);
       } catch(e) {}
    }

    res.json(server);
  } catch (error) {
    res.status(500).json({ error: "Failed to update resources" });
  }
};

export const updateSuspend = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { suspendDuration } = req.body; // permanent, 1_month, 2_months, 24_hours, 1_week, or null
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if ((req as any).user.role !== "admin" && (req as any).user.role !== "owner") return res.status(403).json({ error: "Unauthorized" });

    server.suspended = suspendDuration !== null;
    server.suspendDuration = suspendDuration;
    await writeJSON("servers.json", servers);

    if (server.suspended && server.containerId) {
       try {
         await stopServerRuntime(server);
       } catch(e) {}
    }

    res.json(server);
  } catch (error) {
    res.status(500).json({ error: "Failed to suspend server" });
  }
};






export const updateRuntime = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { version, type, javaVersion, dockerImage, serverJar, startupCommand } = req.body;
    const user = (req as any).user;

    let servers = await readJSON("servers.json") || [];
    const serverIndex = servers.findIndex((s: any) => s.id === id);
    if (serverIndex === -1) return res.status(404).json({ error: "Server not found" });
    const server = servers[serverIndex];

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Only admins or owners can change runtime settings" });
    }

    if (server.containerId) {
      const status = await getServerRuntimeStatus(server);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Server must be stopped before changing runtime. Please stop the server first." });
      }
    }
    
    // We must do a full backup before changing this if requested, but for now we just save it.
    // The instructions say "When an administrator changes the Minecraft version: 1. Stop the server safely... 3. Create a complete backup."
    // Let's call the internal backup logic.
    const backupDir = path.join(process.cwd(), ".data", "backups", id);
    await fs.ensureDir(backupDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(backupDir, `pre_runtime_update_${timestamp}.zip`);
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    

    if (await fs.pathExists(serverDir)) {
      const archiver = require("archiver");
      const output = fs.createWriteStream(backupFile);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.pipe(output);
      archive.directory(serverDir, false);
      
      const serversJSON = await readJSON("servers.json");
      archive.append(JSON.stringify(serversJSON.find((s: any) => s.id === id), null, 2), { name: "server_config_snapshot.json" });
      
      await archive.finalize();
    }


    server.version = version || server.version;
    server.type = type || server.type;
    server.javaVersion = javaVersion !== undefined ? javaVersion : server.javaVersion;
    server.dockerImage = dockerImage !== undefined ? dockerImage : server.dockerImage;
    server.serverJar = serverJar !== undefined ? serverJar : server.serverJar;
    server.startupCommand = startupCommand !== undefined ? startupCommand : server.startupCommand;

    servers[serverIndex] = server;
    
    if (server.containerId) {
       await deleteServerRuntime(server);
    }
    
    const newContainerId = await createServerRuntime(server);
    server.containerId = newContainerId;
    servers[serverIndex] = server;

    await writeJSON("servers.json", servers);

    res.json({ success: true, server });
  } catch (err: any) {
    console.error("Update runtime error", err);
    res.status(500).json({ error: err.message });
  }
};

export const migrateServerRuntime = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { targetRuntime } = req.body;
  const user = (req as any).user;

  try {
    const isDevPanel = (process.env.PANEL_TYPE === "dev" || process.env.PORT === "3000") && !process.env.FORCE_MAIN_PANEL;
    if (!isDevPanel) {
      return res.status(403).json({ 
        error: "Runtime migration is disabled on the Main Panel (Port 6767). Server runtime is locked to your installation configuration. Use the Developer Panel (Port 3000) or reinstall." 
      });
    }

    if (!targetRuntime || (targetRuntime !== "docker" && targetRuntime !== "local")) {
      return res.status(400).json({ error: "Invalid target runtime. Must be 'docker' or 'local'." });
    }

    const servers = await readJSON("servers.json") || [];
    const serverIndex = servers.findIndex((s: any) => s.id === id);
    if (serverIndex === -1) {
      return res.status(404).json({ error: "Server not found" });
    }

    const server = servers[serverIndex];
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Only admins or owners can migrate runtime" });
    }

    // Check if server is running
    if (server.containerId) {
      const status = await getServerRuntimeStatus(server);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Server must be stopped before migrating runtime. Please stop the server first." });
      }
      // Clean up old runtime instance (container or local process state)
      await deleteServerRuntime(server);
    }

    // Update runtime type
    server.runtimeType = targetRuntime;

    // Create the new runtime container/process metadata
    const newContainerId = await createServerRuntime(server);
    server.containerId = newContainerId;
    servers[serverIndex] = server;

    await writeJSON("servers.json", servers);
    res.json({ success: true, server, runtimeType: targetRuntime });
  } catch (err: any) {
    console.error("Migrate runtime error:", err);
    res.status(500).json({ error: err.message || "Failed to migrate server runtime" });
  }
};



export const restoreBackup = async (req: Request, res: Response) => {
  if (!(await checkServerFileAccess(req, res))) return;
  const { id, filename } = req.params;
  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  const backupsDir = path.join(process.cwd(), ".data", "backups", id);
  const backupPath = path.join(backupsDir, filename);

  try {
    if (!(await fs.pathExists(backupPath))) {
      return res.status(404).json({ error: "Backup not found" });
    }

    const status = await getServerRuntimeStatus({ id } as any);
    if (status?.State?.Running) {
      return res.status(400).json({ error: "Please stop the server before restoring a backup." });
    }

    // Clean current directory except some critical things if needed, but for full restore, we empty it
    await fs.emptyDir(serverDir);

    const extract = require("extract-zip");
    await extract(backupPath, { dir: serverDir });
    
    // Check if there was a server_config_snapshot.json and apply it
    const configSnapshot = path.join(serverDir, "server_config_snapshot.json");
    if (fs.existsSync(configSnapshot)) {
        const oldConfig = await readJSON(configSnapshot);
        const servers = await readJSON("servers.json");
        const idx = servers.findIndex((s: any) => s.id === id);
        if (idx !== -1) {
            servers[idx] = { ...servers[idx], ...oldConfig };
            await writeJSON("servers.json", servers);
        }
        await fs.remove(configSnapshot);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
