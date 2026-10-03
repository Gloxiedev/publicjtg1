# JTG Panel documentation

Everything needed to take a fresh machine to a working panel with game servers
running on it.

## Read in this order

| Guide | What it covers |
| --- | --- |
| [01-quick-start.md](01-quick-start.md) | Fastest path to a running panel. Start here. |
| [02-installation.md](02-installation.md) | Installer flags, manual install, Docker, upgrades |
| [03-configuration.md](03-configuration.md) | Every `.env` variable and what it affects |
| [04-nodes-and-wings.md](04-nodes-and-wings.md) | Adding Wings nodes, install commands, networking |
| [05-servers.md](05-servers.md) | Allocations, deploying game servers, runtime settings |
| [06-operations.md](06-operations.md) | Day-to-day: logs, backups, upgrades, monitoring |
| [07-security.md](07-security.md) | Hardening checklist and what to rotate |
| [08-troubleshooting.md](08-troubleshooting.md) | Real error messages and their causes |

## The three ports

| Port | Direction | Purpose |
| --- | --- | --- |
| `6767` | Players → panel | Web UI and API |
| `8080` | Panel → Wings | Wings management API. Never exposed to players. |
| `25565`, … | Players → Wings | Game ports. One per server. Must not use Cloudflare proxying. |

## What talks to what

```
        players                      cloudflared (optional)
           │                               │
           ▼                               ▼
    ┌─────────────┐                 ┌─────────────┐
    │    PANEL    │───── HTTPS ────▶│    WINGS    │◀──── inbound :8080
    │  :6767      │  (panel dials   │  :8080      │
    │  PM2+node   │   this address) │  systemd    │
    └─────────────┘                 └─────────────┘
           ▲                               ▲
           │                               │ Docker socket
      admin browser                   game containers
```

The panel **dials out** to Wings. Wings never needs to reach the panel
inbound, and neither does it need to be in front of anything.

## Minimum sizing

| Host | RAM | Notes |
| --- | --- | --- |
| Panel | 1.5 GB | Prints a warning below 1536 MB |
| Panel + game servers | 2 GB+ per server | Paper/Paper-like servers need ~700 MB each |
| Wings node | 2 GB+ | Running Minecraft on a 1 GB box gets OOM-killed |

A panel host and a Wings node can be the same machine, but keep in mind that a
box sized for the panel usually cannot also run game servers.

## Before you expose anything

- [ ] `JWT_SECRET` is set to a real random value (`openssl rand -hex 32`)
- [ ] The owner password is not the installer default
- [ ] `PANEL_URL` is set to the panel's real public URL
- [ ] `PANEL_URL_REQUIRED=true` if TLS ends at a proxy or tunnel
- [ ] Panel port is reachable only from where it should be
- [ ] Node API secrets have never left the node

See [07-security.md](07-security.md) for the full checklist.