import { Router, Request } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { readJSON, writeJSON } from "../services/db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getWingsDaemonSource } from "../services/wingsArtifact.js";
import { buildWingsInstallScript } from "../services/wingsInstallScript.js";
import { rateLimit, secretsMatch } from "../utils/rateLimit.js";

const router = Router();

// These are amplification guards, not credential-guessing limits. A
// registration token is 40 hex characters (160 bits), so it cannot be brute
// forced at any rate reachable here; what these endpoints actually need is a cap
// on unauthenticated database work. The values are therefore set well above any
// real operator (who provisions a handful of nodes and may sit behind NAT, so
// many legitimate registrations share one address) while still stopping a
// runaway client from pinning the panel with write amplification.
const registerLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  message: "Too many registration attempts. Wait a moment and retry.",
});

// Default heartbeat is every 15s, but heartbeat_interval is operator-configurable
// down to a second, and several nodes can legitimately share one address.
const heartbeatLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  message: "Heartbeat rate exceeded for this address.",
});

async function getNodesList() {
  const nodes = await readJSON("nodes.json");
  if (nodes && Array.isArray(nodes)) return nodes;
  const wingsNodes = await readJSON("wings_nodes.json");
  if (wingsNodes && Array.isArray(wingsNodes)) return wingsNodes;
  return [];
}

async function saveNodesList(nodes: any[]) {
  await writeJSON("nodes.json", nodes);
  await writeJSON("wings_nodes.json", nodes);
}

const DEFAULT_OFFLINE_THRESHOLD = 90000;

/**
 * A node is only ONLINE while heartbeats keep arriving. A stale stored status is
 * never trusted: an expired heartbeat always downgrades the node so the panel can
 * never report a dead daemon as online.
 */
function withComputedStatus(node: any, now = Date.now()): any {
  const threshold = Number(node.offlineThreshold) || DEFAULT_OFFLINE_THRESHOLD;
  if (node.lastHeartbeat) {
    const diff = now - new Date(node.lastHeartbeat).getTime();
    if (diff > threshold && node.status === "online") {
      return {
        ...node,
        status: "offline",
        statusDetail: `No heartbeat for ${Math.round(diff / 1000)}s (threshold ${Math.round(threshold / 1000)}s)`,
      };
    }
    return node;
  }
  // No heartbeat ever arrived. The two cases mean very different things to an
  // operator: a node without an api_secret has not been installed yet, while a
  // node that already has one but never checked in is broken (wrong secret,
  // wrong panel_url, or the panel is unreachable from the daemon).
  if (node.apiSecret) {
    return {
      ...node,
      status: "error",
      statusDetail: node.statusDetail || "Installed but has never reached the panel",
    };
  }
  if (node.status === "online") {
    return { ...node, status: "installing" };
  }
  return node;
}

function stripSecrets(node: any): any {
  const { apiSecret, token, registrationToken, registrationTokenExpires, ...safe } = node;
  return safe;
}

/**
 * Resolve the public base URL of this panel.
 *
 * Order of preference:
 *   1. PANEL_URL - explicit operator configuration. This is the only fully
 *      trustworthy source behind a reverse proxy, because Host and
 *      X-Forwarded-* are attacker-controllable unless a proxy is known to
 *      sanitise them. Reflecting them into a `curl | bash` one-liner is a
 *      copy-paste RCE lure.
 *   2. X-Forwarded-Host / Host, with the scheme from req.secure or
 *      X-Forwarded-Proto. Correct when the panel is reached directly or through a
 *      tunnel that forwards the public hostname.
 *
 * Set PANEL_URL_REQUIRED=true to refuse the header fallback entirely. Operators
 * who terminate TLS or sit behind a proxy should do this: it removes the
 * attacker-controlled input from a URL that ends up in a `curl | bash` command.
 *
 * Only http/https origins are ever returned.
 */
