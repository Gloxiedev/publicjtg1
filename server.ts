import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import fs from "fs-extra";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "./src/server/services/jwtSecret.js";

const JWT_SECRET = getJwtSecret();

// Behind Cloudflare Tunnel (or any reverse proxy) the client IP and the original
// scheme arrive in X-Forwarded-* headers. Without trust proxy, req.secure is
// always false and req.ip is the proxy, which breaks HTTPS detection and any
// future IP-based control. trust proxy is opt-in and loopback-restricted so a
// direct client cannot spoof these headers.
const TRUST_PROXY =
  process.env.TRUST_PROXY === "true"
    ? 1 // first hop only
    : process.env.TRUST_PROXY === "loopback"
      ? "loopback"
      : false;

// Only allow browser origins that are actually this panel, unless the operator
// opts out. A wildcard origin lets any website talk to the panel API.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.PANEL_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
if (TRUST_PROXY !== false) app.set("trust proxy", TRUST_PROXY);

const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: CORS_ORIGINS.length ? { origin: CORS_ORIGINS } : { origin: false },
});
app.set("io", io);

// Initialize data folders
const DATA_DIR = path.join(process.cwd(), ".data");
const SERVERS_DIR = path.join(DATA_DIR, "servers");
const BACKUPS_DIR = path.join(process.cwd(), "backups");

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(SERVERS_DIR);
fs.ensureDirSync(BACKUPS_DIR);
fs.ensureDirSync(path.join(DATA_DIR, "temp"));

if (!fs.existsSync(path.join(DATA_DIR, "users.json"))) fs.writeFileSync(path.join(DATA_DIR, "users.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "servers.json"))) fs.writeFileSync(path.join(DATA_DIR, "servers.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "settings.json"))) fs.writeFileSync(path.join(DATA_DIR, "settings.json"), "{}");

import { getServerRuntimeLogs, attachServerRuntimeSocket } from "./src/server/services/runtime.js";
import { panelEvents } from "./src/server/events.js";

panelEvents.on("log", (serverId: string, logData: string) => {
  io.to(`server_${serverId}`).emit("log", logData);
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  try {
    const verified = jwt.verify(token, JWT_SECRET) as any;
    (socket as any).user = verified;
    next();
  } catch (err) {
    next(new Error("Authentication error"));
  }
});

io.on("connection", (socket) => {
  socket.on("joinServer", async (serverId) => {
    try {
      const serversJSON = await fs.readFile(path.join(DATA_DIR, "servers.json"), "utf8");
      const servers = JSON.parse(serversJSON);
      const server = Array.isArray(servers) ? servers.find((s: any) => s.id === serverId) : null;
      if (!server) return;

      // Authorise before joining the room, otherwise any authenticated account
      // can subscribe to another tenant's live console and logs.
      const user = (socket as any).user;
      const isAdmin = user?.role === "admin" || user?.role === "owner";
      if (!isAdmin && server.owner !== user?.id) return;

      socket.join(`server_${serverId}`);

      const logs = await getServerRuntimeLogs(server);
      if (logs) {
        socket.emit("log", String(logs).trim() + "\n");
      }
      if (server.status === "online") {
        await attachServerRuntimeSocket(server, serverId);
      }
    } catch (e) {
      console.error("Error fetching logs for server", serverId, e);
    }
  });
  socket.on("leaveServer", (serverId) => {
    socket.leave(`server_${serverId}`);
  });
});

// STRICT ROUTING: 3000 for Admin/Dev, 6767 for Main/Prod
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (process.env.NODE_ENV === "development" ? 3000 : 6767);
const isDev = process.env.NODE_ENV === "development" && PORT === 3000;

// BIND_ADDRESS=127.0.0.1 keeps the panel reachable only from this host, which is
// what you want when a Cloudflare Tunnel is the only public entry point.
// BIND_ADDRESS=0.0.0.0 exposes the port directly (firewall permitting).
const BIND_ADDRESS = process.env.BIND_ADDRESS || "0.0.0.0";

