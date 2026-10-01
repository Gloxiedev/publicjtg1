#!/usr/bin/env bash
# JTG Panel multi-node Wings integration suite.
#
# Usage: works/tests/multinode/run.sh
#
# Creates real Wings daemons on this host (ports 18081/18082, TLS 18443/18444),
# creates real containers, and tears everything down on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE="${JTG_TEST_BASE:-/tmp/opencode/multinode}"
export PANEL_URL="${PANEL_URL:-http://127.0.0.1:6767}"
export JTG_OWNER_USER="${JTG_OWNER_USER:-jtgowner}"
export JTG_OWNER_PASS="${JTG_OWNER_PASS:-jtgOwnerPass123}"

cd "$ROOT"

cleanup() {
  # Remove test containers and any Wings daemon this suite started.
  docker ps -aq --filter 'name=jtg-' | xargs -r docker rm -f >/dev/null 2>&1 || true
  pkill -f 'wings\.cjs' >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building test fixture image"
docker build -q -t jtg-test-gameserver:local works/tests/multinode/fixtures/gameserver >/dev/null

echo "==> type-checking"
npm run lint >/dev/null

echo "==> building panel"
npm run build >/dev/null

echo "==> running integration suite"
node works/tests/multinode/suite.mjs "$@"