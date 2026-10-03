# JTG Panel

Made by Jishnu

A Minecraft server management panel. The **panel** is a web app; each **Wings**
node is a small daemon that runs the actual game containers on a separate VPS.
The panel never touches a game container directly — it talks to Wings over HTTP.

---

## Quick install

One command on a fresh Ubuntu or Debian server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh)
```

The script installs Node.js, Docker, PM2, builds the app, creates the owner
account and starts the panel. It asks how you want the panel published:

| Choice | Result |
| --- | --- |
| **1. Direct** | Panel listens on `0.0.0.0:6767`, reachable at `http://<server-ip>:6767`. No HTTPS. |
| **2. Cloudflare Tunnel** | Panel binds `127.0.0.1` only and is published at `https://panel.example.com`. |
| **3. Later** | Panel binds `127.0.0.1` only. Nothing is public until you re-run the installer. |

### Unattended

```bash
# Default: loopback only, generates and prints a random owner password
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) --yes

# Your own credentials
bash <(curl -fsSL .../install.sh) --yes --owner-user admin --owner-pass 'your-password'

# Behind a Cloudflare Tunnel, fully unattended
bash <(curl -fsSL .../install.sh) \
  --yes \
  --exposure cloudflare \
  --panel-domain panel.example.com \
  --cloudflare-token "$TUNNEL_TOKEN"
```

All flags: `bash install.sh --help`.

Unattended runs never prompt. If a required decision is missing they fail with an
explicit message instead of waiting on input.

---

## Ports

