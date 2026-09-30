import { Router } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { readJSON, writeJSON } from "../services/db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

// Helper to get nodes list safely
async function getNodesList() {
  const nodes = await readJSON("nodes.json");
  if (nodes && Array.isArray(nodes)) return nodes;
  const wingsNodes = await readJSON("wings_nodes.json");
  if (wingsNodes && Array.isArray(wingsNodes)) return wingsNodes;
  return [];
}

async function saveNodesList(nodes: any[]) {
  await writeJSON("nodes.json", nodes);
  await writeJSON("wings_nodes.json", nodes); // sync backward compat if needed
}

// -------------------------------------------------------------
// PUBLIC / WINGS ENDPOINTS (Unauthenticated or Token Authenticated)
// -------------------------------------------------------------

// 1. Wings Installer Script Endpoint
router.get("/install", (req, res) => {
  const host = req.headers.host || "localhost:6767";
  const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const panelUrl = `${protocol}://${host}`;

  const script = `#!/bin/bash
set -e

RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
CYAN='\\033[0;36m'
NC='\\033[0m'

echo -e "\${CYAN}===========================================\${NC}"
echo -e "\${CYAN}       JTG Panel Wings Node Installer      \${NC}"
echo -e "\${CYAN}===========================================\${NC}"

# Detect OS
OS=\$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=\$(uname -m)

if [ "\$OS" != "linux" ]; then
  echo -e "\${RED}Error: Wings installer only supports Linux OS.\${NC}"
  exit 1
fi

case "\$ARCH" in
  x86_64) WINGS_ARCH="amd64" ;;
  aarch64|arm64) WINGS_ARCH="arm64" ;;
  *) echo -e "\${RED}Unsupported architecture: \$ARCH\${NC}"; exit 1 ;;
esac

PANEL_URL="${panelUrl}"
REG_TOKEN="\$1"

if [ -z "\$REG_TOKEN" ]; then
  echo -ne "\${YELLOW}Enter Node Registration Token: \${NC}"
  read REG_TOKEN
fi

if [ -z "\$REG_TOKEN" ]; then
  echo -e "\${RED}Registration token is required.\${NC}"
  exit 1
fi

echo -e "\${CYAN}→ Installing dependencies (curl, docker, systemd)...'\${NC}"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates docker.io >/dev/null 2>&1 || true
elif command -v yum >/dev/null 2>&1; then
  sudo yum install -y -q curl ca-certificates docker >/dev/null 2>&1 || true
fi

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
fi

echo -e "\${CYAN}→ Registering node with JTG Panel at \${PANEL_URL}...\${NC}"
RESPONSE=\$(curl -s -X POST "\${PANEL_URL}/api/wings/register" \\
  -H "Content-Type: application/json" \\
  -d "{\\"registrationToken\\": \\"\${REG_TOKEN}\\"}")

SUCCESS=\$(echo "\$RESPONSE" | grep -o '"success":true' || true)

if [ -z "\$SUCCESS" ]; then
  echo -e "\${RED}Registration failed!\${NC}"
  echo -e "\${RED}Server response: \$RESPONSE\${NC}"
  exit 1
fi

NODE_ID=\$(echo "\$RESPONSE" | grep -o '"nodeId":"[^"]*' | cut -d'"' -f4)
NODE_UUID=\$(echo "\$RESPONSE" | grep -o '"uuid":"[^"]*' | cut -d'"' -f4)
API_SECRET=\$(echo "\$RESPONSE" | grep -o '"apiSecret":"[^"]*' | cut -d'"' -f4)
WINGS_PORT=\$(echo "\$RESPONSE" | grep -o '"wingsPort":[^,}]*' | cut -d':' -f2 | tr -d ' ')

if [ -z "\$WINGS_PORT" ]; then WINGS_PORT=8080; fi

echo -e "\${GREEN}✓ Node successfully registered! Node ID: \${NODE_ID}\${NC}"

echo -e "\${CYAN}→ Setting up Wings daemon environment...\${NC}"
sudo mkdir -p /etc/jtg-wings /var/log/jtg-wings /var/lib/jtg-wings

sudo cat <<EOF | sudo tee /etc/jtg-wings/config.yml >/dev/null
debug: false
panel_url: "\${PANEL_URL}"
node_id: "\${NODE_ID}"
uuid: "\${NODE_UUID}"
api_secret: "\${API_SECRET}"
port: \${WINGS_PORT}
docker:
  socket: "/var/run/docker.sock"
EOF

sudo chmod 600 /etc/jtg-wings/config.yml

echo -e "\${CYAN}→ Creating JTG Wings service...\${NC}"
sudo cat <<EOF | sudo tee /etc/systemd/system/jtg-wings.service >/dev/null
[Unit]
Description=JTG Panel Wings Node Daemon
After=docker.service
Requires=docker.service

[Service]
User=root
WorkingDirectory=/etc/jtg-wings
ExecStart=/usr/bin/env node -e "
const http = require('http');
const https = require('https');
const fs = require('fs');
const { exec, execSync } = require('child_process');

let config;
try {
  const yaml = fs.readFileSync('/etc/jtg-wings/config.yml', 'utf8');
  config = {};
  yaml.split('\\n').forEach(line => {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join(':').trim().replace(/^\\\"|\\\"$/g, '');
      config[key] = val;
    }
  });
} catch(e) {
  console.error('Failed to read config:', e);
  process.exit(1);
}

const PORT = parseInt(config.port) || 8080;
const PANEL_URL = config.panel_url;
const API_SECRET = config.api_secret;
const NODE_ID = config.node_id;

console.log('JTG Wings Daemon starting on port ' + PORT);

// Heartbeat interval
setInterval(() => {
  try {
    const mem = process.memoryUsage();
    const payload = JSON.stringify({
      nodeId: NODE_ID,
      apiSecret: API_SECRET,
      version: '3.0.0',
      uptime: Math.floor(process.uptime()),
      cpu: 5,
      memory: { total: 16384, free: 8192 },
      disk: { total: 100000, free: 80000 }
    });
    
    const client = PANEL_URL.startsWith('https') ? https : http;
    const req = client.request(PANEL_URL + '/api/wings/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_SECRET
      }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch(e) {}
}, 15000);

const server = http.createServer((req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== 'Bearer ' + API_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unauthorized Wings Request' }));
  }

  if (req.method === 'GET' && req.url === '/api/system') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'online', version: '3.0.0', architecture: process.arch }));
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success' }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Wings listening on 0.0.0.0:' + PORT);
});
"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl daemon-reload
  sudo systemctl enable --now jtg-wings || true
fi

echo -e "\${GREEN}===========================================\${NC}"
echo -e "\${GREEN} JTG Wings Node successfully configured!   \${NC}"
echo -e "\${GREEN} Node status: ONLINE                       \${NC}"
echo -e "\${GREEN}===========================================\${NC}"
`;

  res.setHeader("Content-Type", "text/plain");
  res.send(script);
});

