# Game servers

## Allocations

An allocation is one IP:port pair on a node that a server can be bound to.
Allocate a port before creating a server, or the panel rejects the create with:

```
WingsRequestError: Server creation failed on node node-1: allocation 13.206.218.155:25570 is not defined on this node
```

The node must actually know about the allocation. Wings syncs its allocation
list from the panel on every heartbeat, so a newly added port becomes usable
within seconds of the sync — not immediately.

Only allocate the ports you will use, and remember each one needs a firewall
rule and a cloud security-group rule.

## Creating a server

**Nodes → your node → Create Server**, or the main **Servers** page.

| Field | Notes |
| --- | --- |
| Name | Shown in the UI and used as the container name |
| Port | Must match an allocation on the chosen node |
| RAM | The container's `--memory` limit. Minecraft needs ~700 MB minimum |
| Disk | Recorded per server |
| Type | `PAPER`, `VANILLA`, `FORGE`, … or a generic app |
| Node | Which node runs it |

Runtime fields resolve in this order:

```
server.startupCommand → node.defaultInvocation → built-in default
server.dockerImage    → node.defaultImage      → image for the server type
server.ram            → node.memory
```

A server created before its node had an image inherits nothing useful and will
refuse to start with a clear message about the missing image or invocation
rather than a generic failure.

## Lifecycle

| Action | Endpoint | Notes |
| --- | --- | --- |
| Start | `POST /api/servers/:id/start` | |
| Stop | `POST /api/servers/:id/stop` | SIGTERM, then SIGKILL |
| Restart | `POST /api/servers/:id/restart` | |
| Kill | `POST /api/servers/:id/kill` | Immediate |
| Delete | `DELETE /api/servers/:id` | Removes the container and its data directory |

```bash
TOKEN=$(curl -s -X POST http://localhost:6767/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"..."}' | jq -r .token)

curl -s -X POST "http://localhost:6767/api/servers/$ID/start" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

A successful start returns `{"success":true,"startedAt":"..."}` and the status
becomes `online` within a few seconds.

Stop is bounded: Wings allows 10 seconds for a graceful exit before escalating
to SIGKILL, and the panel allows 45 seconds for the request. The grace period is
deliberately shorter than the request timeout so a slow shutdown returns a real
result instead of an opaque client timeout.

## Status values

| Value | Meaning |
| --- | --- |
| `online` | Container running |
| `offline` | Stopped, or the container exited |

## The EULA

Minecraft images refuse to boot until the EULA is accepted, so Wings writes
`eula=true` into the server's data directory before creating the container. A
record can opt out by sending `build.eula = false`.

> Accepting the Minecraft EULA on your users' behalf is a legal decision. The
> panel's sandbox backend has always done this automatically, and Wings now
> matches it. If your deployment needs explicit per-server consent, add the
> toggle to the create-server form and send `build.eula` from it.

## Console

Type in the server's console tab to send commands; output streams back over the
same panel.

```bash
curl -s "http://localhost:6767/api/servers/$ID/logs" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://localhost:6767/api/servers/$ID/command" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"command":"list"}'
```

Wings also writes to `docker logs` and to
`/var/lib/jtg-wings/servers/<uuid>/logs/`.

A container with no output — `sleep`, for example — returns empty logs. That is
correct, not a bug.

## File manager

| Action | Endpoint |
| --- | --- |
| List | `GET /api/servers/:id/files?path=/` |
| Read | `GET /api/servers/:id/files/download?path=/server.properties` |
| Save | `POST /api/servers/:id/files/save` |
| Create file | `POST /api/servers/:id/files/create` |
| Create directory | `POST /api/servers/:id/files/mkdir` |
| Rename | `POST /api/servers/:id/files/rename` |
| Delete | `DELETE /api/servers/:id/files` |
| Zip / unzip | `POST /api/servers/:id/files/zip`, `.../unzip` |
| Upload | `POST /api/servers/:id/files/upload` |

Save takes `{filePath, content}`; create takes `{filePath}`.

### Paths are relative to the server root

The leading slash is stripped, so `/`, `/plugins` and `plugins` all mean the
same thing: inside the server's data directory. There is no path that reaches
outside it.

`../` traversal, NUL bytes and anything resolving outside the server directory
are rejected with `{"error":"Invalid path"}`.

This is deliberate. The server directory is bind-mounted into the container at
`/data`, so the files you edit here are the files the game server reads. Editing
`/etc/passwd` on the host is not something the file manager can do.

## World management

`POST /api/servers/:id/world/analyze`, `.../world/import`, `GET .../world/info`.

## Backups

`GET/POST /api/servers/:id/backups` plus download and restore endpoints. Backups
are archives of the server data directory.

## Sizing

| Server type | Minimum RAM | Comfortable |
| --- | --- | --- |
| Vanilla / Paper, small world | 700 MB | 1.5 GB |
| Paper, several players | 1.5 GB | 3 GB |
| Forge modpack | 2 GB | 4 GB |

A container that exceeds its `--memory` limit is OOM-killed by the kernel. The
container exits with a non-zero code and the panel reports `offline`; check
`docker inspect --format '{{.State.OOMKilled}}' <container>` to confirm.

The host needs enough free RAM for the sum of all running servers plus Wings
itself, plus headroom.