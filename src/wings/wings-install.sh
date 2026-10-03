#!/bin/bash
# JTG Panel - Wings node installer
#
# Usage:
#   curl -fsSL <panel>/api/wings/install | sudo bash -s -- <REGISTRATION_TOKEN>
#   curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/src/wings/wings-install.sh \
#     | sudo bash -s -- <REGISTRATION_TOKEN> --panel <PANEL_URL>
#
# Production (default): installs dependencies with sudo and registers a systemd
# service named "wings". The installer verifies the service actually reached a
# listening state instead of trusting the enable command.
# --local-test: no sudo, no systemd, no package installation. Everything is written under
#               --dir and Wings runs as a background process. Local integration testing only.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

die() { echo -e "${RED}$*${NC}" >&2; exit 1; }
warn() { echo -e "${YELLOW}$*${NC}" >&2; }
info() { echo -e "${CYAN}$*${NC}"; }
ok() { echo -e "${GREEN}$*${NC}"; }

SERVICE_NAME="wings"
LEGACY_SERVICE_NAME="jtg-wings"
LEGACY_UNIT="/etc/systemd/system/${LEGACY_SERVICE_NAME}.service"
MIN_NODE_MAJOR=20

echo -e "${CYAN}===========================================${NC}"
echo -e "${CYAN}       JTG Panel Wings Node Installer      ${NC}"
echo -e "${CYAN}===========================================${NC}"

LOCAL_TEST=0
INSTALL_DIR="/etc/jtg-wings"
DATA_DIR="/var/lib/jtg-wings"
LOG_DIR="/var/log/jtg-wings"
START_MODE="service"
OVERRIDE_PORT=""
TOKEN=""
# Substituted with the real panel address when the panel serves this script. A
# copy fetched straight from GitHub still carries the placeholder, so --panel or
# PANEL_URL in the environment supplies it instead.
PANEL_URL="${PANEL_URL:-@PANEL_URL@}"

usage() {
  echo "Usage: wings-install.sh [REGISTRATION_TOKEN] [options]"
  echo ""
  echo "  --local-test        Local integration-test mode: no sudo, no systemd and no"
  echo "                      package installation. Writes everything under --dir and"
  echo "                      starts Wings as a background process. Local testing only."
  echo "  --dir <path>        Wings install directory (default /etc/jtg-wings)"
  echo "  --data-dir <path>   Wings data directory (default /var/lib/jtg-wings)"
  echo "  --log-dir <path>    Wings log directory (default /var/log/jtg-wings)"
  echo "  --port <port>       Override the Wings API port"
  echo "  --panel <url>       Panel base URL. Required when this script was not"
  echo "                      downloaded from <panel>/api/wings/install"
  echo "  --no-daemon         Run Wings in the foreground instead of as a service"
  echo "  --help              Show this help"
}

need_arg() {
  # Guards "$2" so a trailing flag without its value fails loudly instead of
  # silently consuming the next option under "set -u".
  [ "$#" -ge 2 ] && [ -n "${2:-}" ] || die "Option $1 requires a value."
}

while [ $# -gt 0 ]; do
  case "$1" in
    # `curl ... | bash -s -- TOKEN` forwards the `--` separator to this script.
    --) shift ;;
    --local-test) LOCAL_TEST=1; shift ;;
    --dir) need_arg "$@"; INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) need_arg "$@"; DATA_DIR="$2"; shift 2 ;;
    --log-dir) need_arg "$@"; LOG_DIR="$2"; shift 2 ;;
    --port) need_arg "$@"; OVERRIDE_PORT="$2"; shift 2 ;;
    --panel|--panel-url) need_arg "$@"; PANEL_URL="$2"; shift 2 ;;
    --no-daemon) START_MODE="foreground"; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) die "Unknown option: $1" ;;
    *) TOKEN="$1"; shift ;;
  esac
done

