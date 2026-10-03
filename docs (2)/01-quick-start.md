# Quick start

Goal: a running panel you can log into, with one Wings node and one game server
on it.

## 1. Install the panel

On the panel host:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh)
```

The installer asks how you want the panel exposed. For a first pass, choose
**direct** and let it bind `0.0.0.0`.

Unattended, with your own owner credentials:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \
  --yes --exposure direct --owner-user owner --owner-pass 'choose-something-real'
```

When it finishes it prints the owner username and password. **Write them
down.** They are the only way in.

> The clean-install path generates a random owner password and prints it. If you
> ever re-run the installer with `rm -rf .data`, the old account is gone and a
> new one is created.

## 2. Confirm it is alive

```bash
curl -s localhost:6767/api/health
pm2 status
```

`/api/health` returns HTTP 200 and PM2 shows `jtg-main` as `online`.

Open `http://<panel-ip>:6767` in a browser and log in.

## 3. Create a node

In the panel: **Nodes → Create Wings Node**.

| Field | Value |
| --- | --- |
| Name | Anything, e.g. `node-1` |
| Address | The **public** IP or hostname the *panel* uses to reach this node |
| Wings port | `8080` |
| Runtime backend | `docker` |
| Default image | `itzg/minecraft-server:latest` |
| Default invocation | `java -Xms256M -Xmx{{SERVER_MEMORY}}M -jar server.jar` |

The runtime backend, image and invocation set here apply to every server on the
node. Copy the registration token the panel shows — it looks like
`jtg_reg_` followed by 40 hex characters and works **once**.

## 4. Install Wings on the node

On the node host:

```bash
curl -fsSL https://<panel-host>:6767/api/wings/install | sudo bash -s -- jtg_reg_<token>
```

To fetch the script straight from GitHub instead:

```bash
curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/src/wings/wings-install.sh \
  | sudo bash -s -- jtg_reg_<token> --panel https://<panel-host>:6767
```

`sudo` is required. The installer installs Node 20+, downloads the daemon to
`/etc/jtg-wings/wings.cjs`, writes `/etc/jtg-wings/config.yml` (mode `600`) and
starts `wings.service`. It verifies the service actually reached a listening
state before reporting success.

Verify on the node:

```bash
systemctl status wings --no-pager
ss -lntp | grep 8080
```

The node flips to **ONLINE** in the panel within a heartbeat.

## 5. Open the firewall

On the node, and in the cloud security group:

```bash
ufw allow 8080/tcp     # panel → Wings
ufw allow 25565/tcp    # players → game
```

Cloud NAT is handled automatically: if the address you registered is not
configured on the node (an AWS Elastic IP, for example), Wings publishes game
ports on `0.0.0.0` instead and logs a warning. The port is still reachable
through the NAT.

## 6. Deploy a game server

**Nodes → your node → Create Server**.

Pick the server type, RAM, and a port. Allocate an unused port on the node
first. Then start it.

Expected: `POST /api/servers/:id/start` returns 200, status becomes `online`
within a few seconds, and the port is listening.

If the server exits immediately, read its console in the UI or
`docker logs <container>` — the common causes are in
[08-troubleshooting.md](08-troubleshooting.md).

## 7. Point players at it

The address is whatever players can reach on the node's game port — often the
node's public IP, or a DNS record you control. Do **not** proxy game traffic
through Cloudflare's orange cloud; it does not proxy arbitrary game ports.

## Next steps

- [07-security.md](07-security.md) — the hardening checklist
- [06-operations.md](06-operations.md) — backups and upgrades