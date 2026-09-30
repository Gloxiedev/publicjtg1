import React, { useState, useEffect } from "react";
import {
  Server,
  Plus,
  X,
  ServerCrash,
  CheckCircle2,
  ShieldAlert,
  Cpu,
  HardDrive,
  Network,
  Activity,
  Clock,
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Key,
  Globe,
  Radio,
  Eye,
  EyeOff,
  Trash2,
  Settings
} from "lucide-react";
import axios from "axios";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatUptime(seconds: number) {
  if (!seconds) return "0m";
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Nodes() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<any | null>(null);
  const [nodeConfig, setNodeConfig] = useState<any | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    fqdn: "",
    publicIpV4: "",
    publicIpV6: "",
    wingsPort: 8080,
    protocol: "http",
    ssl: false,
    location: "Default",
    memory: 8192,
    disk: 50000,
    cpuLimit: 100
  });

  const fetchNodes = async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/nodes");
      setNodes(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to load nodes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
  }, []);

  const handleCreateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await axios.post("/api/nodes", formData);
      setIsModalOpen(false);
      setFormData({
        name: "",
        description: "",
        fqdn: "",
        publicIpV4: "",
        publicIpV6: "",
        wingsPort: 8080,
        protocol: "http",
        ssl: false,
        location: "Default",
        memory: 8192,
        disk: 50000,
        cpuLimit: 100
      });
      fetchNodes();
      if (res.data?.node) {
        openConfigModal(res.data.node);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to add node");
    }
  };

  const openConfigModal = async (node: any) => {
    setSelectedNode(node);
    setLoadingConfig(true);
    setError("");
    try {
      const res = await axios.get(`/api/nodes/${node.id}/configuration`);
      setNodeConfig(res.data);
    } catch (err: any) {
      setError("Failed to fetch node configuration details.");
    } finally {
      setLoadingConfig(false);
    }
  };

  const handleRegenerateToken = async (nodeId: string) => {
    try {
      const res = await axios.post(`/api/nodes/${nodeId}/regenerate-token`);
      if (res.data?.registrationToken) {
        openConfigModal(selectedNode);
      }
    } catch (err: any) {
      alert("Failed to regenerate token: " + (err.response?.data?.error || err.message));
    }
  };

  const handleDeleteNode = async (nodeId: string, nodeName: string) => {
    if (!confirm(`Are you sure you want to delete node "${nodeName}"?`)) return;
    try {
      await axios.delete(`/api/nodes/${nodeId}`);
      if (selectedNode?.id === nodeId) setSelectedNode(null);
      fetchNodes();
    } catch (err: any) {
      alert(err.response?.data?.error || "Failed to delete node");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <Radio className="w-8 h-8 text-theme-500" /> Wings Nodes
          </h1>
          <p className="mt-2 text-muted-foreground">
            Manage game server execution daemons and VPS nodes across your architecture.
          </p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 rounded-xl bg-theme-600 px-5 py-3 text-sm font-semibold text-white shadow-lg hover:bg-theme-700 transition-all cursor-pointer"
        >
          <Plus className="h-5 w-5" /> Create Wings Node
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-red-400 flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 text-red-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="text-center py-20 font-mono text-muted-foreground flex items-center justify-center gap-3">
          <RefreshCw className="w-5 h-5 animate-spin text-theme-500" /> Loading nodes...
        </div>
      ) : nodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed border-border/80 bg-card/30 rounded-2xl p-8">
          <div className="p-4 bg-theme-500/10 rounded-2xl text-theme-500 mb-4 border border-theme-500/20">
            <ServerCrash className="h-10 w-10" />
          </div>
          <h3 className="text-xl font-bold text-foreground">No Wings Nodes Configured</h3>
          <p className="text-sm text-muted-foreground mt-2 max-w-md">
            Your panel currently has zero Wings nodes. Create a node and connect a remote daemon running on your VPS.
          </p>
          <button
            onClick={() => setIsModalOpen(true)}
            className="mt-6 flex items-center gap-2 rounded-xl bg-theme-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-theme-700 transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" /> Add Your First Node
          </button>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {nodes.map((node: any) => {
            const isOnline = node.status === "online";
            const isInstalling = node.status === "installing";

            const statusColor = isOnline
              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
              : isInstalling
              ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
              : "text-red-400 bg-red-500/10 border-red-500/30";

            const dotColor = isOnline
              ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
              : isInstalling
              ? "bg-amber-500 animate-pulse"
              : "bg-red-500";

            return (
              <div
                key={node.id}
                className="rounded-2xl border border-border bg-card p-6 shadow-sm flex flex-col justify-between hover:border-theme-500/40 transition-all"
              >
                <div>
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-theme-500/10 rounded-xl text-theme-500 border border-theme-500/20">
                        <Server className="h-6 w-6" />
                      </div>
                      <div>
                        <h3 className="font-bold text-lg text-foreground">{node.name}</h3>
                        <p className="text-xs font-mono text-muted-foreground flex items-center gap-1">
                          <Globe className="w-3 h-3 text-muted-foreground" />
                          {node.fqdn || node.hostname || node.publicIpV4}:{node.wingsPort || node.apiPort || 8080}
                        </p>
                      </div>
                    </div>
                    <span className={`flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold border uppercase tracking-wider ${statusColor}`}>
                      <span className={`w-2 h-2 rounded-full mr-1.5 ${dotColor}`} />
                      {node.status || "OFFLINE"}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mt-6">
                    <div className="bg-background/80 rounded-xl p-3 border border-border">
                      <div className="text-[10px] text-muted-foreground mb-1 font-mono uppercase tracking-wider">Memory</div>
                      <div className="font-bold text-sm text-foreground">{Math.round((node.memory || 8192) / 1024)} GB</div>
                    </div>
                    <div className="bg-background/80 rounded-xl p-3 border border-border">
                      <div className="text-[10px] text-muted-foreground mb-1 font-mono uppercase tracking-wider">Disk</div>
                      <div className="font-bold text-sm text-foreground">{Math.round((node.disk || 50000) / 1024)} GB</div>
                    </div>
                  </div>

                  {node.lastHeartbeat && (
                    <div className="mt-4 text-[11px] font-mono text-muted-foreground flex items-center justify-between border-t border-border/50 pt-3">
                      <span>Last Heartbeat:</span>
                      <span className="text-foreground">{new Date(node.lastHeartbeat).toLocaleTimeString()}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 mt-6 pt-4 border-t border-border">
                  <button
                    onClick={() => openConfigModal(node)}
                    className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-background border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-theme-500/10 hover:border-theme-500/30 transition-all cursor-pointer"
                  >
                    <Settings className="w-3.5 h-3.5 text-theme-500" /> Config & Setup
                  </button>
                  <button
                    onClick={() => handleDeleteNode(node.id, node.name)}
                    className="p-2 rounded-xl border border-border text-muted-foreground hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-all cursor-pointer"
                    title="Delete Node"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CREATE NODE MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-border p-6">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Plus className="w-5 h-5 text-theme-500" /> Create Wings Node
              </h2>
              <button onClick={() => setIsModalOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreateNode} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              <div>
                <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Node Name *</label>
                <input
                  required
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                  placeholder="e.g. EU-Node-01"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Description</label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={e => setFormData({ ...formData, description: e.target.value })}
                  className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                  placeholder="VPS Hosting in Germany"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">FQDN / Hostname</label>
                  <input
                    type="text"
                    value={formData.fqdn}
                    onChange={e => setFormData({ ...formData, fqdn: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                    placeholder="node1.example.com"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Public IPv4 *</label>
                  <input
                    required
                    type="text"
                    value={formData.publicIpV4}
                    onChange={e => setFormData({ ...formData, publicIpV4: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                    placeholder="203.0.113.20"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Wings Port</label>
                  <input
                    type="number"
                    value={formData.wingsPort}
                    onChange={e => setFormData({ ...formData, wingsPort: parseInt(e.target.value) || 8080 })}
                    className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                    placeholder="8080"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Memory Limit (MB)</label>
                  <input
                    type="number"
                    value={formData.memory}
                    onChange={e => setFormData({ ...formData, memory: parseInt(e.target.value) || 8192 })}
                    className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                    placeholder="8192"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Disk Limit (MB)</label>
                  <input
                    type="number"
                    value={formData.disk}
                    onChange={e => setFormData({ ...formData, disk: parseInt(e.target.value) || 50000 })}
                    className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                    placeholder="50000"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-mono uppercase tracking-wider text-muted-foreground">Location</label>
                  <input
                    type="text"
                    value={formData.location}
                    onChange={e => setFormData({ ...formData, location: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground focus:border-theme-500 focus:outline-none"
                    placeholder="Germany"
                  />
                </div>
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  className="w-full rounded-xl bg-theme-600 p-3 text-sm font-semibold text-white hover:bg-theme-700 transition-colors cursor-pointer"
                >
                  Create Node & Generate Setup Token
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONFIGURATION / SETUP MODAL */}
      {selectedNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-border p-6">
              <div>
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-theme-500" /> Wings Installation — {selectedNode.name}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Run the installation command on your VPS to register Wings with JTG Panel.
                </p>
              </div>
              <button onClick={() => setSelectedNode(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
              {loadingConfig ? (
                <div className="py-12 text-center font-mono text-xs text-muted-foreground flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-theme-500" /> Generating installation token...
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-2 block text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                      <span>Automated VPS Installation Command</span>
                      {copied && <span className="text-emerald-400 font-bold text-[10px]">COPIED!</span>}
                    </label>
                    <div className="relative bg-black/90 rounded-xl border border-border p-4 font-mono text-xs text-emerald-400 break-all select-all flex items-center justify-between gap-3">
                      <span>{nodeConfig?.installCommand}</span>
                      <button
                        onClick={() => copyToClipboard(nodeConfig?.installCommand || "")}
                        className="p-2 rounded-lg bg-theme-500/20 hover:bg-theme-500/40 text-theme-400 transition-all cursor-pointer shrink-0"
                        title="Copy Command"
                      >
                        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="bg-background/80 rounded-xl border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-muted-foreground">Registration Token:</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-foreground">
                          {showToken ? nodeConfig?.registrationToken : "••••••••••••••••••••••••"}
                        </span>
                        <button
                          onClick={() => setShowToken(!showToken)}
                          className="p-1 text-muted-foreground hover:text-foreground"
                        >
                          {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
                      <span>Token Status:</span>
                      <span className="text-amber-400">Single-use (Expires in 24 hours)</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      onClick={() => handleRegenerateToken(selectedNode.id)}
                      className="flex items-center gap-2 rounded-xl bg-background border border-border px-4 py-2.5 text-xs font-medium text-foreground hover:border-theme-500/40 transition-all cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-theme-500" /> Regenerate Registration Token
                    </button>
                    <button
                      onClick={() => setSelectedNode(null)}
                      className="rounded-xl bg-theme-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-theme-700 transition-all cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