# The old check accepted 99999; validate the real TCP range.
if [ -n "$OVERRIDE_PORT" ] && ! { [ "$OVERRIDE_PORT" -ge 1 ] 2>/dev/null && [ "$OVERRIDE_PORT" -le 65535 ] 2>/dev/null; }; then
  die "--port must be a number between 1 and 65535 (got '$OVERRIDE_PORT')."
fi

PANEL_URL="${PANEL_URL%/}"
case "$PANEL_URL" in
  ""|@PANEL_URL@)
    die "Panel URL is not set. Pass --panel https://your-panel.example.com, or set PANEL_URL." ;;
  http://*|https://*) ;;
  *) die "Panel URL must start with http:// or https:// (got '$PANEL_URL')." ;;
esac

if [ -z "$TOKEN" ] && [ -t 0 ]; then
  echo -ne "${YELLOW}Enter Node Registration Token: ${NC}"
  read -r TOKEN
fi

[ -n "$TOKEN" ] || die "Registration token is required."
echo "$TOKEN" | grep -Eq '^jtg_reg_[a-f0-9]{40}$' || die "Registration token format is invalid."

if [ "$LOCAL_TEST" = "1" ]; then
  echo -e "${YELLOW}*** LOCAL TEST MODE ***${NC}"
  echo -e "${YELLOW}No packages installed, no sudo, no systemd. Local testing only.${NC}"
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

[ "$OS" = "linux" ] || die "Error: Wings installer only supports Linux OS (detected '$OS')."

case "$ARCH" in
  x86_64) WINGS_ARCH="amd64" ;;
  aarch64|arm64) WINGS_ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

if [ "$LOCAL_TEST" = "0" ]; then
  [ "$(id -u)" -eq 0 ] || die "Run this installer as root (or via sudo)."
  command -v systemctl > /dev/null 2>&1 || die "systemd is required; this host has no systemctl."

  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_VERSION="${VERSION_ID:-unknown}"
    case "$DISTRO_ID" in
      debian|ubuntu) PKG_APT=1 ;;
      rhel|centos|rocky|almalinux|ol|fedora) PKG_APT=0 ;;
      *) die "Unsupported distribution '$DISTRO_ID' ($DISTRO_VERSION). Install Debian/Ubuntu, RHEL, CentOS, Rocky or AlmaLinux manually." ;;
    esac
  else
    die "Cannot identify the distribution: /etc/os-release is missing."
  fi
  info "Detected $DISTRO_ID $DISTRO_VERSION ($WINGS_ARCH)"
fi

port_in_use() {
  # Reports the port as in use only when another process is bound to it.
  if command -v ss > /dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${1}\$"
  else
    return 1
  fi
}

install_dependencies() {
  info "Installing dependencies (curl, nodejs, docker, systemd)..."

  if [ "$PKG_APT" = "1" ]; then
    DEBIAN_FRONTEND=noninteractive sudo apt-get update -qq ||
      die "apt-get update failed; cannot install dependencies."
    DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq curl ca-certificates ||
      die "Failed to install curl/ca-certificates via apt."
  else
    sudo yum install -y -q curl ca-certificates ||
      die "Failed to install curl/ca-certificates via yum."
  fi

  if ! command -v node > /dev/null 2>&1; then
    info "Node.js not found; installing Node.js ${MIN_NODE_MAJOR}.x"
    if [ "$PKG_APT" = "1" ]; then
      curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash - > /dev/null ||
        die "Failed to add the NodeSource repository."
    else
      curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash - > /dev/null ||
        die "Failed to add the NodeSource repository."
    fi
    if [ "$PKG_APT" = "1" ]; then
      DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq nodejs ||
        die "Failed to install Node.js from NodeSource."
    else
      sudo yum install -y -q nodejs || die "Failed to install Node.js from NodeSource."
    fi
  fi

  NODE_BIN="$(command -v node)"
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] ||
    die "Node.js ${MIN_NODE_MAJOR}+ is required (found $("$NODE_BIN" --version))."

  # Docker is optional at install time: Wings still runs when no container
  # workload exists yet, so only warn instead of failing the whole install.
  if ! command -v docker > /dev/null 2>&1; then
    if [ "$PKG_APT" = "1" ]; then
      DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq docker.io > /dev/null 2>&1 || true
    else
      sudo yum install -y -q docker > /dev/null 2>&1 || true
    fi
  fi
  if command -v systemctl > /dev/null 2>&1 && command -v docker > /dev/null 2>&1; then
    # Deliberately not fatal: an unreachable Docker must not block node setup.
    sudo systemctl enable --now docker > /dev/null 2>&1 ||
      warn "Could not start Docker. Wings is installed, but container workloads will fail until Docker is running."
  fi
}

