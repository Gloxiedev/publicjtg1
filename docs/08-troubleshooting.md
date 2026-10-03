# Troubleshooting

Real errors, with the cause and the fix.

## Panel

### Will not start, mentions `JWT_SECRET`

```
Error: JWT_SECRET must be set to a random value of at least 32 characters in production
```

Intended behaviour. Set it in `.env`:

```bash
openssl rand -hex 32
```

`install.sh` generates one, but a `.env` copied from `.env.example` or restored
from an old backup still carries the placeholder.

### PM2 says crashed or stopped, error log is empty

```bash
pm2 describe jtg-main | grep -E 'status|restarts|memory'
tail -n 50 ~/.pm2/logs/jtg-main-error-0.log
free -m
dmesg -T | grep -iE 'killed process|out of memory' | tail -5
```

An empty log with a climbing `restarts` count is the Linux OOM killer. Add swap
or move to a bigger host:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Re-running `install.sh` dumps all of this automatically when its health check
fails.

### PM2 references a file that no longer exists

```
Error: Cannot find module '/root/jtg/node_modules/pm2/lib/ProcessContainer.js'
```

PM2 is running against a deleted `node_modules`, typically after a partial
deploy. The installer detects this and runs `pm2 kill` before restarting. To fix
by hand:

```bash
cd /root/jtg
pm2 kill
pm2 start ecosystem.config.cjs --update-env
pm2 save
```

### Did not come back after reboot

```bash
systemctl is-enabled pm2-root
sudo systemctl enable --now pm2-root
```

`pm2 startup systemd -u root --hp /root` writes the unit; `--hp` matters,
otherwise PM2 looks for the wrong home directory and the unit exits immediately.

### `Port 6767 is in use by another process`

Stop the other process or choose another port with `--panel-port 8080`.

### Docker not reachable from a shell

Adding a user to the `docker` group only applies to a **new** login session:

```bash
newgrp docker
```

The installer never runs `chmod 666 /var/run/docker.sock`. A world-writable
Docker socket means any local process can start a privileged container.

### Installer sits on "Setting up Cloudflare Tunnel" for minutes

```
Setting up Cloudflare Tunnel for panel.example.com...
```

Not a hang in older builds: `cloudflared tunnel login` opens a browser and waits
for you to authorise. On a headless VPS no browser can complete it, so it waited
out the full timeout printing nothing.

Since `f45e93f` the authorisation URL is printed the moment `cloudflared`
produces it, because it runs under a pty and no longer buffers its output. Open
that URL from any device — phone, laptop, anything with a browser — approve it,
and the installer continues on its own. If you never saw the URL, check the
build marker below first.

The banner prints a build string. If yours does not read
`2026.10.03-tunnel-pty`, you are running an old copy:

```
  build 2026.10.03-tunnel-pty
```

To see what a URL will actually give you before committing to it:

```bash
curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh | grep INSTALLER_VERSION=
```

**`main` is served through a CDN with a 5 minute cache.** Right after a push,
`raw.githubusercontent.com/.../main/install.sh` can still return the previous
version for several minutes — `x-cache: HIT` in the response headers is the
tell. If you are not sure which build you have, pin the commit:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/f45e93f/install.sh)
```

or clone, which bypasses the CDN entirely:

```bash
git clone --depth 1 https://github.com/Gloxiedev/publicjtg1.git
bash publicjtg1/install.sh
```

If you are on an older copy, `Ctrl+C` and either:

```bash
# Open the URL it prints, from any machine, then re-run
```

or skip the interactive login entirely with a tunnel token:

```bash
# Zero Trust -> Networks -> Tunnels -> create -> copy the install command token
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \
  --yes --exposure cloudflare --panel-domain panel.example.com \
  --cloudflare-token "<token>"
```

or skip Cloudflare and expose the panel directly:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \
  --yes --exposure direct
```

### Cloudflare returns 502

The tunnel origin and the panel must agree on the port. Compare the ingress
`service:` in `/etc/cloudflared/config.yml` with `PORT` in `.env`, and confirm
`cloudflared` is running:

```bash
systemctl status cloudflared --no-pager
journalctl -u cloudflared -n 50
```

## Wings

### Installer exits immediately

```
Run this installer as root (or via sudo).
```

Pipe it through `sudo`:

```bash
curl -fsSL https://<panel>:6767/api/wings/install | sudo bash -s -- jtg_reg_<token>
```

### `Panel URL is not set`

```
Panel URL is not set. Pass --panel https://your-panel.example.com, or set PANEL_URL.
```

You fetched the script from GitHub rather than from the panel, so the panel
address was never substituted in. Either use the panel's copy:

```bash
curl -fsSL https://<panel>:6767/api/wings/install | sudo bash -s -- jtg_reg_<token>
```