app.use(express.json({ limit: "50gb" }));
app.use(express.urlencoded({ extended: true, limit: "50gb" }));
// Restrict cross-origin browser access to the panel's own origin. With no
// configured origin the panel is same-origin only, which is the correct default
// for a reverse-proxied deployment.
app.use(
  cors({
    origin: CORS_ORIGINS.length ? CORS_ORIGINS : false,
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

import apiRoutes from "./src/server/routes/api.js";
app.use("/api", apiRoutes);

import { initSFTPServer } from "./src/server/services/sftp.js";

async function ensureOwnerFromEnv() {
  const envUser = process.env.JTG_OWNER_USER;
  const envPass = process.env.JTG_OWNER_PASS;
  if (!envUser || !envPass) return;

  try {
    const usersFile = path.join(DATA_DIR, "users.json");
    const users = (await fs.pathExists(usersFile)) ? await fs.readJson(usersFile) : [];
    const existingIndex = users.findIndex(
      (u: any) => u.username && u.username.toLowerCase() === envUser.toLowerCase()
    );
    const bcrypt = await import("bcryptjs");
    const hashedPassword = await bcrypt.default.hash(envPass, 10);

    if (existingIndex !== -1) {
      users[existingIndex].password = hashedPassword;
      users[existingIndex].role = "owner";
      users[existingIndex].passwordVersion = (users[existingIndex].passwordVersion || 0) + 1;
    } else {
      users.forEach((u: any) => {
        if (u.role === "owner") u.role = "admin";
      });
      users.push({
        id: "owner-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
        username: envUser,
        password: hashedPassword,
        role: "owner",
        passwordVersion: 0,
        createdAt: new Date().toISOString(),
      });
    }
    await fs.writeJson(usersFile, users, { spaces: 2 });
    console.log(`[JTG] Owner user '${envUser}' ensured in database.`);
  } catch (err) {
    console.error("[JTG] Failed to ensure owner from environment:", err);
  }
}

async function startServer() {
  // Print the resolved configuration before anything can fail. If the process
  // dies during startup this line is the first thing to check in the PM2 log:
  // it shows which .env was loaded and which values actually reached the
  // process (remember that a PM2 `env:` block overrides .env).
  console.log(
    `[JTG] Starting: node=${process.version} env=${process.env.NODE_ENV || "(unset)"} ` +
      `port=${PORT} bind=${BIND_ADDRESS} cwd=${process.cwd()} ` +
      `dotenv=${process.env.DOTENV_CONFIG_PATH || path.resolve(".env")}${fs.existsSync(path.resolve(".env")) ? "" : " (missing)"} ` +
      `jwt_secret=${process.env.JWT_SECRET ? `${JWT_SECRET.length} chars (set)` : "MISSING"}`
  );

  await ensureOwnerFromEnv();
  await initSFTPServer();

  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[JTG] Cannot start: port ${PORT} is already in use on ${BIND_ADDRESS}.\n` +
          `      Find the holder with:  ss -lntp | grep ':${PORT}'\n` +
          `      Or stop it, or set a different PORT in .env`
      );
    } else {
      console.error(`[JTG] HTTP server error:`, err);
    }
    process.exit(1);
  });
  httpServer.listen(PORT, BIND_ADDRESS, () => {
    console.log(`JTG Panel running on port ${PORT} (bound to ${BIND_ADDRESS})`);
  });
}

// Registered before the server starts so a failure during startup is reported
// with its real cause instead of being swallowed into crash.log while the
// process stays alive but never listens on the port.
function writeCrashLog(detail: string) {
  try {
    fs.writeFileSync("crash.log", detail);
  } catch {}
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  writeCrashLog(String(err?.stack || err));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  writeCrashLog(String((reason as Error)?.stack || reason));
  process.exit(1);
});

startServer().catch((err) => {
  console.error("[JTG] Startup failed:", err);
  writeCrashLog(String(err?.stack || err));
  process.exit(1);
});
