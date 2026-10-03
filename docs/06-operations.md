# Operations

## Panel host

### Status and logs

```bash
pm2 status
pm2 logs jtg-main --lines 100
pm2 logs jtg-main --err              # errors only
pm2 describe jtg-main | grep -E 'status|restarts|memory'
tail -n 50 ~/.pm2/logs/jtg-main-error-0.log
curl -s localhost:6767/api/health
```

The panel runs under PM2 and is enabled at boot, so it comes back after a
reboot without intervention. Confirm with:

```bash
systemctl is-enabled pm2-root    # or pm2-<user>
systemctl status pm2-root --no-pager
```

### Resource limits

The installer sizes the PM2 memory limit and the Node heap ceiling from the
machine's RAM, never above 1 GB. On a host below 1536 MB it prints a warning,
because building the panel and then running it leaves little headroom.

### Health check

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6767/api/health
```

200 means serving. Use this as the target for any external monitor.

## Wings node

```bash
systemctl status wings --no-pager
systemctl restart wings
journalctl -u wings -f
journalctl -u wings --since "-10min"
ss -lntp | grep 8080
docker ps --format '{{.Names}} | {{.Status}} | {{.Ports}}'
```

### What Wings writes

| Path | Contents |
| --- | --- |
| `/etc/jtg-wings/wings.cjs` | Daemon binary, mode `700` |
| `/etc/jtg-wings/config.yml` | Config and API secret, mode `600` |
| `/var/lib/jtg-wings/servers/<uuid>/` | Server data, bind-mounted at `/data` |
| `/var/lib/jtg-wings/access.log` | JSONL request log, one line per API call |
| `/var/log/jtg-wings/` | Service logs |

The access log is the fastest way to see what the panel actually asked for:

```bash
tail -20 /var/lib/jtg-wings/access.log | jq '{at, method, path, status, ms}'
```

## Data locations

| Data | Path |
| --- | --- |
| Panel users, servers, nodes, allocations | `.data/*.json` |
| Panel secrets | `.env` |
| Server worlds and files | `/var/lib/jtg-wings/servers/<uuid>/` on the node |
| Backups | `backups/` by default |

## Backups

The panel's state is small. Two things matter: `.env` and `.data/`.

```bash
cd /opt/jtg
tar czf /root/jtg-$(date +%Y%m%d-%H%M%S).tgz .env .data
```

Server data lives on the nodes, so back each node up separately:

```bash
tar czf /root/wings-data-$(date +%Y%m%d).tgz -C /var/lib jtg-wings
```

Or take a backup through the API:

```bash
curl -s -X POST "http://localhost:6767/api/servers/$ID/backups" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

**Restore the panel** by dropping `.env` and `.data/` back in place and
restarting. A restore from a backup taken before the owner account existed will
have no owner — run `npm run createuser`.

## Upgrades

```bash
cd /opt/jtg
git fetch --all --prune
git reset --hard origin/main
npm install
npm run build
pm2 restart jtg-main
curl -s localhost:6767/api/health
```

`.env` and `.data/` are untouched by `git reset`.

The panel serves the current Wings daemon at `/api/wings/daemon.js`, but nodes
only re-download it when the installer runs. To update the daemon on a node
without re-registering:

```bash
curl -fsSL https://<panel>:6767/api/wings/daemon.js \
  | sudo tee /etc/jtg-wings/wings.cjs > /dev/null
sudo chmod 700 /etc/jtg-wings/wings.cjs
sudo systemctl restart wings
```

## Rotating the node API secret

Delete the node in the panel and re-create it, then re-run the installer on each
machine with the new token. There is no in-place rotation.

## Rotating the JWT secret

```bash
openssl rand -hex 32    # put the new value in .env
pm2 restart jtg-main
```

Every existing session is invalidated. Tell your admins to log in again.

## Monitoring

Worth watching:

| Signal | Where | Means |
| --- | --- | --- |
| `/api/health` non-200 | HTTP | Panel down |
| `pm2 status` restarts climbing | PM2 | Crash loop, often OOM |
| Node status `Offline` | Panel UI | Heartbeats stopped |
| Node heartbeat age growing | Panel UI | Network or daemon problem |
| `access.log` gaps | Node | Panel stopped calling |

```bash
# node heartbeat freshness
curl -s http://localhost:6767/api/nodes -H "Authorization: Bearer $TOKEN" \
  | jq '.[] | {name, status, lastHeartbeat}'
```

## Capacity

| Symptom | Fix |
| --- | --- |
| PM2 restart count climbing | OOM. Add swap or a bigger host |
| Gameservers OOM-killed | Raise the server's RAM, or the host's |
| Disk filling with worlds | Backups and `docker system df`; prune unused images |
| Wings restarting | `journalctl -u wings -b -p err` |

Add swap on a small panel host:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## Before handing a deployment to someone else

- [ ] Owner password rotated away from the installer's
- [ ] SSH keys rotated if any were ever shared
- [ ] `PANEL_URL` and `PANEL_URL_REQUIRED` set
- [ ] Test nodes, servers and temp files removed
- [ ] Backups taken and a restore actually tested