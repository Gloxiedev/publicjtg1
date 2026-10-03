# Nodes and Wings

A node is one machine running the Wings daemon. Wings owns the Docker socket on
that machine, creates and supervises game-server containers, and serves the file
and console APIs. The panel manages nodes and never touches that machine's
Docker directly.

## Adding a node

### 1. Create it in the panel

**Nodes → Create Wings Node**

| Field | Notes |
| --- | --- |
| Name | Label shown in the UI |
| Address / FQDN | The **public** address the **panel** uses to reach this node |
| Wings port | Default `8080` |
| Memory | Used as the default RAM for servers on this node |
| Disk | Default disk for servers |
| Runtime backend | `docker` |
| Default image | e.g. `itzg/minecraft-server:latest` |
| Default invocation | e.g. `java -Xms256M -Xmx{{SERVER_MEMORY}}M -jar server.jar` |

The address is deliberately the panel's view of the node. If the panel can only
reach the node over a private IP, put that private IP here — players do not go
through the panel at all.

The panel shows a registration token: `jtg_reg_` + 40 hex characters. **It works
once.** Generating a new one invalidates the old.

### 2. Install Wings on the node

```bash
curl -fsSL https://<panel>:6767/api/wings/install | sudo bash -s -- jtg_reg_<token>
```

From GitHub instead, with the panel URL explicit:

```bash
curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/src/wings/wings-install.sh \
  | sudo bash -s -- jtg_reg_<token> --panel https://<panel>:6767
```

`sudo` is required — the script exits immediately otherwise. The panel URL can
also come from the environment: `PANEL_URL=https://panel:6767 bash wings-install.sh ...`

### Installer options

| Flag | Default | Notes |
| --- | --- | --- |
| `--panel <url>` | — | Panel base URL. Required when not downloaded from the panel. |
| `--port <port>` | `8080` | Wings API port |
| `--dir <path>` | `/etc/jtg-wings` | Install directory |
| `--data-dir <path>` | `/var/lib/jtg-wings` | Server data |
| `--log-dir <path>` | `/var/log/jtg-wings` | Logs |
| `--no-daemon` | service | Run in the foreground, for debugging |
| `--local-test` | off | No sudo, no systemd, no packages. Testing only. |

### What it installs

| Path | Contents |
| --- | --- |
| `/etc/jtg-wings/wings.cjs` | The daemon, mode `700` |
| `/etc/jtg-wings/config.yml` | Node config and API secret, mode `600` |
| `/var/lib/jtg-wings/servers/<uuid>/` | Per-server data, world files, `logs/` |
| `/etc/systemd/system/wings.service` | The systemd unit |

Node 20+ and Docker are installed if missing. The installer validates the
distribution, validates the port range, checks the daemon is non-empty and
parses with `node --check`, and verifies the service actually reached a
listening state before reporting success.

Releases before `983c648` installed `jtg-wings.service`. That name still works
as an alias, so `systemctl status jtg-wings` keeps working.

### 3. Open the firewall

On the node, and in the cloud security group:

```bash
ufw allow 8080/tcp      # panel → Wings
ufw allow 25565/tcp     # players → game (and every other game port you allocate)
```

## Networking

### Panel → Wings

Outbound from the panel to the node's registered address on the Wings port. If
the panel is behind a tunnel and the node is public, use the node's public
address. If both are private, use the private address.

### Wings → panel

Only for registration, heartbeats and config refresh, to the URL in
`config.yml`. Not required to be inbound-reachable.

### Players → Wings

Inbound to game ports on the node. **Not** through Cloudflare proxying — Cloudflare
does not proxy arbitrary game ports. DNS-only ("grey cloud") records are fine.

### Cloud NAT

If the address you registered is not configured on the node's interfaces — an AWS
Elastic IP, a GCP external IP, anything behind a NAT gateway — Docker cannot bind
it and fails with:

```
failed to bind host port 13.206.218.155:25565/tcp: cannot assign requested address
```

Wings detects this and publishes game ports on `0.0.0.0` instead, logging:

```
allocation 13.206.218.155 is not configured on this host; publishing game ports on 0.0.0.0 instead
```

The port is still reachable through the NAT. Nothing to configure.

## Node status

| Status | Meaning |
| --- | --- |
| **Online** | Heartbeat received within `offline_threshold` (90s default) |
| **Offline** | Heartbeats stopped |
| **Installing** | Created, Wings has not registered yet |
| **Error** | Registered and installed, but has never sent a heartbeat |

The node card shows measured CPU, RAM and disk, allocated capacity, server
counts, heartbeat age, Wings version, uptime, architecture and backend. It
refreshes every 15 seconds.

## Editing a node

**Nodes → your node → Edit runtime settings** changes backend, image, invocation,
memory and disk. Changes apply to a running Wings within one heartbeat.

**Nodes → your node → Regenerate token** issues a new token. The old one stops
working, but the node stays connected until you re-run the installer on it.

## Operating a node

```bash
systemctl status wings --no-pager
systemctl restart wings
journalctl -u wings -f
journalctl -u wings --since "-10min"
ss -lntp | grep 8080
```

Logs for a specific server:

```bash
tail -f /var/lib/jtg-wings/servers/<uuid>/logs/output.log
docker logs -f jtg-<node-prefix><server-prefix>
```

## Uninstalling

There is no uninstall script yet. To remove a node cleanly:

```bash
systemctl stop wings
systemctl disable wings
rm -f /etc/systemd/system/wings.service /etc/systemd/system/jtg-wings.service
systemctl daemon-reload
```

Then delete the node in the panel. Server data lives in `/var/lib/jtg-wings` and
Docker volumes; remove those by hand if you want the disk back:

```bash
rm -rf /var/lib/jtg-wings
docker ps -a --filter "name=jtg-"        # review before deleting
```

Deleting the node in the panel does not clean up the machine, so do both.

## Testing without a second machine

```bash
bash src/wings/wings-install.sh --local-test
```

No sudo, no systemd, no packages. Everything is written under `--dir` and Wings
runs as a background process. Intended for the integration suite, not for
production.