if [ "$LOCAL_TEST" = "0" ]; then
  install_dependencies
fi

command -v node > /dev/null 2>&1 || die "Error: node is required to run Wings but was not found."
command -v curl > /dev/null 2>&1 || die "Error: curl is required to download the Wings daemon."

NODE_BIN="$(command -v node)"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

info "Registering node with JTG Panel at $PANEL_URL..."
RESP_FILE="$WORK_DIR/register.json"
HTTP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' -X POST "${PANEL_URL}/api/wings/register" \
  -H "Content-Type: application/json" \
  -d "{\"registrationToken\":\"${TOKEN}\"}" || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  die "Registration failed (HTTP $HTTP_CODE)! Panel response: $(cat "$RESP_FILE" 2>/dev/null || echo '<no response body>')"
fi

node -e '
const fs = require("fs");
let d;
try {
  d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
} catch (err) {
  console.error("panel returned a response that is not valid JSON");
  process.exit(1);
}
if (d.success !== true) {
  console.error("registration response was not successful");
  process.exit(1);
}
const out = {
  NODE_ID: d.nodeId || "",
  NODE_UUID: d.uuid || "",
  API_SECRET: d.apiSecret || "",
  WINGS_PORT: String(d.wingsPort || 8080),
  PROTOCOL: d.protocol || "http",
  NODE_NAME: String(d.name || "node").replace(/[\r\n\t ]+/g, "-"),
  NODE_CONFIG: d.nodeConfigYaml || ""
};
if (!out.NODE_ID || !out.API_SECRET) {
  console.error("registration response was malformed");
  process.exit(1);
}
if (!/^[0-9]{1,5}$/.test(out.WINGS_PORT) || Number(out.WINGS_PORT) < 1 || Number(out.WINGS_PORT) > 65535) {
  console.error("panel returned an invalid wings port: " + out.WINGS_PORT);
  process.exit(1);
}
fs.mkdirSync(process.argv[2], { recursive: true });
for (const [key, value] of Object.entries(out)) {
  fs.writeFileSync(process.argv[2] + "/" + key, value, { mode: 0o600 });
}
' "$RESP_FILE" "$WORK_DIR"

NODE_ID=$(cat "$WORK_DIR/NODE_ID")
NODE_UUID=$(cat "$WORK_DIR/NODE_UUID")
API_SECRET=$(cat "$WORK_DIR/API_SECRET")
WINGS_PORT=$(cat "$WORK_DIR/WINGS_PORT")
PROTOCOL=$(cat "$WORK_DIR/PROTOCOL")
NODE_NAME=$(cat "$WORK_DIR/NODE_NAME")
NODE_CONFIG=$(cat "$WORK_DIR/NODE_CONFIG")

if [ -n "$OVERRIDE_PORT" ]; then
  if [ "$OVERRIDE_PORT" != "$WINGS_PORT" ]; then
    warn "Using --port $OVERRIDE_PORT instead of the panel-assigned port $WINGS_PORT."
    warn "Update the node's port in the panel too, otherwise Wings will be reported offline."
  fi
  WINGS_PORT="$OVERRIDE_PORT"
fi

ok "Node registered: id=$NODE_ID uuid=$NODE_UUID port=$WINGS_PORT"