function resolvePanelUrl(req: Request): string {
  const configured = (process.env.PANEL_URL || "").trim().replace(/\/+$/, "");
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch {
      console.warn(`[JTG] Ignoring invalid PANEL_URL: ${configured}`);
    }
  }

  if (String(process.env.PANEL_URL_REQUIRED).toLowerCase() === "true") {
    throw new Error(
      "PANEL_URL is required (PANEL_URL_REQUIRED=true) but is unset or invalid. " +
        "Set PANEL_URL to this panel's public origin, e.g. https://panel.example.com."
    );
  }

  console.warn(
    "[JTG] PANEL_URL is not set; deriving the installer URL from the request headers. " +
      "Set PANEL_URL (and optionally PANEL_URL_REQUIRED=true) to pin it."
  );

  // X-Forwarded-* may be a comma separated list; the first entry is the original.
  const firstHeader = (value: any): string => {
    const raw = Array.isArray(value) ? value[0] : value;
    return String(raw || "").split(",")[0].trim();
  };

  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeader(req.headers.host) || "localhost:6767";
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]).toLowerCase();
  const protocol = req.secure || forwardedProto === "https" ? "https" : "http";

  try {
    const parsed = new URL(`${protocol}://${host}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `http://localhost:${process.env.PORT || 6767}`;
    }
    return parsed.origin;
  } catch {
    return `http://localhost:${process.env.PORT || 6767}`;
  }
}

router.get("/daemon.js", async (_req, res) => {
  try {
    const { content } = await getWingsDaemonSource();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(content);
  } catch (err: any) {
    res.status(500).send(`# failed to load wings daemon: ${err.message}\n`);
  }
});

router.get("/install", async (req, res) => {
  try {
    const panelUrl = resolvePanelUrl(req);
    const script = await buildWingsInstallScript({ panelUrl });
    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(script);
  } catch (err: any) {
    console.error("Failed to build wings install script:", err);
    res.status(500).send(`#!/bin/bash\necho "panel error: ${err.message}" >&2\nexit 1\n`);
  }
});

router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { registrationToken } = req.body;
    if (!registrationToken) {
      return res.status(400).json({ error: "Registration token is required" });
    }

    const nodes = await getNodesList();
    // Never compare the token with === : it is a bearer credential, and a
    // timing side channel here leaks it a byte at a time.
    const nodeIndex = nodes.findIndex(
      (n: any) =>
        secretsMatch(n.registrationToken, registrationToken) &&
        (!n.registrationTokenExpires || new Date(n.registrationTokenExpires) > new Date())
    );

    if (nodeIndex === -1) {
      return res.status(401).json({ error: "Invalid or expired registration token" });
    }

    const node = nodes[nodeIndex];
    const apiSecret = "jtg_ws_" + crypto.randomBytes(24).toString("hex");
    const wingsPort = node.wingsPort || node.apiPort || 8080;
    const protocol = node.protocol || (node.ssl ? "https" : "http");
    const allocations = Array.isArray(node.allocations) ? node.allocations : [];

    nodes[nodeIndex].registrationToken = null;
    nodes[nodeIndex].registrationTokenExpires = null;
    nodes[nodeIndex].apiSecret = apiSecret;
    nodes[nodeIndex].registeredAt = new Date().toISOString();
    nodes[nodeIndex].status = "installing";
    nodes[nodeIndex].lastHeartbeat = null;
    nodes[nodeIndex].instanceId = null;

    await saveNodesList(nodes);

    const nodeConfigYaml = [
      `bind_address: "0.0.0.0"`,
      `heartbeat_interval: ${node.heartbeatInterval || 15000}`,
      `offline_threshold: ${node.offlineThreshold || 90000}`,
      `runtime_backend: "${node.runtimeBackend || "docker"}"`,
      `server_memory: ${node.memory || 1024}`,
      `default_image: "${node.defaultImage || ""}"`,
      `default_invocation: ${node.defaultInvocation ? JSON.stringify(String(node.defaultInvocation)) : '""'}`,
      `tls_cert: "${node.tlsCert || ""}"`,
      `tls_key: "${node.tlsKey || ""}"`,
      `allocations: '${JSON.stringify(
        allocations.map((a: any) => ({ id: a.id, ip: a.ip, port: Number(a.port) }))
      )}'`,
    ].join("\n");

    return res.json({
      success: true,
      nodeId: node.id,
      uuid: node.uuid || node.id,
      name: node.name,
      apiSecret: apiSecret,
      wingsPort,
      protocol,
      allocations,
      nodeConfigYaml
    });
  } catch (err: any) {
    console.error("Error registering Wings node:", err);
    res.status(500).json({ error: "Registration failed: " + err.message });
  }
});