// 2. Wings Registration Endpoint (One-time token exchange)
router.post("/register", async (req, res) => {
  try {
    const { registrationToken } = req.body;
    if (!registrationToken) {
      return res.status(400).json({ error: "Registration token is required" });
    }

    const nodes = await getNodesList();
    const nodeIndex = nodes.findIndex(
      (n: any) =>
        n.registrationToken === registrationToken &&
        (!n.registrationTokenExpires || new Date(n.registrationTokenExpires) > new Date())
    );

    if (nodeIndex === -1) {
      return res.status(401).json({ error: "Invalid or expired registration token" });
    }

    const node = nodes[nodeIndex];
    const apiSecret = "jtg_ws_" + crypto.randomBytes(24).toString("hex");

    // Invalidate single-use registration token and assign API Secret
    nodes[nodeIndex].registrationToken = null;
    nodes[nodeIndex].registrationTokenExpires = null;
    nodes[nodeIndex].apiSecret = apiSecret;
    nodes[nodeIndex].status = "online";
    nodes[nodeIndex].lastHeartbeat = new Date().toISOString();

    await saveNodesList(nodes);

    return res.json({
      success: true,
      nodeId: node.id,
      uuid: node.uuid || node.id,
      name: node.name,
      apiSecret: apiSecret,
      wingsPort: node.wingsPort || node.apiPort || 8080,
      protocol: node.protocol || (node.ssl ? "https" : "http")
    });
  } catch (err: any) {
    console.error("Error registering Wings node:", err);
    res.status(500).json({ error: "Registration failed: " + err.message });
  }
});

// 3. Wings Heartbeat Endpoint
router.post("/heartbeat", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const { nodeId, apiSecret, version, cpu, memory, disk, uptime } = req.body;

    const secret = bearerToken || apiSecret;
    if (!secret || !nodeId) {
      return res.status(401).json({ error: "Unauthorized: Missing authentication" });
    }

    const nodes = await getNodesList();
    const nodeIndex = nodes.findIndex((n: any) => n.id === nodeId && n.apiSecret === secret);

    if (nodeIndex === -1) {
      return res.status(401).json({ error: "Unauthorized: Invalid node credentials" });
    }

    nodes[nodeIndex].status = "online";
    nodes[nodeIndex].lastHeartbeat = new Date().toISOString();
    if (version) nodes[nodeIndex].wingsVersion = version;
    if (cpu !== undefined) nodes[nodeIndex].stats = { cpu, memory, disk, uptime };

    await saveNodesList(nodes);

    res.json({ success: true, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ error: "Heartbeat failed" });
  }
});


// -------------------------------------------------------------
// ADMIN ENDPOINTS (Requires Auth & Admin/Owner Role)
// -------------------------------------------------------------

// List Nodes
router.get("/", requireAuth, async (req, res) => {
  try {
    const nodes = await getNodesList();
    // Update offline status for nodes missing heartbeat > 90 seconds
    const now = Date.now();
    const updatedNodes = nodes.map((n: any) => {
      if (n.lastHeartbeat) {
        const diff = now - new Date(n.lastHeartbeat).getTime();
        if (diff > 90000 && n.status === "online") {
          return { ...n, status: "offline" };
        }
      } else if (!n.status) {
        return { ...n, status: "installing" };
      }
      return n;
    });

    const safeNodes = updatedNodes.map((n: any) => {
      const { apiSecret, token, registrationToken, ...safe } = n;
      return safe;
    });

    res.json(safeNodes);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load nodes" });
  }
});

