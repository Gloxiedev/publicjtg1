// The installer exports JTG_PANEL_MAX_MEMORY and JTG_PANEL_MAX_OLD_SPACE after
// measuring the host's RAM (see configure_memory_limits in install.sh). The
// defaults below keep a plain `pm2 start ecosystem.config.cjs` working.
const panelMaxMemory = process.env.JTG_PANEL_MAX_MEMORY || "1G";
const panelMaxOldSpace = process.env.JTG_PANEL_MAX_OLD_SPACE || "1024";
const adminMaxMemory = process.env.JTG_ADMIN_MAX_MEMORY || "2G";

module.exports = {
  apps: [
    {
      name: "jtg-main",
      // Run node directly rather than through `npm start`. npm swallows the
      // child process's stdout/stderr in this environment, which means a crash
      // in dist/server.cjs produces a PM2 log containing only the npm banner and
      // no error at all. Invoking the binary keeps the real error visible in
      // ~/.pm2/logs/jtg-main-error-0.log. `npm start` still works for humans.
      script: "node",
      args: "dist/server.cjs",
      instances: 1,
      autorestart: true,
      watch: false,
      // Restart on our own before the kernel OOM killer reaps the process
      // silently, and give V8 a heap ceiling it can actually reach.
      max_memory_restart: panelMaxMemory,
      node_args: `--max-old-space-size=${panelMaxOldSpace}`,
      env: {
        NODE_ENV: "production",
        // PORT, BIND_ADDRESS, DEFAULT_RUNTIME, ENABLE_DOCKER and JWT_SECRET are
        // intentionally NOT set here: a PM2 `env` block overrides .env, which
        // would silently ignore the operator's configuration and the installer's
        // generated JWT secret. They are read from .env at runtime instead.
      }
    },
    {
      name: "jtg-admin",
      script: "tsx",
      args: "watch server.ts",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: adminMaxMemory,
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      }
    }
  ]
};