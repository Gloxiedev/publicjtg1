# Multi-node Wings integration suite

End-to-end verification that the Panel can drive **two independent Wings nodes** on
one host, with no second VPS and no public IPv4.

```bash
works/tests/multinode/run.sh
```

## What it does

Every phase uses real processes, real HTTP, and real containers. Nothing is stubbed.

| Phase | What it proves |
| --- | --- |
| 1 | A fresh panel has zero nodes, zero servers, and no pre-seeded localhost node |
| 2 | Node 1 is created through `POST /api/nodes` and installed by running the panel's own `curl ... /api/wings/install \| bash` command |
| 3 | Node 2 installs as a genuinely separate process, config, UUID, and access log |
| 4 | Each node accepts only its own API secret; cross-node and unauthenticated calls are rejected |
| 5 | Servers created on each node land in that node's own data directory, with allocations bound |
| 6 | Real lifecycle: start, stop, restart, kill, console command, logs, stats — verified by real listening ports and real log output |
| 7 | A port outside a node's allocation list is rejected; deleting a server releases its allocation |
| 8 | Killing a daemon flips the node to OFFLINE; reinstalling recovers it. A node is never ONLINE without a fresh heartbeat |
| 9 | HTTPS node with a real certificate, validated against a local CA. Plaintext and untrusted-CA clients are rejected |
| 10 | Full reset and repeat, proving no state carries over between runs |
| 11 | The Panel's own pages are served |

## Layout

- `run.sh` — builds, type-checks, and runs the suite; cleans up on exit
- `suite.mjs` — the phases
- `harness.mjs` — panel lifecycle, port checks, log parsing
- `node.mjs` — node creation and installation
- `tls.mjs` — generates the throwaway CA and node certificates on first run
- `lib.mjs` — result recording and the summary table
- `fixtures/gameserver/` — a real Node.js workload used as the game server

## Notes

- Ports `18081`/`18082` (Wings APIs), `18443`/`18444` (TLS Wings APIs), and
  `25565`/`25566`/`25575`/`25576`/`25665` (game ports) are used.
- `node1.localhost` and `node2.localhost` resolve to `::1`; the daemons bind dual-stack.
- TLS uses a throwaway CA in `$BASE/tls`, generated automatically by `tls.mjs` on
  first run (`openssl` must be on `PATH`). Certificate verification is **never**
  disabled — `NODE_TLS_REJECT_UNAUTHORIZED` is not set anywhere. The CA is passed to
  the panel as `NODE_EXTRA_CA_CERTS` and supplied explicitly by the suite client.
- This is a single-host test. It is not evidence of behaviour across a real network
  boundary or on a real VPS.