router.post("/heartbeat", heartbeatLimiter, async (req: Request, res) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const { nodeId, apiSecret, version, cpu, memory, disk, uptime, instanceId, systems, resources } = req.body;

    // The credential must travel in the Authorization header. Accepting it from
    // the JSON body let it land in request logs, proxies and any body-capture
    // middleware between the daemon and the panel. The body copy is still read
    // so it can be actively rejected instead of silently ignored.
    if (apiSecret) {
      return res.status(401).json({
        error: "Unauthorized: send api_secret in the Authorization header, not the request body",
      });
    }
    const secret = bearerToken;
    if (!secret || !nodeId) {
      return res.status(401).json({ error: "Unauthorized: Missing authentication" });
    }

    const nodes = await getNodesList();
    const nodeIndex = nodes.findIndex((n: any) => n.id === nodeId && secretsMatch(n.apiSecret, secret));

    if (nodeIndex === -1) {
      return res.status(401).json({ error: "Unauthorized: Invalid node credentials" });
    }

    nodes[nodeIndex].status = "online";
    nodes[nodeIndex].lastHeartbeat = new Date().toISOString();
    if (version) nodes[nodeIndex].wingsVersion = version;
    if (instanceId) {
      const previous = nodes[nodeIndex].instanceId || null;
      nodes[nodeIndex].instanceId = instanceId;
      if (previous && previous !== instanceId) {
        console.warn(`[wings] node ${nodes[nodeIndex].name} (${nodeId}) was restarted with a new daemon instance`);
      }
    }
    if (cpu !== undefined) {
      nodes[nodeIndex].stats = { cpu, memory, disk, uptime, systems, resources };
    }

    await saveNodesList(nodes);

    res.json({ success: true, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ error: "Heartbeat failed" });
  }
});