| Port | What | Exposed to the internet? |
| --- | --- | --- |
| `6767` | Panel HTTP | Only with `--exposure direct` |
| `2022` | Panel SFTP (file manager) | Never, unless you proxy it deliberately |
| `8080` | Wings API on each node | See [Wings networking](#wings-networking) |
| Game ports | Minecraft per allocation | Yes — these are what players connect to |

---

## Cloudflare Tunnel

### What the tunnel does

```
player ──https──> Cloudflare edge ──tunnel──> cloudflared (this host)
                                                   │  http://127.0.0.1:6767
                                                   ▼
                                              JTG Panel
```

- TLS terminates at Cloudflare. The origin is plain HTTP on loopback, which is
  safe because nothing else can reach `127.0.0.1`.
- The installer writes `BIND_ADDRESS=127.0.0.1`, `TRUST_PROXY=true`,
  `PANEL_URL=https://your-domain` and `CORS_ORIGINS=https://your-domain` to `.env`.
  `TRUST_PROXY` is what makes `req.secure` and client IPs correct behind the proxy.

### Two ways to authenticate

These are genuinely different and the installer keeps them separate:

**Tunnel token** (`--cloudflare-token`) — a token only lets `cloudflared` *connect*
to a tunnel that already exists. It has no account API permission, so the script
**cannot** create the tunnel or its DNS record. You add the public hostname in the
Cloudflare dashboard:

> Zero Trust → Networks → Tunnels → your tunnel → **Public Hostnames**
> hostname `panel.example.com`, service `http://127.0.0.1:6767`

**Interactive login** (no token, run from a terminal) — `cloudflared tunnel login`
stores an account certificate that *can* create tunnels and DNS records, so the
script does everything for you. It opens a browser and is bounded to 300 seconds;
it can never run unattended.

### If the tunnel step fails

The installer never hangs. Every `cloudflared` call has a timeout and reports the
real error. Common causes:

| Message | Cause | Fix |
| --- | --- | --- |
| `needs a tunnel token when unattended` | No token and no TTY | Pass `--cloudflare-token` |
| `service failed to start` | Bad or expired token | `sudo systemctl status cloudflared-tunnel-jtg` |
| `Could not create the DNS route` | Record already exists | Delete it in the dashboard, re-run |
| Tunnel connects, site 502s | Panel not listening on the origin port | Check `.env` `PORT` matches the ingress `service` |

Inspect it manually:

```bash
sudo systemctl status cloudflared-tunnel-jtg
sudo journalctl -u cloudflared-tunnel-jtg -n 50 --no-pager
sudo cat /etc/cloudflared/config.yml
```

### Cloudflare is not a generic TCP proxy

Cloudflare's proxy only forwards a fixed set of **HTTP ports**. This matters:

- The panel via Tunnel: **works**.
- Wings API on `8080`: **works** (a proxied HTTP port), but you normally do not
  need to — see below.
- Minecraft game ports such as `25565`, `18081`, `18443`: **not proxied** on any
  plan. Players cannot connect to a game server through a Cloudflare Tunnel.

Do not put Wings or game traffic behind a Tunnel. Run Wings on its own VPS with a
public IP, or on the same host with the ports published directly.

---

## Wings nodes

Wings runs the game containers. Each node is a separate machine with a public
IPv4.

1. **Install the panel** on your main server.
2. **Create a node** in the panel: *Nodes → Create Wings Node*. Enter the name,
   FQDN/hostname, public IPv4, Wings port (default `8080`), memory and disk.
   The runtime backend, default image and default invocation set here apply to
   every server on the node, and a running Wings picks up later changes on its
   own — reinstalling is not needed to change them.
3. **Install Wings** on that VPS. The panel shows a command with a single-use
   registration token:

   ```bash
   curl -fsSL https://panel.example.com/api/wings/install | sudo bash -s -- <REGISTRATION_TOKEN>
   ```

   The token works once. Wings registers with the panel and installs a
   `wings` systemd service; the node turns **ONLINE**. The script must run as
   root, so pipe it through `sudo` (older builds were documented without it and
   exited immediately).

   To pin an exact revision, or to fetch the script straight from GitHub, pass the
   panel address yourself:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/src/wings/wings-install.sh \
     | sudo bash -s -- <REGISTRATION_TOKEN> --panel https://panel.example.com
   ```

   `sudo wingsctl status`, `journalctl -u wings` and `systemctl restart wings`
   manage the daemon afterwards. Releases before `983c648` installed a
   `jtg-wings.service` unit; that name still works as an alias.
4. **Deploy** with *Deploy Instance*, choosing the node and a port allocation.

### Wings networking

- **Panel → Wings** is outbound. The panel reaches Wings at the address you
  registered, so Wings must be reachable from the panel host.
- **Players → Wings** is inbound to the game ports. These must be open in the
  node's firewall and security group, and must not go through Cloudflare.
- Game ports are published on the allocation address when the node really owns
  it, and otherwise on `0.0.0.0`. That second case is what makes nodes behind
  cloud NAT work: on AWS an Elastic IP is not configured on any local
  interface, so binding it directly fails with `cannot assign requested
  address`.
- If the panel is on a loopback-only host behind a Tunnel, that is fine: the
  tunnel is only for people using the web UI. Wings talks to the panel's public
  HTTPS URL.

For a local test without a second machine:

```bash
bash src/wings/wings-install.sh --local-test
```

### TLS between panel and Wings

Use HTTPS with a certificate Wings can verify. If you use a private CA, install
that CA's root certificate on the panel host and point Node at it:

```bash
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/private-ca.crt
```

Self-signed certificates are accepted only when explicitly trusted this way.
Never disable TLS verification.

---

## Manual installation

```bash
git clone https://github.com/Gloxiedev/publicjtg1.git
cd publicjtg1
npm install
npm run build
cp .env.example .env      # then set JWT_SECRET and BIND_ADDRESS
npm run createuser        # create the owner account
npm start                 # listens on PORT from .env
```

Generate a JWT secret:

```bash
openssl rand -hex 32
```

The panel **refuses to start** when `NODE_ENV=production` and `JWT_SECRET` is
missing, shorter than 32 characters, or still the value that used to be hardcoded
in this repository's source. That is deliberate: the old default was public, so
anyone could forge an admin session.

---

## Configuration

`.env` is the single source of truth. `install.sh` writes it; see
`.env.example` for every option.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `6767` | Panel listen port |
| `BIND_ADDRESS` | `0.0.0.0` | Use `127.0.0.1` when behind a Tunnel |
| `TRUST_PROXY` | `false` | `true` trusts one hop — only with a real proxy in front |
| `PANEL_URL` | — | Public base URL; used to build Wings install commands |
| `CORS_ORIGINS` | `PANEL_URL` | Empty means same-origin only |
| `JWT_SECRET` | — | Required in production, ≥32 chars |
| `DEFAULT_RUNTIME` | `docker` | `docker` or `local` |
| `ENABLE_DOCKER` | `true` | Set `false` for local-process servers |
| `DEV_AUTH_BYPASS` | `false` | Passwordless login; ignored when `NODE_ENV=production` |

`.env` holds secrets. It is git-ignored, created with mode `600`, and private
keys and certificates (`*.pem`, `*.key`, `*.crt`, …) are git- and Docker-ignored.

---

## Operating

```bash
pm2 status
pm2 logs jtg-main --lines 100
pm2 restart jtg-main
curl -s localhost:6767/api/health
```

The panel prints one line at startup describing its resolved configuration. It is
the first thing to check when the process dies early:

```
[JTG] Starting: node=v22.22.1 env=production port=6767 bind=127.0.0.1 cwd=/opt/jtg dotenv=/opt/jtg/.env jwt_secret=64 chars (set)
```

`dotenv=` shows which `.env` was actually loaded, and `jwt_secret=` reports only
the length — never the value. PM2 runs `node dist/server.cjs` directly rather
than `npm start`, because npm swallows the child's output and a crash would
otherwise leave an empty error log. `npm start` still works normally by hand.

The installer sizes the PM2 memory limit and the Node heap ceiling from the
machine's RAM (never above the 1 GB default). On a host with less than 1536 MB it
prints a warning, because building the panel and then running it leaves little
headroom.

Re-running `install.sh` is safe. It preserves your `.env` (including the JWT
secret, so sessions survive), reuses the existing PM2 process and reconfigures
the tunnel in place.

---

## Development

```bash
npm install
npm run dev        # panel on :3000 with Vite HMR
```

`NODE_ENV=production` is what activates the fail-closed JWT check and disables
the dev login bypass. Do not run a public deployment in dev mode.

### Tests

```bash
npm run lint                                   # tsc --noEmit
npm run build

# Hermetic security regression tests (no Docker, no network)
npx tsx works/tests/security/security.mjs

# Full multi-node integration: real Wings processes, real Docker workloads
bash works/tests/multinode/run.sh
```

The security suite covers the JWT fail-closed behaviour, the login bypass, path
traversal containment and Docker image-reference validation. The multi-node suite
runs 102 checks across several nodes, allocations, console, files and lifecycle.

---

## Troubleshooting

**Panel will not start and mentions `JWT_SECRET`.**
Set it in `.env`: `openssl rand -hex 32`. This is the intended behaviour in
production. `install.sh` generates one for you, but a `.env` copied from
`.env.example` or restored from an old backup still carries the placeholder.

**PM2 says `jtg-main` crashed or stopped, and the error log is empty.**
Read the real reason:

```bash
pm2 describe jtg-main | grep -E 'status|restarts|memory'
tail -n 50 ~/.pm2/logs/jtg-main-error-0.log
free -m
dmesg -T | grep -iE 'killed process|out of memory' | tail -5
```

An empty log with a high `restarts` count usually means the Linux OOM killer
reaped the process. Add swap, or move to a host with 2 GB or more:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

`install.sh` also dumps all of the above automatically when its health check
fails, so re-running it will print the cause.

**`Port 6767 is in use by another process`.**
Stop the other service, or pick another port with `--panel-port 8080`.

**Docker is not reachable from this shell.**
Adding a user to the `docker` group only takes effect in a new login session:
`newgrp docker`, or log out and back in. The installer never runs
`chmod 666 /var/run/docker.sock` — a world-writable Docker socket means any
local process can start a privileged container and take over the host.

**Cloudflare site returns 502.**
The tunnel origin and the panel must agree on the port. Check the ingress
`service:` in `/etc/cloudflared/config.yml` against `PORT` in `.env`.

**A node stays OFFLINE.**
Check Wings on that host: `systemctl status jtg-wings`, `journalctl -u jtg-wings`.
Confirm the panel can reach the node's public IP on the Wings port, and that the
registration token was not already used.

---

## Security notes

- Report vulnerabilities privately to the maintainers rather than in a public issue.
- Never commit `.env`, private keys, tunnel tokens or certificate files.
- Treat a leaked `*.pem` as a full compromise: rotate or revoke it immediately.
- The `docker` group is effectively root on the host. Only grant it to the account
  that runs the panel.