# Refuse to overwrite a healthy install with a broken download.
if port_in_use "$WINGS_PORT" && [ "$LOCAL_TEST" = "1" ]; then
  die "Port $WINGS_PORT is already in use. Stop the process using it and retry."
fi

if [ "$LOCAL_TEST" = "1" ]; then
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
  chmod 700 "$INSTALL_DIR" 2>/dev/null || true
  curl -fsSL "${PANEL_URL}/api/wings/daemon.js" -o "$INSTALL_DIR/wings.cjs" ||
    die "Failed to download the Wings daemon from ${PANEL_URL}/api/wings/daemon.js."
  chmod 700 "$INSTALL_DIR/wings.cjs" 2>/dev/null || true
  CONFIG_PATH="$INSTALL_DIR/config.yml"
else
  sudo mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
  sudo chmod 700 "$INSTALL_DIR"
  curl -fsSL "${PANEL_URL}/api/wings/daemon.js" | sudo tee "$INSTALL_DIR/wings.cjs" > /dev/null ||
    die "Failed to download the Wings daemon from ${PANEL_URL}/api/wings/daemon.js."
  sudo chmod 700 "$INSTALL_DIR/wings.cjs"
  CONFIG_PATH="$INSTALL_DIR/config.yml"
fi

DAEMON_PATH="$INSTALL_DIR/wings.cjs"

# Integrity check: a truncated or error-page download would otherwise start a
# service that dies on the first heartbeat.
[ -s "$DAEMON_PATH" ] || die "Downloaded Wings daemon is empty ($DAEMON_PATH)."
"$NODE_BIN" --check "$DAEMON_PATH" 2>/dev/null ||
  die "Downloaded Wings daemon is not valid JavaScript; refusing to install it."

cat > "$WORK_DIR/config.yml" <<EOF
debug: false
panel_url: "$PANEL_URL"
node_id: "$NODE_ID"
uuid: "$NODE_UUID"
api_secret: "$API_SECRET"
port: $WINGS_PORT
data_dir: "$DATA_DIR"
EOF

if [ -n "$NODE_CONFIG" ]; then
  printf '%s\n' "$NODE_CONFIG" >> "$WORK_DIR/config.yml"
fi

if [ "$LOCAL_TEST" = "1" ]; then
  cp "$WORK_DIR/config.yml" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
else
  sudo cp "$WORK_DIR/config.yml" "$CONFIG_PATH"
  sudo chmod 600 "$CONFIG_PATH"
fi

if [ "$START_MODE" = "foreground" ]; then
  ok "Starting Wings in the foreground (Ctrl-C to stop)..."
  exec "$NODE_BIN" "$DAEMON_PATH" --config "$CONFIG_PATH"
fi