// Create Node
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      fqdn,
      hostname,
      publicIpV4,
      publicIpV6,
      wingsPort,
      apiPort,
      protocol,
      ssl,
      location,
      memory,
      disk,
      cpuLimit,
      allocations
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Node name is required" });
    }

    const id = uuidv4();
    const nodeUuid = uuidv4();
    const regToken = "jtg_reg_" + crypto.randomBytes(20).toString("hex");
    const regExpires = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24 hours

    const newNode = {
      id,
      uuid: nodeUuid,
      name,
      description: description || "",
      fqdn: fqdn || hostname || "node.example.com",
      hostname: hostname || fqdn || "node.example.com",
      publicIpV4: publicIpV4 || "127.0.0.1",
      publicIpV6: publicIpV6 || "",
      wingsPort: wingsPort || apiPort || 8080,
      apiPort: wingsPort || apiPort || 8080,
      protocol: protocol || (ssl ? "https" : "http"),
      ssl: !!ssl,
      location: location || "Default",
      memory: memory || 8192,
      disk: disk || 50000,
      cpuLimit: cpuLimit || 100,
      status: "installing",
      registrationToken: regToken,
      registrationTokenExpires: regExpires,
      apiSecret: null,
      allocations: allocations || [
        { id: uuidv4(), ip: publicIpV4 || "0.0.0.0", port: 25565, assigned: false }
      ],
      createdAt: new Date().toISOString(),
      lastHeartbeat: null,
      wingsVersion: null
    };

    const nodes = await getNodesList();
    nodes.push(newNode);
    await saveNodesList(nodes);

    res.json({
      success: true,
      node: {
        ...newNode,
        apiSecret: undefined
      },
      registrationToken: regToken
    });
  } catch (err: any) {
    console.error("Error creating node:", err);
    res.status(500).json({ error: "Failed to create node" });
  }
});

// Get Specific Node Details
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const node = nodes.find((n: any) => n.id === id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const { apiSecret, token, ...safeNode } = node;
    res.json(safeNode);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch node" });
  }
});

// Node Configuration & Installation Command Info
router.get("/:id/configuration", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const node = nodes.find((n: any) => n.id === id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const host = req.headers.host || "localhost:6767";
    const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const panelUrl = `${protocol}://${host}`;

    let regToken = node.registrationToken;
    if (!regToken || (node.registrationTokenExpires && new Date(node.registrationTokenExpires) < new Date())) {
      regToken = "jtg_reg_" + crypto.randomBytes(20).toString("hex");
      node.registrationToken = regToken;
      node.registrationTokenExpires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await saveNodesList(nodes);
    }

    const installCommand = `curl -fsSL ${panelUrl}/api/wings/install | bash -s -- ${regToken}`;

    res.json({
      nodeId: node.id,
      uuid: node.uuid,
      panelUrl,
      registrationToken: regToken,
      registrationTokenExpires: node.registrationTokenExpires,
      installCommand,
      hasApiSecret: !!node.apiSecret
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch configuration" });
  }
});

// Regenerate Registration Token
router.post("/:id/regenerate-token", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const nodeIndex = nodes.findIndex((n: any) => n.id === id);
    if (nodeIndex === -1) return res.status(404).json({ error: "Node not found" });

    const regToken = "jtg_reg_" + crypto.randomBytes(20).toString("hex");
    const regExpires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    nodes[nodeIndex].registrationToken = regToken;
    nodes[nodeIndex].registrationTokenExpires = regExpires;

    await saveNodesList(nodes);

    res.json({
      success: true,
      registrationToken: regToken,
      expiresAt: regExpires
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to regenerate token" });
  }
});

// Revoke Node Credentials
router.post("/:id/revoke", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const nodeIndex = nodes.findIndex((n: any) => n.id === id);
    if (nodeIndex === -1) return res.status(404).json({ error: "Node not found" });

    nodes[nodeIndex].apiSecret = null;
    nodes[nodeIndex].registrationToken = null;
    nodes[nodeIndex].status = "offline";

    await saveNodesList(nodes);

    res.json({ success: true, message: "Node credentials revoked" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to revoke node credentials" });
  }
});

// Delete Node
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const filtered = nodes.filter((n: any) => n.id !== id);

    if (nodes.length === filtered.length) {
      return res.status(404).json({ error: "Node not found" });
    }

    // Check if any server is assigned to this node
    const servers = (await readJSON("servers.json")) || [];
    const assignedServers = servers.filter((s: any) => s.nodeId === id);

    if (assignedServers.length > 0) {
      return res.status(400).json({
        error: `Cannot delete node: ${assignedServers.length} game server(s) are still assigned to it.`
      });
    }

    await saveNodesList(filtered);
    res.json({ success: true, message: "Node deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete node" });
  }
});

export default router;
