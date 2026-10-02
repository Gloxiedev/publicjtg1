import axios from "axios";
import { GameServerRuntimeProvider } from "./runtimeProvider.js";
import { readJSON } from "./db.js";
import { getJavaVersionForMinecraft } from "../../utils/minecraftJava.js";

async function getWingsNode(nodeId: string) {
  const nodes = (await readJSON("nodes.json")) || (await readJSON("wings_nodes.json")) || [];
  return nodes.find((n: any) => n.id === nodeId);
}

export function getWingsNodeEndpoint(node: any): string {
  if (node?.apiUrl) return node.apiUrl;
  const protocol = node?.protocol || (node?.ssl ? "https" : "http");
  const host = node?.fqdn || node?.hostname || node?.publicIpV4 || "localhost";
  const port = node?.wingsPort || node?.apiPort || 8080;
  return `${protocol}://${host}:${port}`;
}

function getWingsClient(node: any) {
  const url = getWingsNodeEndpoint(node);
  const token = node.apiSecret || node.token || "";
  if (!token) {
    throw new Error(
      `Node ${node?.name || node?.id} has no API secret. Re-run the node installer or regenerate its registration token.`
    );
  }
  return axios.create({
    baseURL: url,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    timeout: 15000,
    validateStatus: (status: number) => status < 500
  });
}

class WingsRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function wingsRequest<T>(node: any, config: any, context: string): Promise<T> {
  const client = getWingsClient(node);
  try {
    const res = await client.request(config);
    if (res.status >= 400) {
      const detail = res.data?.error || res.statusText || `HTTP ${res.status}`;
      throw new WingsRequestError(`${context} failed on node ${node.name || node.id}: ${detail}`, res.status);
    }
    return res.data as T;
  } catch (err: any) {
    if (err instanceof WingsRequestError) throw err;
    if (err.response) {
      const detail = err.response.data?.error || `HTTP ${err.response.status}`;
      throw new WingsRequestError(`${context} failed on node ${node.name || node.id}: ${detail}`, err.response.status);
    }
    throw new Error(`${context} failed on node ${node.name || node.id} (${getWingsNodeEndpoint(node)}): ${err.message}`);
  }
}

async function requireNode(nodeId: string, context: string) {
  const node = await getWingsNode(nodeId);
  if (!node) throw new Error(`${context}: node ${nodeId} not found in the panel`);
  return node;
}

async function requireServerNode(serverId: string, context: string) {
  const servers = (await readJSON("servers.json")) || [];
  const server = servers.find((s: any) => s.id === serverId);
  if (!server) throw new Error(`${context}: server ${serverId} not found`);
  if (!server.nodeId) throw new Error(`${context}: server ${serverId} is not assigned to a node`);
  const node = await requireNode(server.nodeId, context);
  return { server, node };
}

export class WingsRuntimeProvider implements GameServerRuntimeProvider {
  async getNodeHealth(nodeId: string) {
    const node = await requireNode(nodeId, "Node health check");
    return wingsRequest(node, { method: "GET", url: "/api/system" }, "Node health check");
  }

  async getNodeAllocations(nodeId: string) {
    const node = await requireNode(nodeId, "Allocation list");
    const allocations = await wingsRequest<any[]>(node, { method: "GET", url: "/api/allocations" }, "Allocation list");
    return Array.isArray(allocations) ? allocations : [];
  }

