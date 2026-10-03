# Installing the panel

## Scripted install (recommended)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh)
```

The installer is idempotent. It preserves an existing `.env` (so your JWT secret
and sessions survive), reuses the running PM2 process, and reconfigures the
Cloudflare tunnel in place.

## Options

### General

| Flag | Default | Notes |
| --- | --- | --- |
| `--yes` | prompt | Unattended. Never prompts. |
| `--mode <1\|2>` | ask | `1` = Node under PM2 (recommended). `2` = plain local Node. |
| `--help` | — | Print usage. |

### Public exposure

| Flag | Notes |
| --- | --- |
| `--exposure <direct\|cloudflare\|later>` | `direct` binds `0.0.0.0`; `cloudflare` binds `127.0.0.1` and sets up a tunnel; `later` binds `127.0.0.1` |
| `--panel-domain <host>` | Public hostname, e.g. `panel.example.com` |
| `--panel-port <port>` | Panel port, default `6767` |
| `--cloudflare-token <t>` | Tunnel token. Required for unattended Cloudflare setup. |
| `--tunnel-name <name>` | Default `jtg-panel` |
| `--existing-tunnel <n>` | Reuse a tunnel instead of creating one |

### Owner account

| Flag | Notes |
| --- | --- |
| `--owner-user <name>` | Owner username |
| `--owner-pass <pass>` | Owner password, minimum 6 characters |
| `--bind-address <addr>` | Override the listen address |

## Examples

Behind a Cloudflare Tunnel, fully unattended:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \
  --yes --exposure cloudflare --panel-domain panel.example.com \
  --cloudflare-token "$TUNNEL_TOKEN"
```

Direct, non-default port, credentials supplied:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \
  --yes --exposure direct --panel-port 8080 \
  --owner-user owner --owner-pass 'a-real-password'
```

## What the installer does

1. Detects a stale PM2 daemon that references a deleted `node_modules` and
   recovers from it (`pm2 kill` then restart), instead of leaving you with a
   process that dies on the next deploy.
2. Installs dependencies and builds.
3. Writes `.env` with mode `600` and a real `JWT_SECRET`.
4. Creates the owner account if none exists.
5. Starts the panel under PM2.
6. Runs `pm2 startup systemd` and `systemctl enable` so the panel survives a
   reboot, then `pm2 save`.
7. Health-checks `http://127.0.0.1:<port>/api/health`. If that fails it dumps
   `pm2 describe`, the last 50 lines of both logs, `free -m` and recent
   OOM-killer messages before exiting.

That last step is deliberate: an install that "succeeded" but serves nothing is
worse than one that fails loudly.

## Manual install

```bash
git clone https://github.com/Gloxiedev/publicjtg1.git
cd publicjtg1
npm install
npm run build

cp .env.example .env
openssl rand -hex 32          # paste into JWT_SECRET
$EDITOR .env                  # set BIND_ADDRESS and PANEL_URL

npm run createuser            # create the owner account
npm start
```

For a long-lived deployment, run it under PM2 or systemd rather than a terminal.

### npm scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Panel on `:3000` with Vite HMR |
| `npm run build` | Build the frontend and bundle the server |
| `npm start` | Run the built server |
| `npm run createuser` | Create an account |
| `npm run lint` | `tsc --noEmit` |
| `npm run clean` | Remove `dist/` |

## Docker

`Dockerfile` and `docker-compose.yml` are present for containerised deployments.
Note that a Dockerised panel cannot start Docker containers unless you mount the
host socket:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
  - ./data:/opt/jtg/.data
```

Mounting the Docker socket gives the container root-equivalent access to the
host. Only do this on a host you already trust with the panel.

## Requirements

| Requirement | Version |
| --- | --- |
| OS | Debian, Ubuntu, RHEL, CentOS, Rocky, AlmaLinux, Oracle, Fedora |
| Architecture | `x86_64` or `aarch64` |
| Node.js | 20+ (the installer installs it) |
| systemd | Required on the panel host for boot persistence |
| Docker | Required for `DEFAULT_RUNTIME=docker` |
| RAM | 1.5 GB for the panel alone; see sizing in the [docs index](README.md) |

## Upgrading

```bash
cd /opt/jtg            # or wherever you installed
git fetch --all --prune
git reset --hard origin/main
npm install
npm run build
pm2 restart jtg-main
curl -s localhost:6767/api/health
```

`.env` and `.data/` are not touched by `git reset`, so your secret and your data
survive. See [06-operations.md](06-operations.md) for backups first.