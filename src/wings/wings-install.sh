#!/bin/bash
# JTG Panel - Wings node installer
#
# Usage:
#   curl -fsSL <panel>/api/wings/install | bash -s -- <REGISTRATION_TOKEN> [options]
#
# Production (default): installs dependencies with sudo and registers a systemd service.
# --local-test: no sudo, no systemd, no package installation. Everything is written under
#               --dir and Wings runs as a background process. Local integration testing only.
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

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
  echo "  --no-daemon         Run Wings in the foreground instead of as a service"
  echo "  --help              Show this help"
}

while [ $# -gt 0 ]; do
  case "$1" in
    # `curl ... | bash -s -- TOKEN` forwards the `--` separator to this script.
    --) shift ;;
    --local-test) LOCAL_TEST=1; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --port) OVERRIDE_PORT="$2"; shift 2 ;;
    --no-daemon) START_MODE="foreground"; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) echo -e "${RED}Unknown option: $1${NC}"; usage; exit 1 ;;
    *) TOKEN="$1"; shift ;;
  esac
done

if [ -n "$OVERRIDE_PORT" ] && ! echo "$OVERRIDE_PORT" | grep -Eq '^[0-9]{1,5}$'; then
  echo -e "${RED}--port must be a number between 1 and 65535.${NC}"
  exit 1
fi

if [ -z "$TOKEN" ] && [ -t 0 ]; then
  echo -ne "${YELLOW}Enter Node Registration Token: ${NC}"
  read TOKEN
fi

if [ -z "$TOKEN" ]; then
  echo -e "${RED}Registration token is required.${NC}"
  exit 1
fi

if ! echo "$TOKEN" | grep -Eq '^jtg_reg_[a-f0-9]{40}$'; then
  echo -e "${RED}Registration token format is invalid.${NC}"
  exit 1
fi

PANEL_URL="@PANEL_URL@"

if [ "$LOCAL_TEST" = "1" ]; then
  echo -e "${YELLOW}*** LOCAL TEST MODE ***${NC}"
  echo -e "${YELLOW}No packages installed, no sudo, no systemd. Local testing only.${NC}"
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$OS" != "linux" ]; then
  echo -e "${RED}Error: Wings installer only supports Linux OS.${NC}"
  exit 1
fi

case "$ARCH" in
  x86_64) WINGS_ARCH="amd64" ;;
  aarch64|arm64) WINGS_ARCH="arm64" ;;
  *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
esac

if [ "$LOCAL_TEST" = "0" ]; then
  echo -e "${CYAN}-> Installing dependencies (curl, nodejs, docker, systemd)...${NC}"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates nodejs docker.io >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y -q curl ca-certificates nodejs docker >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1 || true
    sudo apt-get install -y -qq nodejs >/dev/null 2>&1 || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now docker >/dev/null 2>&1 || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Error: node is required to run Wings but was not found.${NC}"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo -e "${RED}Error: curl is required to download the Wings daemon.${NC}"
  exit 1
fi

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo -e "${CYAN}-> Registering node with JTG Panel at $PANEL_URL...${NC}"
RESP_FILE="$WORK_DIR/register.json"
HTTP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' -X POST "${PANEL_URL}/api/wings/register" \
  -H "Content-Type: application/json" \
  -d "{\"registrationToken\":\"${TOKEN}\"}" || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${RED}Registration failed (HTTP $HTTP_CODE)!${NC}"
  echo -e "${RED}Panel response: $(cat "$RESP_FILE" 2>/dev/null)${NC}"
  exit 1
fi

node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
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
fs.mkdirSync(process.argv[2], { recursive: true });
for (const [key, value] of Object.entries(out)) {
  fs.writeFileSync(process.argv[2] + "/" + key, value);
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
  WINGS_PORT="$OVERRIDE_PORT"
fi

echo -e "${GREEN}Node registered: id=$NODE_ID uuid=$NODE_UUID port=$WINGS_PORT${NC}"

if [ "$LOCAL_TEST" = "1" ]; then
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
  chmod 700 "$INSTALL_DIR" 2>/dev/null || true
  curl -fsSL "${PANEL_URL}/api/wings/daemon.js" -o "$INSTALL_DIR/wings.cjs"
  chmod 700 "$INSTALL_DIR/wings.cjs" 2>/dev/null || true
  CONFIG_PATH="$INSTALL_DIR/config.yml"
else
  sudo mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
  curl -fsSL "${PANEL_URL}/api/wings/daemon.js" | sudo tee "$INSTALL_DIR/wings.cjs" >/dev/null
  sudo chmod 700 "$INSTALL_DIR/wings.cjs"
  CONFIG_PATH="$INSTALL_DIR/config.yml"
fi

DAEMON_PATH="$INSTALL_DIR/wings.cjs"

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
  echo -e "${GREEN}Starting Wings in the foreground (Ctrl-C to stop)...${NC}"
  exec node "$DAEMON_PATH" --config "$CONFIG_PATH"
fi

if [ "$LOCAL_TEST" = "1" ]; then
  echo -e "${CYAN}-> Starting Wings as a background process (no systemd in local test mode)...${NC}"
  PID_FILE="$INSTALL_DIR/wings.pid"
  LOG_FILE="$LOG_DIR/wings.log"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    sleep 1
  fi
  nohup node "$DAEMON_PATH" --config "$CONFIG_PATH" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo -e "${RED}Wings failed to start. Last log lines:${NC}"
    tail -n 20 "$LOG_FILE" || true
    exit 1
  fi
  echo -e "${GREEN}Wings started (pid $(cat "$PID_FILE")). Logs: $LOG_FILE${NC}"
else
  echo -e "${CYAN}-> Creating the JTG Wings systemd service...${NC}"
  sudo tee /etc/systemd/system/jtg-wings.service >/dev/null <<UNIT
[Unit]
Description=JTG Panel Wings Node Daemon
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/env node $DAEMON_PATH --config $CONFIG_PATH
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable --now jtg-wings
  sudo systemctl restart jtg-wings
  echo -e "${GREEN}Wings service started (jtg-wings.service).${NC}"
fi

echo ""
echo -e "${GREEN}===========================================${NC}"
echo -e "${GREEN} JTG Wings Node configured successfully!  ${NC}"
echo -e "${GREEN}   Node name    : $NODE_NAME${NC}"
echo -e "${GREEN}   Node id      : $NODE_ID${NC}"
echo -e "${GREEN}   API endpoint : $PROTOCOL://<this-host>:$WINGS_PORT${NC}"
echo -e "${GREEN}   Config       : $CONFIG_PATH${NC}"
echo -e "${GREEN}   Data dir     : $DATA_DIR${NC}"
echo -e "${GREEN}===========================================${NC}"
echo "The node turns ONLINE in the panel after its first heartbeat."