router.get("/", requireAuth, async (req, res) => {
  try {
    const nodes = await getNodesList();
    res.json(nodes.map((n: any) => stripSecrets(withComputedStatus(n))));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load nodes" });
  }
});

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
      allocations,
      runtimeBackend,
      defaultImage,
      defaultInvocation,
      heartbeatInterval,
      offlineThreshold,
      tlsCert,
      tlsKey
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Node name is required" });
    }

    const resolvedPort = Number(wingsPort || apiPort || 8080);
    if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
      return res.status(400).json({ error: "Wings port must be a valid TCP port (1-65535)" });
    }

    const resolvedProtocol = protocol || (ssl ? "https" : "http");
    if (!["http", "https"].includes(resolvedProtocol)) {
      return res.status(400).json({ error: "Protocol must be http or https" });
    }

    if (runtimeBackend && !["docker", "process"].includes(runtimeBackend)) {
      return res.status(400).json({ error: "runtimeBackend must be docker or process" });
    }

    const id = uuidv4();
    const nodeUuid = uuidv4();
    const regToken = "jtg_reg_" + crypto.randomBytes(20).toString("hex");
    const regExpires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const resolvedIpV4 = publicIpV4 || "127.0.0.1";
    const normalizedAllocations = (Array.isArray(allocations) && allocations.length ? allocations : [
      { ip: resolvedIpV4, port: 25565 }
    ]).map((a: any) => ({
      id: a.id || uuidv4(),
      ip: a.ip || resolvedIpV4,
      port: Number(a.port),
      assigned: false,
      server: null
    }));

    for (const alloc of normalizedAllocations) {
      if (!Number.isInteger(alloc.port) || alloc.port < 1 || alloc.port > 65535) {
        return res.status(400).json({ error: `Invalid allocation port: ${alloc.port}` });
      }
    }
    const seen = new Set<string>();
    for (const alloc of normalizedAllocations) {
      const key = `${alloc.ip}:${alloc.port}`;
      if (seen.has(key)) {
        return res.status(400).json({ error: `Duplicate allocation on this node: ${key}` });
      }
      seen.add(key);
    }

    const newNode = {
      id,
      uuid: nodeUuid,
      name,
      description: description || "",
      fqdn: fqdn || hostname || "node.example.com",
      hostname: hostname || fqdn || "node.example.com",
      publicIpV4: resolvedIpV4,
      publicIpV6: publicIpV6 || "",
      wingsPort: resolvedPort,
      apiPort: resolvedPort,
      protocol: resolvedProtocol,
      ssl: !!ssl,
      location: location || "Default",
      memory: memory || 8192,
      disk: disk || 50000,
      cpuLimit: cpuLimit || 100,
      runtimeBackend: runtimeBackend || "docker",
      defaultImage: defaultImage || "",
      defaultInvocation: defaultInvocation || "",
      heartbeatInterval: Number(heartbeatInterval) || 15000,
      offlineThreshold: Number(offlineThreshold) || 90000,
      tlsCert: tlsCert || "",
      tlsKey: tlsKey || "",
      status: "installing",
      registrationToken: regToken,
      registrationTokenExpires: regExpires,
      apiSecret: null,
      allocations: normalizedAllocations,
      createdAt: new Date().toISOString(),
      registeredAt: null,
      lastHeartbeat: null,
      instanceId: null,
      wingsVersion: null
    };

    const nodes = await getNodesList();
    nodes.push(newNode);
    await saveNodesList(nodes);

    const { apiSecret, registrationToken, ...safeNode } = newNode;
    res.json({
      success: true,
      node: safeNode,
      registrationToken: regToken
    });
  } catch (err: any) {
    console.error("Error creating node:", err);
    res.status(500).json({ error: "Failed to create node" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const node = nodes.find((n: any) => n.id === id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    res.json(stripSecrets(withComputedStatus(node)));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch node" });
  }
});

router.get("/:id/configuration", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const node = nodes.find((n: any) => n.id === id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const panelUrl = resolvePanelUrl(req);

    let regToken = node.registrationToken;
    if (!regToken || (node.registrationTokenExpires && new Date(node.registrationTokenExpires) < new Date())) {
      regToken = "jtg_reg_" + crypto.randomBytes(20).toString("hex");
      node.registrationToken = regToken;
      node.registrationTokenExpires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await saveNodesList(nodes);
    }

    const installCommand = `curl -fsSL ${panelUrl}/api/wings/install | bash -s -- ${regToken}`;
    const localTestCommand = `curl -fsSL ${panelUrl}/api/wings/install | bash -s -- ${regToken} --local-test`;

    res.json({
      nodeId: node.id,
      uuid: node.uuid,
      panelUrl,
      registrationToken: regToken,
      registrationTokenExpires: node.registrationTokenExpires,
      installCommand,
      localTestCommand,
      wingsEndpoint: `${node.protocol || (node.ssl ? "https" : "http")}://${node.fqdn || node.hostname || node.publicIpV4}:${node.wingsPort || node.apiPort || 8080}`,
      hasApiSecret: !!node.apiSecret
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch configuration" });
  }
});

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

router.post("/:id/revoke", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const nodeIndex = nodes.findIndex((n: any) => n.id === id);
    if (nodeIndex === -1) return res.status(404).json({ error: "Node not found" });

    nodes[nodeIndex].apiSecret = null;
    nodes[nodeIndex].registrationToken = null;
    nodes[nodeIndex].registrationTokenExpires = null;
    nodes[nodeIndex].instanceId = null;
    nodes[nodeIndex].status = "offline";

    await saveNodesList(nodes);

    res.json({ success: true, message: "Node credentials revoked" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to revoke node credentials" });
  }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const nodes = await getNodesList();
    const filtered = nodes.filter((n: any) => n.id !== id);

    if (nodes.length === filtered.length) {
      return res.status(404).json({ error: "Node not found" });
    }

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
