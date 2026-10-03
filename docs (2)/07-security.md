# Security

Work through this before exposing a deployment.

## Deployment checklist

### Secrets

- [ ] `JWT_SECRET` is random, at least 32 characters, and not the value that
      used to be hardcoded in this repository. `openssl rand -hex 32`
- [ ] The owner password is not the installer's generated or example one
- [ ] `.env` is mode `600` and git-ignored
- [ ] No tunnel token, private key or certificate committed to the repo
- [ ] Any `*.pem` that was ever pasted into a chat, ticket or commit is treated
      as compromised and rotated

### Network

- [ ] Panel port `6767` reachable only from where it should be
- [ ] Wings port `8080` reachable from the panel, and ideally nowhere else
- [ ] Game ports open in both `ufw` and the cloud security group
- [ ] Game traffic **not** proxied through Cloudflare
- [ ] `PANEL_URL` set to the real public URL
- [ ] `PANEL_URL_REQUIRED=true` if TLS ends at a proxy or tunnel

### Host

- [ ] SSH keys rotated; password login disabled
- [ ] Only the account running the panel is in the `docker` group
- [ ] `docker.sock` is not world-writable
- [ ] Node API secrets have never been copied off their nodes
- [ ] Unattended security updates on

## What the panel enforces

### JWT fail-closed

Under `NODE_ENV=production` the panel refuses to start when `JWT_SECRET` is
missing, shorter than 32 characters, or still the published default. The old
default was public, so anyone could forge an admin session with it.

### Registration tokens

Single use, `jtg_reg_` + 40 hex characters. Compared in constant time. Generating
a new token invalidates the previous one.

### Node API secrets

- Compared in constant time.
- Never returned by an API response — list endpoints strip them.
- Accepted **only** via `Authorization: Bearer`. A secret in the request body
  is rejected, so a secret cannot leak into a proxy log or a debug dump.
- Rate limited to 600 requests/minute per instance.

### Rate limits

| Endpoint | Limit |
| --- | --- |
| Node registration | 300/min |
| Node heartbeat | 600/min |

### File manager containment

Paths resolve inside the server's data directory. The leading slash is stripped;
`../` traversal, NUL bytes and anything escaping the directory are rejected with
`{"error":"Invalid path"}`. The file manager cannot read or write host files
outside the server it belongs to.

### Download safety

The Wings daemon is served as `wings.cjs` — an extension that browsers do not
execute — rather than `.js`. It is not linked from any page, and
`Content-Disposition` is set.

### TLS and proxy trust

`TRUST_PROXY` defaults to `false`. Setting it to `true` without a real proxy in
front lets clients spoof `X-Forwarded-For`.

## Trust boundaries

**The panel is fully trusted.** Anyone authenticated with an owner or admin
account can start containers, read files and run commands on any node. There is
no per-server permission model.

**A Wings node trusts the panel completely** and trusts nothing else on its
network for management. Its API secret grants full control of that machine's
Docker socket, i.e. root on the node.

**The Docker socket is root-equivalent.** Anyone who can reach it can start a
privileged container and take over the host. Never `chmod 666` it. Never expose
it over TCP without TLS and authentication.

## Rotating things

| What | How | Impact |
| --- | --- | --- |
| Owner password | Panel UI | That session |
| `JWT_SECRET` | Edit `.env`, `pm2 restart` | All sessions end |
| Node API secret | Delete node, re-create, re-run installer | Node must be re-registered |
| SSH key | Add new key, then remove the old | Existing sessions survive |
| Tunnel token | Cloudflare dashboard, re-run installer with the new one | Brief panel outage |

Rotating a leaked key is not optional. A private key that has been shared is a
full compromise of whatever it protected.

## Reporting a vulnerability

Report privately to the maintainers rather than in a public issue. Include
reproduction steps and the panel commit.

## Deployment-specific notes

**A Cloudflare Tunnel protects the web UI only.** It does not proxy game ports
or the Wings port. Players reach game servers directly.

**Loopback binding is only safe with a tunnel in front.** `BIND_ADDRESS=127.0.0.1`
means nothing on the network can reach the panel, which is the point — but also
means nothing can reach it at all if the tunnel is down. Check
`systemctl status cloudflared` when the site 502s.

**Minecraft EULA acceptance is automatic.** Wings writes `eula=true` before
creating a container, matching the sandbox backend. If you need explicit per-user
consent, add the toggle to your create-server form and send `build.eula`.