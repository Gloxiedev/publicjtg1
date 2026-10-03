# Configuration

`.env` is the single source of truth. `install.sh` writes it; `.env.example`
documents every option. `.env` is git-ignored, created mode `600`, and should
never be committed.

After editing, restart the panel:

```bash
pm2 restart jtg-main
```

The panel prints its resolved configuration as the first line of startup. Check
it first when something behaves unexpectedly:

```
[JTG] Starting: node=v22.22.1 env=production port=6767 bind=127.0.0.1 cwd=/opt/jtg dotenv=/opt/jtg/.env jwt_secret=64 chars (set)
```

`dotenv=` shows which file was actually loaded. `jwt_secret=` reports only the
length, never the value.

## Network

### `PORT`

Panel listen port. Default `6767`.

### `BIND_ADDRESS`

| Value | Use when |
| --- | --- |
| `127.0.0.1` | Behind a Cloudflare Tunnel or a local reverse proxy |
| `0.0.0.0` | Directly reachable, and you have restricted the port by firewall |

### `TRUST_PROXY`

How many proxy hops to trust for `X-Forwarded-*`.

| Value | Behaviour |
| --- | --- |
| `false` | Trust nothing. `req.secure` is always false and `req.ip` is the proxy |
| `true` | Trust the first hop only — correct for a single `cloudflared` or nginx |
| `loopback` | Trust only requests arriving over loopback |

Do not enable this without a real proxy in front. Otherwise clients can spoof
`X-Forwarded-For` and appear to come from any address.

### `PANEL_URL`

Public base URL of the panel, e.g. `https://panel.example.com`. Must be
`http://` or `https://`.

This matters more than it looks. The panel builds the Wings `curl | bash`
command from this value. If it is unset, the panel falls back to the incoming
`Host` / `X-Forwarded-Host` header, which an attacker can control — which means
handing them a URL that executes your install script. Always set it.

`CORS_ORIGINS` defaults to this when set.

### `PANEL_URL_REQUIRED`

Set to `true` to refuse to build the Wings installer URL from request headers at
all. The panel then fails loudly instead of serving a script pointed at a
spoofed host.

Recommended whenever TLS terminates at a proxy or tunnel. Set `PANEL_URL` at the
same time, or the installer endpoint stops working.

### `CORS_ORIGINS`

Comma-separated list of browser origins allowed to call the API. Defaults to
`PANEL_URL`. Empty means same-origin only.

## Security

### `JWT_SECRET`

**Required in production.** Minimum 32 characters, and it must not be the value
that used to be hardcoded in this repository's source.

```bash
openssl rand -hex 32
```

The panel **refuses to start** under `NODE_ENV=production` when this is missing,
too short, or still the published default. That is intentional — the old default
was public, so anyone could forge an admin session with it.

Rotating it invalidates every existing session.

## Runtime

### `DEFAULT_RUNTIME`

`docker` (recommended) or `local`. Docker means the host does not need a Java
runtime installed; each server gets its own container.

### `ENABLE_DOCKER`

Set `false` to disable Docker entirely and run game servers as local processes.

### `DOCKER_SOCKET_PATH`

Defaults to `/var/run/docker.sock`. Only change it if you genuinely run Docker
somewhere unusual.

## Optional

| Variable | Notes |
| --- | --- |
| `GEMINI_API_KEY` | Kept server-side. Never exposed to the browser. |
| `DEV_AUTH_BYPASS` | Development-only passwordless login. **Ignored when `NODE_ENV=production`.** |

## Node-level settings

These live on the node record in the panel, not in `.env`. Edit them under
**Nodes → your node → Edit runtime settings**.

| Setting | Effect |
| --- | --- |
| Runtime backend | `docker` or `process`, for every server on the node |
| Default image | Container image, e.g. `itzg/minecraft-server:latest` |
| Default invocation | Startup command. `{{SERVER_MEMORY}}` expands to the server's RAM |

Changes reach a running Wings on its next heartbeat — no reinstall needed. This
was added because node settings used to be frozen into the node's
`config.yml` at install time, so editing them had no effect until you re-ran the
installer on every node.

Per-server settings override the node defaults, falling back in this order:

```
server.startupCommand → node.defaultInvocation → built-in default
server.dockerImage    → node.defaultImage      → image for the server type
server.ram            → node.memory
```

## Applying changes

```bash
pm2 restart jtg-main
pm2 logs jtg-main --lines 50
curl -s localhost:6767/api/health
```