  async createServer(server: any): Promise<string> {
    const node = await requireNode(server.nodeId, "Server creation");

    const allocation = await this.resolveAllocation(node, server);
    const effectiveJava = server.javaVersion || getJavaVersionForMinecraft(server.version || "26.3", server.type);
    const defaultImage = `ghcr.io/pterodactyl/yolk:java_${effectiveJava}`;

    // Node-level defaults win: an operator who sets an image/startup command on the
    // node expects every server on that node to use them.
    const image = server.dockerImage || node.defaultImage || defaultImage;
    const nodeInvocation = typeof node.defaultInvocation === "string" ? node.defaultInvocation.trim() : "";
    const invocation =
      server.startupCommand ||
      nodeInvocation ||
      "java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}";

    const payload = {
      uuid: server.id,
      meta: {
        name: server.name || "Minecraft Server",
        description: "JTG Managed Server"
      },
      suspended: false,
      environment: {
        SERVER_JARFILE: server.jarFile || "server.jar",
        SERVER_NAME: server.name || "server",
        SERVER_MEMORY: String(server.ram || 1024),
        SERVER_PORT: String(allocation.port),
        JTG_NODE_ID: String(server.nodeId || node.id || "")
      },
      invocation,
      skip_egg_scripts: true,
      build: {
        memory: server.ram || node.memory || 1024,
        eula: server.eula !== false,
        swap: 0,
        io: 500,
        cpu: server.cpu || 100,
        disk: server.disk || 10240,
        threads: null
      },
      container: {
        image
      },
      allocations: {
        default: {
          ip: allocation.ip,
          port: allocation.port
        },
        mappings: {
          [allocation.ip]: [allocation.port]
        }
      }
    };

    const created = await wingsRequest<any>(
      node,
      { method: "POST", url: "/api/servers", data: payload },
      "Server creation"
    );
    return created?.uuid || created?.server?.uuid || server.id;
  }

  private async resolveAllocation(node: any, server: any) {
    const configured = Array.isArray(node.allocations) ? node.allocations : [];
    const match = configured.find(
      (a: any) => Number(a.port) === Number(server.port) && a.ip === (server.ip || a.ip)
    );
    if (match) return { ip: match.ip, port: Number(match.port), id: match.id };

    const samePort = configured.find((a: any) => Number(a.port) === Number(server.port));
    if (samePort) return { ip: samePort.ip, port: Number(samePort.port), id: samePort.id };

    return {
      ip: server.ip || node.publicIpV4 || "0.0.0.0",
      port: Number(server.port)
    };
  }

  async deleteServer(serverId: string): Promise<void> {
    const { node } = await requireServerNode(serverId, "Server deletion");
    await wingsRequest(node, { method: "DELETE", url: `/api/servers/${serverId}` }, "Server deletion");
  }

  async startServer(serverId: string): Promise<void> {
    await this.sendPowerAction(serverId, "start");
  }

  async stopServer(serverId: string): Promise<void> {
    await this.sendPowerAction(serverId, "stop");
  }

  async restartServer(serverId: string): Promise<void> {
    await this.sendPowerAction(serverId, "restart");
  }

  async killServer(serverId: string): Promise<void> {
    await this.sendPowerAction(serverId, "kill");
  }

  async reinstallServer(serverId: string): Promise<void> {
    const { node } = await requireServerNode(serverId, "Server reinstall");
    await wingsRequest(node, { method: "POST", url: `/api/servers/${serverId}/reinstall` }, "Server reinstall");
  }

  private async sendPowerAction(serverId: string, action: string) {
    const { node } = await requireServerNode(serverId, `Server ${action}`);
    await wingsRequest(
      node,
      { method: "POST", url: `/api/servers/${serverId}/power`, data: { action } },
      `Server ${action}`
    );
  }

  async getServerStatus(serverId: string): Promise<any> {
    const { node } = await requireServerNode(serverId, "Server status");
    try {
      const data = await wingsRequest<any>(
        node,
        { method: "GET", url: `/api/servers/${serverId}` },
        "Server status"
      );
      return {
        State: {
          Running: data.state === "online",
          Status: data.state,
          StartedAt: data.started_at || null,
          Pid: data.pid ?? null
        }
      };
    } catch (err: any) {
      if (err instanceof WingsRequestError && err.status === 404) {
        return { State: { Running: false, Status: "offline", StartedAt: null } };
      }
      return { State: { Running: false, Status: "unreachable" }, error: err.message };
    }
  }

  async getServerStats(serverId: string): Promise<any> {
    const { node } = await requireServerNode(serverId, "Server stats");
    try {
      const data = await wingsRequest<any>(
        node,
        { method: "GET", url: `/api/servers/${serverId}/stats` },
        "Server stats"
      );
      const usedMb = data?.memory?.used ?? 0;
      const usedBytes = data?.memory?.used_bytes ?? Math.round(usedMb * 1048576);
      return {
        cpu: data?.cpu ?? 0,
        ram: usedMb,
        ramBytes: usedBytes,
        disk: data?.disk?.used ?? 0,
        state: data?.state,
        startedAt: data?.started_at || null
      };
    } catch (err: any) {
      return { cpu: 0, ram: 0, ramBytes: 0, disk: 0, error: err.message };
    }
  }