or pass it explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/src/wings/wings-install.sh \
  | sudo bash -s -- jtg_reg_<token> --panel https://<panel>:6767
```

### `Registration token format is invalid`

The token must be `jtg_reg_` followed by exactly 40 hex characters. Usually a
truncated copy/paste, or the wrong token entirely.

### `Registration token has already been used`

Tokens are single use. Generate a new one in the panel and re-run the installer.

### Node stays OFFLINE

```bash
systemctl status wings --no-pager
journalctl -u wings -n 50
ss -lntp | grep 8080
```

Then confirm the panel can reach the node, and that the port is open in the
security group. A node with no heartbeat since registration shows **Error**;
one that registered and then went quiet shows **Offline**.

### `could not refresh config from panel`

```
[could not refresh config from panel: ... (continuing with local config)]
```

A warning, not a failure. Wings keeps its last-known config and keeps serving.
Check the panel's reachability and the node's API secret.

### `systemctl status jtg-wings` says no such unit

The unit was renamed to `wings.service` in `983c648`. The old name is kept as an
alias; if the alias is missing, reinstall:

```bash
curl -fsSL https://<panel>:6767/api/wings/install | sudo bash -s -- jtg_reg_<token>
```

## Game servers

### Start returns 500, `allocation ... is not defined on this node`

The node has not synced that allocation yet. Wait for one heartbeat and retry.
If it persists, the allocation was added to the wrong node, or the node is
pointing at a different panel.

### `failed to bind host port <ip>:<port>/tcp: cannot assign requested address`

Docker cannot bind the allocation address because it is not configured on the
node — typical on AWS, where an Elastic IP is a NAT rather than a local address.

Wings handles this automatically and publishes on `0.0.0.0`, logging:

```
allocation 13.206.218.155 is not configured on this host; publishing game ports on 0.0.0.0 instead
```

If you see the error without that warning, the node is running an old daemon.
Update it:

```bash
curl -fsSL https://<panel>:6767/api/wings/daemon.js \
  | sudo tee /etc/jtg-wings/wings.cjs > /dev/null
sudo chmod 700 /etc/jtg-wings/wings.cjs
sudo systemctl restart wings
```

### Container exits with code 1, mentions the EULA

```
[ERROR] Please accept the Minecraft EULA
```

Fixed in `d171d2f`; Wings writes `eula.txt` before creating the container.
Check `/var/lib/jtg-wings/servers/<uuid>/eula.txt` exists. On an older daemon,
either update the daemon or write the file yourself.

### Container is OOM-killed

```bash
docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' <container>
```

`true` means the server exceeded its `--memory` limit. Raise the server's RAM in
the panel, or the host's free memory. A container also exits 137 when the host
itself is out of memory.

Minecraft needs roughly 700 MB minimum; 1.5 GB is comfortable for a small
Paper server. A 1 GB host cannot run game servers.

### Server starts then goes offline with no error

Check in order:

```bash
journalctl -u wings -n 50
docker logs --tail 50 <container>
cat /var/lib/jtg-wings/servers/<uuid>/logs/output.log
```

A container that runs briefly and exits is usually an application error — a bad
plugin, a corrupt world, or a port already in use on the host.

### Files edited in the UI are not visible to the game

They should be — the server directory is bind-mounted at `/data`. If not:

```bash
docker inspect <container> --format '{{range .Mounts}}{{.Source}}=>{{.Destination}}{{end}}'
```

Expected: `/var/lib/jtg-wings/servers/<uuid>=/data`. An empty result means the
daemon predates `cc0730c`; update it.

### `{"error":"Invalid path"}`

The path escaped the server directory. Paths are relative to the server root, so
use `/plugins`, not `/plugins/../../../etc/passwd`. This is the containment
working as intended.

### Log stream is empty

A container producing no output — `sleep`, for example — returns empty logs.
Confirm with `docker logs <container>`.

## Escalation

Collect this before reporting anything:

```bash
pm2 describe jtg-main | grep -E 'version|status|restarts'
pm2 logs jtg-main --lines 50
git rev-parse HEAD                       # panel commit
curl -s localhost:6767/api/health
```

On the node:

```bash
wings_version=$(sudo grep -o '"version": *"[^"]*"' /etc/jtg-wings/config.yml | head -1)
systemctl status wings --no-pager
journalctl -u wings -n 100
sudo tail -20 /var/lib/jtg-wings/access.log
docker ps -a --format '{{.Names}} | {{.Status}}'
```

`/var/lib/jtg-wings/access.log` is one JSON line per Wings API call and is
usually the fastest way to see what the panel actually asked for and what it got
back. Redact API secrets before sharing it.