# Waits for the port to accept connections and confirms the daemon really is up,
# rather than trusting that "systemctl start" returned 0.
verify_wings_started() {
  local pid="$1" port="$2" attempt=1 max_attempts=30 label="$3"
  while [ "$attempt" -le "$max_attempts" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if port_in_use "$port"; then
      ok "$label is listening on port $port."
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

if [ "$LOCAL_TEST" = "1" ]; then
  info "Starting Wings as a background process (no systemd in local test mode)..."
  PID_FILE="$INSTALL_DIR/wings.pid"
  LOG_FILE="$LOG_DIR/wings.log"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    sleep 1
  fi
  nohup "$NODE_BIN" "$DAEMON_PATH" --config "$CONFIG_PATH" > "$LOG_FILE" 2>&1 &
  WINGS_PID=$!
  echo "$WINGS_PID" > "$PID_FILE"

  if ! verify_wings_started "$WINGS_PID" "$WINGS_PORT" "Wings"; then
    echo -e "${RED}Wings failed to start. Last log lines:${NC}"
    tail -n 20 "$LOG_FILE" || true
    exit 1
  fi
  ok "Wings started (pid $WINGS_PID). Logs: $LOG_FILE"
else
  # Migrate installs created before the unit was renamed: the legacy unit is
  # replaced, and Alias= keeps "systemctl status jtg-wings" working for anyone
  # (or any script) still using the old name.
  if [ -f "$LEGACY_UNIT" ]; then
    info "Migrating legacy ${LEGACY_SERVICE_NAME}.service to ${SERVICE_NAME}.service"
    sudo systemctl disable --now "$LEGACY_SERVICE_NAME" > /dev/null 2>&1 || true
    sudo rm -f "$LEGACY_UNIT"
  fi

  info "Creating the JTG Wings systemd service (${SERVICE_NAME}.service)..."
  sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<UNIT
[Unit]
Description=JTG Panel Wings Node Daemon
Documentation=https://github.com/Gloxiedev/publicjtg1
After=docker.service network-online.target
Wants=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $DAEMON_PATH --config $CONFIG_PATH
Restart=always
RestartSec=5
LimitNOFILE=65535
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=multi-user.target
Alias=${LEGACY_SERVICE_NAME}.service
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME" > /dev/null 2>&1 ||
    die "Could not enable ${SERVICE_NAME}.service; it will not start after a reboot."
  sudo systemctl restart "$SERVICE_NAME" > /dev/null 2>&1 ||
    die "systemctl restart ${SERVICE_NAME} failed. Journal: $(sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager | tail -n 20)"

  sleep 2
  if [ "$(sudo systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)" != "active" ]; then
    echo -e "${RED}${SERVICE_NAME}.service is not active after restart. Journal output:${NC}"
    sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
    exit 1
  fi

  SERVICE_PID="$(sudo systemctl show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || true)"
  if [ -z "$SERVICE_PID" ] || [ "$SERVICE_PID" = "0" ]; then
    die "${SERVICE_NAME}.service is active but has no main PID. Journal: $(sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager)"
  fi

  if ! verify_wings_started "$SERVICE_PID" "$WINGS_PORT" "Wings"; then
    echo -e "${RED}${SERVICE_NAME}.service started but Wings is not listening on port ${WINGS_PORT}.${NC}"
    echo -e "${RED}Journal output:${NC}"
    sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
    exit 1
  fi

  # Restart persistence: a unit that only starts once after install would still
  # look healthy here while dying later.
  info "Confirming ${SERVICE_NAME}.service restarts cleanly..."
  sudo systemctl restart "$SERVICE_NAME" > /dev/null 2>&1 ||
    die "${SERVICE_NAME}.service failed to restart."
  sleep 2
  if [ "$(sudo systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)" != "active" ]; then
    die "${SERVICE_NAME}.service is not active after a restart test."
  fi

  if command -v ufw > /dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    if sudo ufw status 2>/dev/null | grep -Eq "^${WINGS_PORT}/tcp"; then
      ok "Firewall already allows ${WINGS_PORT}/tcp."
    else
      sudo ufw allow "${WINGS_PORT}/tcp" > /dev/null 2>&1 &&
        ok "Firewall opened for ${WINGS_PORT}/tcp (Wings API)."
    fi
    echo -e "${YELLOW}Game ports must be opened separately with: ufw allow <port>/tcp${NC}"
  fi

  ok "Wings service started and verified (${SERVICE_NAME}.service)."
fi

echo ""
ok "==========================================="
ok " JTG Wings Node configured successfully!  "
ok "==========================================="
ok "   Node name    : $NODE_NAME"
ok "   Node id      : $NODE_ID"
ok "   API endpoint : $PROTOCOL://<this-host>:$WINGS_PORT"
ok "   Config       : $CONFIG_PATH"
ok "   Data dir     : $DATA_DIR"
ok "   Service      : ${SERVICE_NAME}.service"
ok "==========================================="
echo "The node turns ONLINE in the panel after its first heartbeat."
echo "Check status with: systemctl status ${SERVICE_NAME}   (logs: journalctl -u ${SERVICE_NAME})"