  async getConsoleLogs(serverId: string): Promise<string> {
    const { node } = await requireServerNode(serverId, "Console logs");
    try {
      const data = await wingsRequest<any>(
        node,
        { method: "GET", url: `/api/servers/${serverId}/logs?lines=200` },
        "Console logs"
      );
      return typeof data?.logs === "string" ? data.logs : "";
    } catch (err: any) {
      return `[wings] could not read console logs from node ${node.name || node.id}: ${err.message}`;
    }
  }

  async subscribeToConsole(serverId: string, onData: (data: string) => void): Promise<() => void> {
    let cancelled = false;
    let lastLength = 0;

    const poll = async () => {
      while (!cancelled) {
        try {
          const logs = await this.getConsoleLogs(serverId);
          if (logs.length > lastLength) {
            onData(logs.slice(lastLength));
            lastLength = logs.length;
          } else if (logs.length < lastLength) {
            lastLength = 0;
          }
        } catch {
          // node unreachable; the next tick retries
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }

  async sendConsoleCommand(serverId: string, command: string): Promise<void> {
    const { node } = await requireServerNode(serverId, "Console command");
    await wingsRequest(
      node,
      { method: "POST", url: `/api/servers/${serverId}/commands`, data: { command } },
      "Console command"
    );
  }

  async listFiles(serverId: string, dir: string): Promise<any[]> {
    const { node } = await requireServerNode(serverId, "File listing");
    const data = await wingsRequest<any>(
      node,
      { method: "GET", url: `/api/servers/${serverId}/files?dir=${encodeURIComponent(dir || "/")}` },
      "File listing"
    );
    return Array.isArray(data) ? data : data?.files || [];
  }

  async uploadFile(serverId: string, dir: string, file: any): Promise<void> {
    const { node } = await requireServerNode(serverId, "File upload");
    await wingsRequest(
      node,
      {
        method: "POST",
        url: `/api/servers/${serverId}/files?dir=${encodeURIComponent(dir || "/")}`,
        data: file,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      },
      "File upload"
    );
  }

  async downloadFile(serverId: string, filePath: string): Promise<any> {
    const { node } = await requireServerNode(serverId, "File download");
    return wingsRequest(
      node,
      { method: "GET", url: `/api/servers/${serverId}/files/download?file=${encodeURIComponent(filePath)}`, responseType: "arraybuffer" },
      "File download"
    );
  }

  async extractArchive(serverId: string, archivePath: string, destDir: string): Promise<void> {
    const { node } = await requireServerNode(serverId, "Archive extraction");
    await wingsRequest(
      node,
      { method: "POST", url: `/api/servers/${serverId}/files/extract`, data: { archive: archivePath, destination: destDir } },
      "Archive extraction"
    );
  }

  async createBackup(serverId: string): Promise<any> {
    const { node } = await requireServerNode(serverId, "Backup creation");
    return wingsRequest(node, { method: "POST", url: `/api/servers/${serverId}/backups` }, "Backup creation");
  }

  async restoreBackup(serverId: string, backupId: string): Promise<void> {
    const { node } = await requireServerNode(serverId, "Backup restore");
    await wingsRequest(
      node,
      { method: "POST", url: `/api/servers/${serverId}/backups/${encodeURIComponent(backupId)}/restore` },
      "Backup restore"
    );
  }

  async importWorld(serverId: string, worldData: any): Promise<void> {
    const { node } = await requireServerNode(serverId, "World import");
    await wingsRequest(
      node,
      { method: "POST", url: `/api/servers/${serverId}/world/import`, data: worldData, maxBodyLength: Infinity, maxContentLength: Infinity },
      "World import"
    );
  }

  async exportWorld(serverId: string): Promise<any> {
    const { node } = await requireServerNode(serverId, "World export");
    return wingsRequest(node, { method: "GET", url: `/api/servers/${serverId}/world/export` }, "World export");
  }
}
