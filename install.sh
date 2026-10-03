#!/bin/bash
# =========================================================
# JTG Panel - Automated Installation & Management Script
# =========================================================
#
# One-line install (nothing needs to be cloned first):
#   bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh)
#
# Fully unattended, with your own owner account:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) --yes --owner-user admin --owner-pass 'your-password'
#
# Fully unattended behind a Cloudflare Tunnel on your own domain:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \
#     --yes --exposure cloudflare --panel-domain panel.example.com --cloudflare-token "$TUNNEL_TOKEN"

# Ensure running in bash
if [ -z "$BASH_VERSION" ]; then
    if command -v bash > /dev/null 2>&1; then
        exec bash "$0" "$@"
    fi
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

REPO_URL="https://github.com/Gloxiedev/publicjtg1.git"
REPO_DIR_NAME="jtgsecret"
INSTALL_ROOT="${JTG_INSTALL_ROOT:-$HOME/jtgsecret}"

UNATTENDED=0
RUN_CHOICE=""
OWNER_USER_ARG=""
OWNER_PASS_ARG=""
EXPOSURE=""
PANEL_DOMAIN_ARG=""
CF_TOKEN_ARG=""
CF_TUNNEL_NAME_ARG=""
CF_TUNNEL_EXISTING_ARG=""
PANEL_PORT_ARG=""
BIND_ADDRESS_ARG=""
SKIP_CLOUDFLARE=0
GENERATED_PASS=""

usage() {
    echo "Usage: install.sh [options]"
    echo ""
    echo "  --yes                  Install unattended, no prompts."
    echo "  --mode <1|2>           1) Node.js via PM2 (recommended)  2) Pure local Node.js"
    echo ""
    echo "Public access:"
    echo "  --exposure <mode>      direct | cloudflare | later   (default: ask)"
    echo "  --panel-domain <host>  Public hostname for the panel, e.g. panel.example.com"
    echo "  --panel-port <port>    Panel port (default: 6767)"
    echo "  --cloudflare-token <t> Tunnel token, required for unattended Cloudflare setup"
    echo "  --tunnel-name <name>   Cloudflare tunnel name (default: jtg-panel)"
    echo "  --existing-tunnel <n>  Use an existing tunnel instead of creating one"
    echo ""
    echo "Owner account:"
    echo "  --owner-user <name>    Owner account username"
    echo "  --owner-pass <pass>    Owner account password (min 6 characters)"
    echo "  --bind-address <addr>  Override listen address (default: 127.0.0.1 for cloudflare,"
    echo "                         0.0.0.0 for direct, otherwise ask)"
    echo ""
    echo "  --help                 Show this help"
    echo ""
    echo "Examples:"
    echo "  bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh)"
    echo "  bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) --yes"
    echo "  bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) main"
    echo "  # Panel only on this host, reached through a Cloudflare Tunnel:"
    echo "  bash <(curl -fsSL https://raw.githubusercontent.com/Gloxiedev/publicjtg1/main/install.sh) \\"
    echo "    --yes --exposure cloudflare --panel-domain panel.example.com \\"
    echo "    --cloudflare-token \"\$TUNNEL_TOKEN\""
}

while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y) UNATTENDED=1; shift ;;
        --mode) RUN_CHOICE="$2"; shift 2 ;;
        --exposure) EXPOSURE="$2"; shift 2 ;;
        --panel-domain) PANEL_DOMAIN_ARG="$2"; shift 2 ;;
        --panel-port) PANEL_PORT_ARG="$2"; shift 2 ;;
        --cloudflare-token) CF_TOKEN_ARG="$2"; shift 2 ;;
        --tunnel-name) CF_TUNNEL_NAME_ARG="$2"; shift 2 ;;
        --existing-tunnel) CF_TUNNEL_EXISTING_ARG="$2"; shift 2 ;;
        --bind-address) BIND_ADDRESS_ARG="$2"; shift 2 ;;
        --owner-user) OWNER_USER_ARG="$2"; shift 2 ;;
        --owner-pass) OWNER_PASS_ARG="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) break ;;
    esac
done

if [ -n "$OWNER_USER_ARG" ]; then export JTG_OWNER_USER="$OWNER_USER_ARG"; fi
if [ -n "$OWNER_PASS_ARG" ]; then export JTG_OWNER_PASS="$OWNER_PASS_ARG"; fi
if [ "$UNATTENDED" = "1" ] && [ -z "$RUN_CHOICE" ]; then RUN_CHOICE="1"; fi

# Validate the exposure choice early so a typo fails fast instead of after a
# multi-minute install.
case "$EXPOSURE" in
    ""|direct|cloudflare|later) ;;
    *)
        echo -e "${RED}Invalid --exposure value: '$EXPOSURE'${NC}"
        echo "Expected one of: direct, cloudflare, later"
        exit 2
        ;;
esac

if [ -n "$PANEL_PORT_ARG" ]; then
    case "$PANEL_PORT_ARG" in
        ''|*[!0-9]*) echo -e "${RED}Invalid --panel-port: '$PANEL_PORT_ARG'${NC}"; exit 2 ;;
    esac
    if [ "$PANEL_PORT_ARG" -lt 1 ] || [ "$PANEL_PORT_ARG" -gt 65535 ]; then
        echo -e "${RED}--panel-port must be between 1 and 65535${NC}"
        exit 2
    fi
fi

# A domain is only meaningful for cloudflare exposure. Reject a contradiction,
# and infer cloudflare when a domain is given on its own.
if [ -n "$PANEL_DOMAIN_ARG" ] && [ -n "$EXPOSURE" ] && [ "$EXPOSURE" != "cloudflare" ]; then
    echo -e "${RED}--panel-domain requires --exposure cloudflare${NC}"
    exit 2
fi
if [ -n "$PANEL_DOMAIN_ARG" ] && [ -z "$EXPOSURE" ]; then
    EXPOSURE="cloudflare"
fi

# When piped from a URL there is no local checkout, so clone the repository.
# An existing checkout is always preferred so local edits keep working.
if [ -f "package.json" ] && [ -f "scripts/createuser.ts" ]; then
    WORK_DIR="$(pwd)"
elif [ -d "$REPO_DIR_NAME" ] && [ -f "$REPO_DIR_NAME/package.json" ]; then
    WORK_DIR="$REPO_DIR_NAME"
else
    echo "Fetching JTG Panel from $REPO_URL ..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_ROOT" 2>&1 | tail -2 || {
        echo -e "${RED}Failed to clone $REPO_URL${NC}"
        exit 1
    }
    WORK_DIR="$INSTALL_ROOT"
fi
cd "$WORK_DIR" || {
    echo -e "${RED}Failed to enter $WORK_DIR${NC}"
    exit 1
}
if [ ! -f "package.json" ]; then
    echo -e "${RED}package.json not found in $(pwd)${NC}"
    exit 1
fi

detect_os() {
    OS_TYPE="Unknown"
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_TYPE=${ID:-"Unknown"}
    elif command -v uname &> /dev/null; then
        OS_TYPE=$(uname -s)
    fi
}

print_banner() {
    if [ -t 1 ]; then
        clear 2>/dev/null || true
    fi
    echo -e "${CYAN}${BOLD}"
    echo "╔══════════════════════════════════════════════╗"
    echo "║                                              ║"
    echo "║     ██╗████████╗ ██████╗                     ║"
    echo "║     ██║╚══██╔══╝██╔════╝                     ║"
    echo "║     ██║   ██║   ██║  ███╗                    ║"
    echo "║     ██║   ██║   ██║   ██║                    ║"
    echo "║     ██║   ██║   ╚██████╔╝                    ║"
    echo "║     ╚═╝   ╚═╝    ╚═════╝                     ║"
    echo "║                                              ║"
    echo "║              JTG PANEL INSTALLER             ║"
    echo "║                                              ║"
    echo "╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

run_pm2() {
    if [ -x "./node_modules/.bin/pm2" ]; then
        ./node_modules/.bin/pm2 "$@"
    elif command -v pm2 &> /dev/null; then
        pm2 "$@"
    elif [ -x "/usr/local/bin/pm2" ]; then
        /usr/local/bin/pm2 "$@"
    else
        npx --no-install pm2 "$@" 2>/dev/null || npx pm2 "$@"
    fi
}

get_docker_cmd() {
    if docker info > /dev/null 2>&1; then
        echo "docker"
    elif command -v sudo &> /dev/null && sudo docker info > /dev/null 2>&1; then
        echo "sudo docker"
    else
        echo "docker"
    fi
}

get_compose_cmd() {
    local d_cmd=$(get_docker_cmd)
    if $d_cmd compose version > /dev/null 2>&1; then
        echo "$d_cmd compose"
    elif command -v docker-compose > /dev/null 2>&1; then
        echo "docker-compose"
    elif command -v sudo &> /dev/null && sudo docker-compose version > /dev/null 2>&1; then
        echo "sudo docker-compose"
    else
        echo "$d_cmd compose"
    fi
}

run_root() {
    if [ "$EUID" -eq 0 ]; then
        "$@"
    elif command -v sudo > /dev/null 2>&1; then
        sudo "$@"
    else
        "$@"
    fi
}

# The account that will actually run the panel. Under `sudo bash install.sh`
# EUID is 0 but the login session belongs to the original user, so Docker group
# membership must be granted to that user rather than to root.
install_user() {
    if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
        echo "$SUDO_USER"
    elif [ -n "$JTG_RUN_USER" ]; then
        echo "$JTG_RUN_USER"
    else
        id -un 2>/dev/null || echo "root"
    fi
}

# Grant Docker access by group membership.
#
# This previously ran `chmod 666 /var/run/docker.sock`, which leaves the Docker
# daemon world-writable: any local user, and any process that compromises the
# panel, can then start privileged containers and own the host. Membership of the
# `docker` group carries the same power but is the supported, auditable route.
ensure_docker_access() {
    local user sock_group
    user="$(install_user)"

    if [ -S /var/run/docker.sock ]; then
        sock_group="$(stat -c '%G' /var/run/docker.sock 2>/dev/null || echo "")"
        if [ -n "$sock_group" ] && [ "$sock_group" != "docker" ]; then
            log_warning "Docker socket group is '$sock_group', expected 'docker'."
        fi
    fi

    if [ "$user" = "root" ]; then
        return 0
    fi

    if id -nG "$user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        return 0
    fi

    log_info "Adding '$user' to the docker group..."
    if run_root usermod -aG docker "$user" 2>/dev/null; then
        log_warning "'$user' is now in the docker group, but this shell still runs without it."
        log_warning "Log out and back in (or run 'newgrp docker') before the panel can reach Docker."
        return 2
    fi

    log_error "Could not add '$user' to the docker group. Run manually:"
    log_error "  sudo usermod -aG docker $user"
    return 1
}

# True when the *current* process can reach the Docker daemon. Group membership
# only applies to new login sessions, so this can legitimately be false right
# after ensure_docker_access.
current_shell_has_docker() {
    docker info > /dev/null 2>&1
}

# ---------------------------------------------------------------------------
# .env handling
# ---------------------------------------------------------------------------

# Set KEY="VALUE" in the .env file, replacing any existing assignment.
#
# Deliberately implemented with a read/rebuild loop rather than sed: owner
# passwords and tunnel tokens routinely contain /, |, & and \ characters, which
# would corrupt a sed substitution and produce a broken config.
env_set() {
    local key="$1" val="$2" file="${3:-.env}"
    local tmp found line

    # Values written here are hex secrets, hostnames, ports and booleans, none of
    # which can contain a quote or backslash. Stripping them keeps the resulting
    # KEY="value" line unambiguous for dotenv instead of producing a truncated
    # value if an operator passes something unexpected.
    val="${val//\"/}"
    val="${val//\\/}"
    val="${val//\'/}"

    [ -f "$file" ] || : > "$file"
    tmp="${file}.tmp.$$"
    found=0
    : > "$tmp"

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "$key="*|"$key = "*)
                printf '%s="%s"\n' "$key" "$val" >> "$tmp"
                found=1
                ;;
            *)
                printf '%s\n' "$line" >> "$tmp"
                ;;
        esac
    done < "$file"

    if [ "$found" -eq 0 ]; then
        printf '%s="%s"\n' "$key" "$val" >> "$tmp"
    fi

    chmod 600 "$tmp" 2>/dev/null || true
    mv "$tmp" "$file"
}

# Replace the placeholder secret that ships in .env.example. Anyone who has
# read this repository knows that literal, so it must never reach a deployment.
ensure_jwt_secret() {
    local file="${1:-.env}" secret current

    if grep -q '^JWT_SECRET=' "$file" 2>/dev/null; then
        current="$(grep '^JWT_SECRET=' "$file" | head -n 1 | cut -d= -f2- | tr -d '"')"
        if [ -n "$current" ] \
            && [ "$current" != "your-secure-random-jwt-secret-here" ] \
            && [ "$current" != "jtg-panel-super-secret" ] \
            && [ ${#current} -ge 32 ]; then
            return 0
        fi
    fi

    secret="$(random_secret 32)"
    if [ -z "$secret" ]; then
        log_error "Could not generate a JWT secret. Install openssl or xxd and retry."
        return 1
    fi
    env_set JWT_SECRET "$secret" "$file"
    log_info "Generated a unique JWT secret in $(basename "$file")"
    return 0
}

random_secret() {
    local bytes="${1:-32}" out=""
    if [ -r /dev/urandom ]; then
        if command -v od > /dev/null 2>&1; then
            out="$(head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n')"
        elif command -v xxd > /dev/null 2>&1; then
            out="$(head -c "$bytes" /dev/urandom | xxd -p | tr -d '\n')"
        fi
    fi
    if [ ${#out} -lt 32 ] && command -v openssl > /dev/null 2>&1; then
        out="$(openssl rand -hex "$bytes" 2>/dev/null)"
    fi
    echo "$out"
}

# ---------------------------------------------------------------------------
# Public exposure
# ---------------------------------------------------------------------------

PANEL_PORT="${PANEL_PORT_ARG:-6767}"
PANEL_DOMAIN="$PANEL_DOMAIN_ARG"
BIND_ADDRESS=""
TUNNEL_NAME="${CF_TUNNEL_NAME_ARG:-jtg-panel}"
# Overridable so the tunnel path can be exercised in tests without root.
CLOUDFLARE_CONFIG_DIR="${JTG_CLOUDFLARE_CONFIG_DIR:-/etc/cloudflared}"
CLOUDFLARE_SERVICE="cloudflared-tunnel-jtg"
SYSTEMD_UNIT_DIR="${JTG_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

# Ask how the panel should be published. Unattended runs default to `later`,
# which installs the panel bound to loopback and prints instructions, so a
# non-interactive install can never hang waiting for input.
select_exposure() {
    if [ -n "$EXPOSURE" ]; then
        return 0
    fi

    if [ "$UNATTENDED" = "1" ] || [ ! -t 0 ]; then
        EXPOSURE="later"
        return 0
    fi

    print_banner
    echo -e "${BOLD}How should the panel be reachable?${NC}"
    echo ""
    echo -e "  ${BOLD}1)${NC} Direct on this server's public IP (${PANEL_PORT})"
    echo -e "  ${BOLD}2)${NC} Behind a Cloudflare Tunnel on your own domain"
    echo -e "  ${BOLD}3)${NC} Only on this host for now (decide later)"
    echo ""
    local choice=""
    read -p " Choose an option (1-3) [3]: " choice || choice=""
    case "$choice" in
        1) EXPOSURE="direct" ;;
        2) EXPOSURE="cloudflare" ;;
        *) EXPOSURE="later" ;;
    esac
}

# A hostname must be a real DNS label set: this value ends up in a published
# tunnel route and in URLs handed to operators.
validate_domain() {
    local host="$1"
    if [ -z "$host" ]; then
        return 1
    fi
    # Reject schemes, paths, ports, credentials and anything with a label that
    # is empty or not alphanumeric/hyphen.
    case "$host" in
        *://*|*/*|*:*) return 1 ;;
    esac
    printf '%s' "$host" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' || return 1
    return 0
}

# Hostnames are case-insensitive, but the value ends up in CORS_ORIGINS and
# PANEL_URL, where a case difference from the browser's Origin would be
# rejected. Normalise once, at the edge.
normalize_domain() {
    printf '%s' "$1" | tr 'A-Z' 'a-z'
}

prompt_domain() {
    if [ -n "$PANEL_DOMAIN" ]; then
        if ! validate_domain "$PANEL_DOMAIN"; then
            log_error "Invalid --panel-domain: '$PANEL_DOMAIN'"
            log_error "Expected a bare hostname such as panel.example.com"
            return 1
        fi
        PANEL_DOMAIN="$(normalize_domain "$PANEL_DOMAIN")"
        return 0
    fi

    if [ "$UNATTENDED" = "1" ] || [ ! -t 0 ]; then
        log_error "--exposure cloudflare requires --panel-domain in unattended mode."
        log_error "Example: --panel-domain panel.example.com"
        return 1
    fi

    local host=""
    while true; do
        read -p " Public hostname for the panel (e.g. panel.example.com): " host || return 1
        host="$(normalize_domain "$host")"
        if validate_domain "$host"; then
            PANEL_DOMAIN="$host"
            return 0
        fi
        log_warning "That is not a valid hostname. Example: panel.example.com"
    done
}

# Translate the exposure decision into the concrete listen address and the
# proxy-trust setting the panel needs.
resolve_bind_address() {
    if [ -n "$BIND_ADDRESS_ARG" ]; then
        BIND_ADDRESS="$BIND_ADDRESS_ARG"
    elif [ "$EXPOSURE" = "cloudflare" ]; then
        # The tunnel runs on this host and connects over loopback, so there is
        # no reason to expose the port to the network at all.
        BIND_ADDRESS="127.0.0.1"
    elif [ "$EXPOSURE" = "direct" ]; then
        BIND_ADDRESS="0.0.0.0"
    else
        BIND_ADDRESS="127.0.0.1"
    fi
}

# Write the settings the panel process actually reads.
apply_panel_config() {
    local runtime="$1"
    local enable_docker="true"
    [ "$runtime" = "local" ] && enable_docker="false"

    env_set PORT "$PANEL_PORT"
    env_set BIND_ADDRESS "$BIND_ADDRESS"
    env_set DEFAULT_RUNTIME "$runtime"
    env_set ENABLE_DOCKER "$enable_docker"

    if [ "$EXPOSURE" = "cloudflare" ]; then
        # Trust exactly one proxy hop. cloudflared is the only process that can
        # reach the loopback-bound port, so a single hop is both sufficient and
        # prevents a client from spoofing X-Forwarded-For.
        env_set TRUST_PROXY "true"
        env_set PANEL_URL "https://${PANEL_DOMAIN}"
        env_set CORS_ORIGINS "https://${PANEL_DOMAIN}"
    elif [ "$EXPOSURE" = "direct" ]; then
        env_set TRUST_PROXY "false"
        env_set CORS_ORIGINS ""
        PANEL_DOMAIN=""
    else
        # Loopback-only with no known proxy: forwarded headers are untrusted.
        env_set TRUST_PROXY "false"
        env_set CORS_ORIGINS ""
        PANEL_DOMAIN=""
    fi

    ensure_jwt_secret .env || return 1
    chmod 600 .env 2>/dev/null || true
    return 0
}

install_cloudflared() {
    if command -v cloudflared > /dev/null 2>&1; then
        log_info "cloudflared already installed: $(cloudflared --version 2>&1 | head -n 1)"
        return 0
    fi

    local arch pkg url tmp
    case "$(uname -m)" in
        x86_64)  arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        armv7l)  arch="arm" ;;
        *)
            log_error "Unsupported architecture for cloudflared: $(uname -m)"
            return 1
            ;;
    esac

    url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
    tmp="/tmp/cloudflared-${arch}.deb"

    log_info "Downloading cloudflared (${arch})..."
    if ! curl -fsSL --connect-timeout 15 --max-time 180 "$url" -o "$tmp"; then
        log_error "Could not download cloudflared from $url"
        rm -f "$tmp"
        return 1
    fi

    if command -v dpkg > /dev/null 2>&1; then
        if ! run_root dpkg -i "$tmp" > /dev/null 2>&1; then
            run_root apt-get install -y -f > /dev/null 2>&1 || true
            if ! command -v cloudflared > /dev/null 2>&1; then
                log_error "Failed to install the cloudflared package."
                rm -f "$tmp"
                return 1
            fi
        fi
    else
        log_error "cloudflared needs dpkg/apt. Install Docker, or configure the tunnel manually."
        rm -f "$tmp"
        return 1
    fi

    rm -f "$tmp"
    log_success "Installed $(cloudflared --version 2>&1 | head -n 1)"
}

# Create (or adopt) a tunnel, point the hostname at it, and install the service.
#
# Every cloudflared call is bounded by `timeout`. The previous legacy script ran
# `cloudflared service install $TOKEN` with no timeout, so a token that Cloudflare
# rejects, or an interactive prompt with no TTY, left the installer waiting
# forever with no output. Failures here are always reported, never silent.
# Cloudflare has two genuinely different setup paths, and conflating them is
# what made the legacy installer hang and fail:
#
#   token mode  A tunnel token only lets cloudflared *connect* to an existing
#               tunnel. It carries no account API permissions, so it cannot
#               create a tunnel and cannot create DNS records. The tunnel and
#               its public hostname must already exist in the dashboard.
#
#   login mode  `cloudflared tunnel login` stores an account certificate
#               (cert.pem), which does allow `tunnel create` and
#               `tunnel route dns`. This is fully automatic, but it opens a
#               browser, so it is only ever used with a human at the terminal.
#
# Every cloudflared invocation is bounded by `timeout` so a rejected token, a
# missing browser, or a prompt with no TTY reports an error instead of hanging.

configure_tunnel_via_token() {
    local token="$1"
    local unit="$SYSTEMD_UNIT_DIR/${CLOUDFLARE_SERVICE}.service"

    run_root mkdir -p "$SYSTEMD_UNIT_DIR" || return 1

    # The token is a credential: keep the unit 0600.
    if ! run_root tee "$unit" > /dev/null 2>&1 <<UNIT
[Unit]
Description=Cloudflare Tunnel for the JTG Panel (${PANEL_DOMAIN})
Documentation=https://developers.cloudflare.com/cloudflare-one/
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token ${token}
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
UNIT
    then
        log_error "Could not write $unit"
        return 1
    fi
    run_root chmod 600 "$unit" 2>/dev/null || true

    if command -v systemctl > /dev/null 2>&1; then
        run_root systemctl daemon-reload > /dev/null 2>&1 || true
        run_root systemctl enable "$CLOUDFLARE_SERVICE" > /dev/null 2>&1 || true
        if ! run_root systemctl restart "$CLOUDFLARE_SERVICE" > /dev/null 2>&1; then
            log_error "The ${CLOUDFLARE_SERVICE} service failed to start."
            log_error "Check it with: sudo systemctl status ${CLOUDFLARE_SERVICE} --no-pager"
            log_error "and: sudo journalctl -u ${CLOUDFLARE_SERVICE} -n 50 --no-pager"
            return 1
        fi
    fi

    log_success "Cloudflare Tunnel service installed and started."
    log_warning "A tunnel token cannot create DNS records. Add the public hostname"
    log_warning "in the Cloudflare dashboard, or run with --existing-tunnel using"
    log_warning "interactive login to have this script create it for you:"
    log_warning "  Zero Trust -> Networks -> Tunnels -> ${TUNNEL_NAME} -> Public Hostnames"
    log_warning "  hostname: ${PANEL_DOMAIN}   service: http://127.0.0.1:${PANEL_PORT}"
    return 0
}

configure_tunnel_via_login() {
    local tunnel_id=""

    log_warning "No tunnel token supplied, so an interactive Cloudflare login is required."
    log_warning "cloudflared will print a URL. Open it in a browser to authorise,"
    log_warning "then come back here. On a headless server the URL does not open"
    log_warning "automatically, so copy it to your own machine."
    log_warning "Press Ctrl+C at any time to abort and use --cloudflare-token instead."
    log_warning ""

    # Headless hosts have a TTY but no browser, which is the combination that
    # made this look like a hang: the wait was real, the login was not coming.
    if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] \
        && [ "$(uname -s)" != "Darwin" ] && [ -z "${WSL_DISTRO_NAME:-}" ]; then
        log_warning "This looks like a headless host (no DISPLAY/WAYLAND_DISPLAY), so"
        log_warning "the login page cannot open here. Authorise from another device"
        log_warning "using the URL below, or skip this and re-run with a token:"
        log_warning "  --cloudflare-token \"<token>\""
        log_warning ""
    fi

    # Stream the log while cloudflared waits, so the authorisation URL appears
    # immediately instead of the script looking stuck. Deliberately not a
    # pipeline: install.sh has no `set -o pipefail`, so `$?` after `cmd | tee`
    # would be tee's status and a failed login would read as success.
    local login_log="/tmp/jtg-cf-login.log"
    local login_status=0 login_offset=0
    : > "$login_log"
    timeout 180 cloudflared tunnel login > "$login_log" 2>&1 &
    local login_pid=$!

    while kill -0 "$login_pid" 2>/dev/null; do
        if [ -s "$login_log" ]; then
            local size
            size="$(wc -c < "$login_log" 2>/dev/null || echo 0)"
            if [ "$size" -gt "$login_offset" ]; then
                tail -c "+$((login_offset + 1))" "$login_log"
                login_offset="$size"
            fi
        fi
        sleep 2
    done
    wait "$login_pid" || login_status=$?

    if [ "$login_status" -ne 0 ]; then
        log_error "cloudflared tunnel login failed (exit ${login_status})."
        [ "$login_status" -eq 124 ] && log_error "Timed out after 180s waiting for the browser login."
        [ "$login_status" -eq 124 ] && log_error "No authorisation arrived, so nothing was configured."
        rm -f "$login_log"
        log_error ""
        log_error "Fastest path: create a tunnel in the dashboard, copy its token,"
        log_error "then re-run with --cloudflare-token \"<token>\"."
        log_error "Or install with --exposure direct and put your own TLS in front."
        return 1
    fi
    rm -f "$login_log"
    log_success "Authenticated with Cloudflare."

    # Reuse the tunnel if the operator named an existing one, otherwise create it.
    local target="${CF_TUNNEL_EXISTING_ARG:-$TUNNEL_NAME}"
    local listing
    if listing="$(timeout 60 cloudflared tunnel list --output json 2>/dev/null)"; then
        tunnel_id="$(printf '%s' "$listing" \
            | tr '{' '\n' \
            | grep "\"name\":\"${target}\"" \
            | grep -o '"id":"[^"]*"' \
            | head -n 1 \
            | cut -d'"' -f4)"
    fi

    if [ -n "$tunnel_id" ]; then
        log_info "Reusing existing tunnel '${target}' (${tunnel_id})."
    elif [ -n "$CF_TUNNEL_EXISTING_ARG" ]; then
        log_error "No tunnel named '${target}' was found in this account."
        return 1
    else
        if ! timeout 120 cloudflared tunnel create "$TUNNEL_NAME" > /tmp/jtg-cf-create.log 2>&1; then
            log_error "Could not create the Cloudflare tunnel '${TUNNEL_NAME}'."
            tail -n 15 /tmp/jtg-cf-create.log 2>/dev/null || true
            rm -f /tmp/jtg-cf-create.log
            return 1
        fi
        rm -f /tmp/jtg-cf-create.log
        log_success "Created tunnel '${TUNNEL_NAME}'."
        listing="$(timeout 60 cloudflared tunnel list --output json 2>/dev/null || true)"
        tunnel_id="$(printf '%s' "$listing" \
            | tr '{' '\n' \
            | grep "\"name\":\"${TUNNEL_NAME}\"" \
            | grep -o '"id":"[^"]*"' \
            | head -n 1 \
            | cut -d'"' -f4)"
        if [ -z "$tunnel_id" ]; then
            log_error "Tunnel was created but its id could not be read back."
            return 1
        fi
    fi

    if ! timeout 120 cloudflared tunnel route dns "$tunnel_id" "$PANEL_DOMAIN" > /tmp/jtg-cf-dns.log 2>&1; then
        log_error "Could not create the DNS route for ${PANEL_DOMAIN}."
        tail -n 15 /tmp/jtg-cf-dns.log 2>/dev/null || true
        log_warning "If the DNS record already exists, delete it in the dashboard and re-run."
        rm -f /tmp/jtg-cf-dns.log
        return 1
    fi
    rm -f /tmp/jtg-cf-dns.log
    log_success "Routed ${PANEL_DOMAIN} to the tunnel."

    local creds="$CLOUDFLARE_CONFIG_DIR/${tunnel_id}.json"
    if [ ! -f "$creds" ]; then
        log_error "Tunnel credentials not found at ${creds}."
        return 1
    fi
    run_root chmod 600 "$creds" 2>/dev/null || true

    # Hostname -> loopback panel. cloudflared is the only thing that can reach a
    # loopback-bound port, and TLS terminates at Cloudflare, so the origin stays
    # plain HTTP with no public listener.
    run_root mkdir -p "$CLOUDFLARE_CONFIG_DIR" || return 1
    if ! run_root tee "$CLOUDFLARE_CONFIG_DIR/config.yml" > /dev/null 2>&1 <<CONF
# Managed by the JTG installer. Hand edits are overwritten on re-run.
tunnel: ${tunnel_id}
credentials-file: ${creds}
ingress:
  - hostname: ${PANEL_DOMAIN}
    service: http://127.0.0.1:${PANEL_PORT}
  # cloudflared rejects a configuration without a catch-all rule.
  - service: http_status:404
CONF
    then
        log_error "Could not write $CLOUDFLARE_CONFIG_DIR/config.yml"
        return 1
    fi
    run_root chmod 600 "$CLOUDFLARE_CONFIG_DIR/config.yml" 2>/dev/null || true

    if command -v systemctl > /dev/null 2>&1; then
        if ! timeout 120 cloudflared service install "$tunnel_id" > /tmp/jtg-cf-service.log 2>&1; then
            log_error "cloudflared service install failed."
            tail -n 15 /tmp/jtg-cf-service.log 2>/dev/null || true
            log_warning "Start it manually with: sudo cloudflared tunnel run ${tunnel_id}"
            rm -f /tmp/jtg-cf-service.log
            return 1
        fi
        rm -f /tmp/jtg-cf-service.log
        run_root systemctl enable --now cloudflared > /dev/null 2>&1 || true
    fi

    log_success "Cloudflare Tunnel configured for https://${PANEL_DOMAIN}"
    return 0
}

configure_cloudflare_tunnel() {
    log_info "Setting up Cloudflare Tunnel for ${PANEL_DOMAIN}..."

    if [ -n "$CF_TOKEN_ARG" ]; then
        configure_tunnel_via_token "$CF_TOKEN_ARG"
    else
        # A browser login cannot be performed without a TTY. Failing here with
        # instructions is the whole point: the old script blocked forever.
        if [ "$UNATTENDED" = "1" ] || [ ! -t 0 ]; then
            log_error "Cloudflare setup needs a tunnel token when unattended."
            log_error "Create one at https://one.dash.cloudflare.com/ -> Zero Trust -> Networks -> Tunnels"
            log_error "Then re-run with: --cloudflare-token \"<token>\""
            return 1
        fi
        configure_tunnel_via_login
    fi
}


# Post-install report: what was actually built, and the exact next step.
print_deployment_summary() {
    local ip
    ip="$(curl -fsS -m 3 ifconfig.me 2>/dev/null \
        || curl -fsS -m 3 icanhazip.com 2>/dev/null \
        || hostname -I 2>/dev/null | awk '{print $1}' \
        || echo "localhost")"

    echo ""
    echo -e "${CYAN}${BOLD}──────────────────────────────────────────────${NC}"
    echo -e "${CYAN}${BOLD}  JTG Panel is installed and running${NC}"
    echo -e "${CYAN}${BOLD}──────────────────────────────────────────────${NC}"
    echo -e "  Install directory : $(pwd)"
    echo -e "  Panel port        : ${PANEL_PORT}"
    echo -e "  Listen address    : ${BIND_ADDRESS}"
    echo -e "  Owner username    : ${OWNER_USER}"
    if [ -n "$GENERATED_PASS" ]; then
        echo -e "  Owner password    : ${YELLOW}${BOLD}${GENERATED_PASS}${NC} ${YELLOW}(generated, save it now)${NC}"
    fi

    echo ""
    case "$EXPOSURE" in
        cloudflare)
            echo -e "  ${GREEN}Public URL${NC}           : ${BOLD}https://${PANEL_DOMAIN}${NC}"
            echo -e "  ${GREEN}Method${NC}              : Cloudflare Tunnel -> http://127.0.0.1:${PANEL_PORT}"
            echo -e "  ${GREEN}TLS${NC}                 : terminated at Cloudflare (origin is plain HTTP on loopback)"
            echo ""
            echo -e "  ${YELLOW}Wings and game traffic are NOT covered by this tunnel.${NC}"
            echo -e "  Run Wings on separate VPS hosts and reach them directly; see README."
            ;;
        direct)
            echo -e "  ${GREEN}Public URL${NC}           : ${BOLD}http://${ip}:${PANEL_PORT}${NC}"
            echo -e "  ${GREEN}Method${NC}              : direct, no TLS termination"
            echo -e "  ${YELLOW}There is no HTTPS here. Put a TLS-terminating proxy in front of${NC}"
            echo -e "  ${YELLOW}the panel before exposing it, or choose --exposure cloudflare.${NC}"
            ;;
        *)
            echo -e "  ${GREEN}Local URL${NC}           : ${BOLD}http://127.0.0.1:${PANEL_PORT}${NC}"
            echo -e "  ${GREEN}Method${NC}              : loopback only (no public exposure)"
            echo ""
            echo -e "  To publish it later, re-run:"
            echo -e "    ${BOLD}bash install.sh${NC}  and choose an exposure, or re-run with"
            echo -e "    ${BOLD}--exposure cloudflare --panel-domain panel.example.com${NC}"
            ;;
    esac
    echo ""

    if ! current_shell_has_docker; then
        echo -e "  ${YELLOW}Docker is not reachable from this shell yet.${NC}"
        echo -e "  ${YELLOW}Run: newgrp docker    (or log out and back in).${NC}"
        echo ""
    fi

    echo -e "  Useful commands:  pm2 logs jtg-main | pm2 status | bash install.sh"
    echo ""
}

execute_step() {
    local msg="$1"
    shift
    local step_id="jtg_step_$RANDOM"
    local log_file="/tmp/${step_id}.log"
    rm -f "$log_file"
    
    local is_optional=0
    case "$msg" in
        *"Java"*) is_optional=1 ;;
    esac

    printf "  ${CYAN}→${NC} %-42s " "$msg"
    
    # Run command in background and capture all stdout and stderr.
    #
    # stdin must be redirected explicitly. POSIX assigns /dev/null to the stdin
    # of an asynchronous list, so without this `[ -t 0 ]` is always false inside
    # a step and any step that needs to prompt -- notably the interactive
    # `cloudflared tunnel login` -- can never read from the terminal. That is why
    # the Cloudflare step previously appeared to hang with no output.
    local stdin_src="/dev/null"
    if [ -t 0 ] && [ -r /dev/tty ]; then
        stdin_src="/dev/tty"
    fi
    "$@" > "$log_file" 2>&1 < "$stdin_src" &
    local pid=$!
    
    local start_time=$(date +%s 2>/dev/null || echo 0)
    local max_wait=360
    case "$msg" in
        *"Java"*) max_wait=180 ;;
        *"Requirement"*) max_wait=180 ;;
        *"PM2"*) max_wait=120 ;;
        *"Node"*) max_wait=240 ;;
        *) max_wait=600 ;;
    esac

    if [ -t 1 ]; then
        local spinstr='|/-\\'
        while kill -0 $pid 2>/dev/null; do
            local cur_time=$(date +%s 2>/dev/null || echo 0)
            if [ "$start_time" -gt 0 ] && [ "$cur_time" -gt 0 ]; then
                local elapsed=$((cur_time - start_time))
                if [ $elapsed -ge $max_wait ]; then
                    echo " [Step reached maximum limit of ${max_wait}s]" >> "$log_file"
                    kill -TERM $pid 2>/dev/null || true
                    sleep 1
                    kill -9 $pid 2>/dev/null || true
                    break
                fi
            fi
            local temp=${spinstr#?}
            printf "[%c]" "$spinstr"
            local spinstr=$temp${spinstr%"$temp"}
            sleep 0.15
            printf "\b\b\b"
        done
    else
        while kill -0 $pid 2>/dev/null; do
            local cur_time=$(date +%s 2>/dev/null || echo 0)
            if [ "$start_time" -gt 0 ] && [ "$cur_time" -gt 0 ]; then
                local elapsed=$((cur_time - start_time))
                if [ $elapsed -ge $max_wait ]; then
                    echo " [Step reached maximum limit of ${max_wait}s]" >> "$log_file"
                    kill -TERM $pid 2>/dev/null || true
                    sleep 1
                    kill -9 $pid 2>/dev/null || true
                    break
                fi
            fi
            sleep 1
        done
    fi
    
    local status=0
    wait $pid 2>/dev/null || status=$?
    
    if [ $status -eq 0 ]; then
        printf "\r  ${GREEN}✓${NC} %-42s ${GREEN}[Done]${NC}\n" "$msg"
        # Steps that print follow-up instructions set JTG_STEP_VERBOSE=1. Their
        # output is captured in $log_file, so without this the operator never
        # sees the manual steps the step asked them to take.
        if [ "$JTG_STEP_VERBOSE" = "1" ] && [ -s "$log_file" ]; then
            local line
            while IFS= read -r line; do
                [ -n "$line" ] && echo "    $line"
            done < "$log_file"
        fi
        JTG_STEP_VERBOSE=0
    elif [ $is_optional -eq 1 ]; then
        printf "\r  ${YELLOW}⚠${NC} %-42s ${YELLOW}[Container Fallback]${NC}\n" "$msg"
        echo -e "  ${YELLOW}Notice: Host Java setup was bypassed. Docker Minecraft servers will use containerized Java.${NC}"
        return 0
    else
        printf "\r  ${RED}✗${NC} %-42s ${RED}[Fail]${NC}\n" "$msg"
        echo -e "\n================================================"
        echo -e "${RED}INSTALLATION STEP FAILED${NC}"
        echo -e "================================================"
        echo -e "Step: ${BOLD}$msg${NC}"
        echo -e "Exit Code: $status"
        echo -e "\nOutput / Reason:"
        if [ -s "$log_file" ]; then
            tail -n 60 "$log_file"
        else
            echo "No output was generated by the command."
        fi
        echo -e "================================================"
        echo -e "Installation stopped safely to prevent invalid states.\n"
        exit 1
    fi
    return $status
}

check_system_deps() {
    detect_os
    export DEBIAN_FRONTEND=noninteractive
    export NEEDRESTART_MODE=a
    export NEEDRESTART_SUSPEND=1
    export UCF_FORCE_CONFFOLD=1

    local MISSING_DEPS=""
    for cmd in curl git tar; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            MISSING_DEPS="$MISSING_DEPS $cmd"
        fi
    done

    if [ -n "$MISSING_DEPS" ]; then
        local TIMEOUT_CMD=""
        if command -v timeout > /dev/null 2>&1; then
            TIMEOUT_CMD="timeout 60"
        fi
        if command -v apt-get > /dev/null 2>&1; then
            local APT_OPTS="-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::http::Timeout=10 -o Acquire::ftp::Timeout=10"
            $TIMEOUT_CMD run_root apt-get update $APT_OPTS > /dev/null 2>&1 || true
            $TIMEOUT_CMD run_root apt-get install $APT_OPTS $MISSING_DEPS build-essential ca-certificates > /dev/null 2>&1 || true
        elif command -v yum > /dev/null 2>&1; then
            $TIMEOUT_CMD run_root yum update -y -q > /dev/null 2>&1 || true
            $TIMEOUT_CMD run_root yum install -y $MISSING_DEPS make gcc-c++ ca-certificates -q > /dev/null 2>&1 || true
        elif command -v dnf > /dev/null 2>&1; then
            $TIMEOUT_CMD run_root dnf install -y $MISSING_DEPS make gcc-c++ ca-certificates -q > /dev/null 2>&1 || true
        fi
    fi

    # Ensure swap if memory is low (< 2GB) and swap is low (< 512MB) to prevent OOM kills during build/run
    local total_mem=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo "2048")
    local total_swap=$(free -m 2>/dev/null | awk '/^Swap:/{print $2}' || echo "0")
    if [ -n "$total_mem" ] && [ "$total_mem" -lt 2000 ] && [ "$total_swap" -lt 512 ]; then
        if command -v swapon &> /dev/null && command -v sudo &> /dev/null; then
            if [ ! -f "/swapfile" ]; then
                if command -v fallocate &> /dev/null; then
                    sudo fallocate -l 2G /swapfile > /dev/null 2>&1 || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 > /dev/null 2>&1 || true
                else
                    sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 > /dev/null 2>&1 || true
                fi
                sudo chmod 600 /swapfile > /dev/null 2>&1 || true
                sudo mkswap /swapfile > /dev/null 2>&1 || true
                sudo swapon /swapfile > /dev/null 2>&1 || true
            else
                sudo swapon /swapfile > /dev/null 2>&1 || true
            fi
        fi
    fi

    for cmd in curl git tar; do
        if ! command -v "$cmd" &> /dev/null; then
            echo "Required system dependency '$cmd' is missing."
            return 1
        fi
    done
    return 0
}

install_docker() {
    if ! command -v docker &> /dev/null; then
        curl -fsSL https://get.docker.com | sh > /dev/null 2>&1 || true
        if command -v systemctl &> /dev/null; then
            sudo systemctl enable --now docker > /dev/null 2>&1 || true
        elif command -v service &> /dev/null; then
            sudo service docker start > /dev/null 2>&1 || true
        fi
    fi
    
    if ! command -v docker &> /dev/null; then
        echo "Docker could not be installed automatically. Please install Docker and retry."
        return 1
    fi
    
    # Check Docker daemon connectivity
    if ! docker info > /dev/null 2>&1; then
        if command -v systemctl &> /dev/null; then
            sudo systemctl start docker > /dev/null 2>&1 || true
        elif command -v service &> /dev/null; then
            sudo service docker start > /dev/null 2>&1 || true
        fi
        if ! docker info > /dev/null 2>&1; then
            if command -v sudo &> /dev/null && sudo docker info > /dev/null 2>&1; then
                sudo usermod -aG docker "$USER" 2>/dev/null || true
            else
                echo "Docker daemon is not running or current user lacks permission to access /var/run/docker.sock."
                return 1
            fi
        fi
    fi
    
    local d_cmd=$(get_docker_cmd)
    if ! $d_cmd compose version &> /dev/null && ! command -v docker-compose &> /dev/null; then
        sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose > /dev/null 2>&1 || true
        sudo chmod +x /usr/local/bin/docker-compose > /dev/null 2>&1 || true
    fi
    
    local c_cmd=$(get_compose_cmd)
    if ! $c_cmd version &> /dev/null; then
        echo "Docker Compose is required but could not be installed."
        return 1
    fi
    return 0
}

install_node() {
    local NEED_NODE=0
    if ! command -v node &> /dev/null; then
        NEED_NODE=1
    else
        local NODE_MAJOR=$(node -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1)
        if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
            NEED_NODE=1
        fi
    fi

    if [ "$NEED_NODE" -eq 1 ]; then
        if command -v apt-get &> /dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - > /dev/null 2>&1 || true
            sudo apt-get install -y nodejs > /dev/null 2>&1 || true
        fi
        
        local CURRENT_MAJOR=0
        if command -v node &> /dev/null; then
            CURRENT_MAJOR=$(node -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1)
        fi
        
        if [ "$CURRENT_MAJOR" -lt 20 ]; then
            local ARCH=$(uname -m)
            local NODE_ARCH="x64"
            case "$ARCH" in
                x86_64) NODE_ARCH="x64" ;;
                aarch64|arm64) NODE_ARCH="arm64" ;;
                armv7l) NODE_ARCH="armv7l" ;;
                *) NODE_ARCH="x64" ;;
            esac
            local NODE_DIST="node-v22.13.1-linux-${NODE_ARCH}"
            curl -fsSL "https://nodejs.org/dist/v22.13.1/${NODE_DIST}.tar.xz" -o /tmp/node22.tar.xz > /dev/null 2>&1 || true
            if [ -f "/tmp/node22.tar.xz" ]; then
                sudo tar -xJf /tmp/node22.tar.xz -C /usr/local --strip-components=1 > /dev/null 2>&1 || true
                rm -f /tmp/node22.tar.xz
            fi
        fi
    fi
    
    if ! command -v node &> /dev/null; then
        echo "Node.js (>=20) installation failed."
        return 1
    fi
    
    local VER=$(node -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1)
    if [ "$VER" -lt 20 ]; then
        echo "Node.js version must be >= 20. Current: $(node -v)"
        return 1
    fi

    if ! command -v npm &> /dev/null; then
        echo "npm is not installed."
        return 1
    fi
    return 0
}

install_java() {
    trap 'return 0' TERM INT

    # 1. Quick check: Is Java already working in PATH?
    if command -v java > /dev/null 2>&1 && java -version > /dev/null 2>&1; then
        echo "Java runtime already active: $(java -version 2>&1 | head -n 1)"
        return 0
    fi

    # 2. Check common JVM installation directories
    for cand in /usr/lib/jvm/java-21-openjdk-*/bin/java \
                /usr/lib/jvm/java-17-openjdk-*/bin/java \
                /usr/lib/jvm/default-java/bin/java \
                /usr/lib/jvm/java-11-openjdk-*/bin/java \
                /usr/lib/jvm/*-openjdk*/bin/java \
                /opt/java/bin/java \
                /opt/jtg-java/bin/java \
                /usr/local/java/bin/java; do
        if [ -x "$cand" ]; then
            echo "Found existing JVM at: $cand"
            run_root ln -sf "$cand" /usr/local/bin/java 2>/dev/null || true
            export PATH="/usr/local/bin:$PATH"
            if command -v java > /dev/null 2>&1 && java -version > /dev/null 2>&1; then
                return 0
            fi
        fi
    done

    echo "Configuring OpenJDK runtime..."

    # Ensure non-interactive environment to prevent debconf / needrestart hangs
    export DEBIAN_FRONTEND=noninteractive
    export NEEDRESTART_MODE=a
    export NEEDRESTART_SUSPEND=1
    export UCF_FORCE_CONFFOLD=1

    local TIMEOUT_BIN=""
    if command -v timeout > /dev/null 2>&1; then
        TIMEOUT_BIN="timeout 90"
    fi

    if command -v apt-get > /dev/null 2>&1; then
        local APT_OPTS="-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::http::Timeout=10 -o Acquire::ftp::Timeout=10"
        
        # Check for active dpkg lock; wait max 5 seconds
        local wait_lock=0
        while (fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1) && [ $wait_lock -lt 5 ]; do
            sleep 1
            wait_lock=$((wait_lock + 1))
        done

        # Try fast headless JRE install with individual timeouts
        $TIMEOUT_BIN run_root apt-get install $APT_OPTS openjdk-21-jre-headless > /dev/null 2>&1 || \
        $TIMEOUT_BIN run_root apt-get install $APT_OPTS openjdk-17-jre-headless > /dev/null 2>&1 || \
        $TIMEOUT_BIN run_root apt-get install $APT_OPTS default-jre-headless > /dev/null 2>&1 || true

    elif command -v dnf > /dev/null 2>&1; then
        $TIMEOUT_BIN run_root dnf install -y java-21-openjdk-headless > /dev/null 2>&1 || \
        $TIMEOUT_BIN run_root dnf install -y java-17-openjdk-headless > /dev/null 2>&1 || true
    elif command -v yum > /dev/null 2>&1; then
        $TIMEOUT_BIN run_root yum install -y java-21-openjdk-headless > /dev/null 2>&1 || \
        $TIMEOUT_BIN run_root yum install -y java-17-openjdk-headless > /dev/null 2>&1 || true
    elif command -v apk > /dev/null 2>&1; then
        $TIMEOUT_BIN apk add --no-cache openjdk21-jre-headless > /dev/null 2>&1 || \
        $TIMEOUT_BIN apk add --no-cache openjdk17-jre-headless > /dev/null 2>&1 || true
    elif command -v pacman > /dev/null 2>&1; then
        $TIMEOUT_BIN run_root pacman -Sy --noconfirm jre21-openjdk-headless > /dev/null 2>&1 || \
        $TIMEOUT_BIN run_root pacman -Sy --noconfirm jre17-openjdk-headless > /dev/null 2>&1 || true
    fi

    # Check if package manager installed Java successfully
    if command -v java > /dev/null 2>&1 && java -version > /dev/null 2>&1; then
        return 0
    fi

    # Check discovered JVM directories again in case package manager placed it without symlink
    for cand in /usr/lib/jvm/java-21-openjdk-*/bin/java \
                /usr/lib/jvm/java-17-openjdk-*/bin/java \
                /usr/lib/jvm/default-java/bin/java \
                /usr/lib/jvm/*-openjdk*/bin/java; do
        if [ -x "$cand" ]; then
            run_root ln -sf "$cand" /usr/local/bin/java 2>/dev/null || true
            export PATH="/usr/local/bin:$PATH"
            if command -v java > /dev/null 2>&1; then
                return 0
            fi
        fi
    done

    # 3. Direct lightweight headless JRE fallback via Adoptium
    local ARCH=$(uname -m)
    local ADOPT_ARCH=""
    case "$ARCH" in
        x86_64) ADOPT_ARCH="x64" ;;
        aarch64|arm64) ADOPT_ARCH="aarch64" ;;
        *) ADOPT_ARCH="" ;;
    esac

    if [ -n "$ADOPT_ARCH" ] && command -v curl > /dev/null 2>&1; then
        echo "Attempting fast binary runtime fetch..."
        local JRE_URL="https://api.adoptium.net/v3/binary/latest/21/ga/linux/${ADOPT_ARCH}/jre/hotspot/normal/eclipse"
        curl -fsSL --connect-timeout 8 --max-time 45 "$JRE_URL" -o /tmp/jtg_jre.tar.gz > /dev/null 2>&1 || true
        if [ -f "/tmp/jtg_jre.tar.gz" ] && [ -s "/tmp/jtg_jre.tar.gz" ]; then
            run_root mkdir -p /opt/jtg-java
            run_root tar -xzf /tmp/jtg_jre.tar.gz -C /opt/jtg-java --strip-components=1 > /dev/null 2>&1 || true
            rm -f /tmp/jtg_jre.tar.gz
            if [ -x "/opt/jtg-java/bin/java" ]; then
                run_root ln -sf /opt/jtg-java/bin/java /usr/local/bin/java 2>/dev/null || true
                export PATH="/usr/local/bin:$PATH"
                if command -v java > /dev/null 2>&1; then
                    echo "Java OpenJDK runtime installed successfully."
                    return 0
                fi
            fi
        fi
        rm -f /tmp/jtg_jre.tar.gz 2>/dev/null || true
    fi

    # 4. Safe Non-fatal Fallback:
    # JTG Panel itself runs on Node.js. Dockerized Minecraft instances embed Java automatically in their containers.
    # Therefore, failure to set up host Java must never freeze or halt the installer.
    echo "Notice: Host Java setup completed with container fallback."
    echo "Note: Docker-managed Minecraft servers will run using containerized Java."
    return 0
}

setup_docker_env() {
    install_docker
    cat << 'EOF2' > Dockerfile
FROM node:22-alpine
RUN apk add --no-cache docker-cli git make g++ python3 curl
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY . .
RUN if [ ! -f "dist/server.cjs" ] || [ ! -f "dist/index.html" ]; then NODE_OPTIONS="--max-old-space-size=2048" npm run build; fi
EXPOSE 6767 6868
CMD ["npm", "start"]
EOF2
    
    if [ ! -f "docker-compose.yml" ]; then
        cat << 'EOF2' > docker-compose.yml
version: '3.8'
services:
  jtg-main:
    build: .
    container_name: jtg-main
    restart: unless-stopped
    ports:
      - "6767:6767"
      - "6868:6868"
    environment:
      - NODE_ENV=production
      - PORT=6767
      - JTG_HOST_DATA_PATH=${PWD}/.data
      - JTG_OWNER_USER=${JTG_OWNER_USER:-}
      - JTG_OWNER_PASS=${JTG_OWNER_PASS:-}
    volumes:
      - ./.data:/app/.data
      - ./backups:/app/backups
      - /var/run/docker.sock:/var/run/docker.sock

  jtg-admin:
    build: .
    container_name: jtg-admin
    restart: unless-stopped
    command: npm run dev
    ports:
      - "3000:3000"
      - "6869:6869"
    environment:
      - NODE_ENV=development
      - PORT=3000
      - JTG_HOST_DATA_PATH=${PWD}/.data
      - JTG_OWNER_USER=${JTG_OWNER_USER:-}
      - JTG_OWNER_PASS=${JTG_OWNER_PASS:-}
    volumes:
      - ./.data:/app/.data
      - ./backups:/app/backups
      - /var/run/docker.sock:/var/run/docker.sock
EOF2
    fi
}

setup_node_env() {
    local RUNTIME_PREF=$1
    install_node

    if ! command -v pm2 &> /dev/null && [ ! -x "/usr/local/bin/pm2" ] && [ ! -x "./node_modules/.bin/pm2" ]; then
        sudo npm install -g pm2 > /dev/null 2>&1 || npm install -g pm2 > /dev/null 2>&1 || npm install --save-dev pm2 > /dev/null 2>&1 || true
    fi
    
    local DEFAULT_RT="docker"
    local ENABLE_DOCKER="true"
    
    if [ "$RUNTIME_PREF" = "local" ]; then
        DEFAULT_RT="local"
        ENABLE_DOCKER="false"
    else
        # Ensure Docker is ready on host for Minecraft server containers
        if ! command -v docker &> /dev/null; then
            echo "Installing Docker for Minecraft server containers..."
            install_docker 2>/dev/null || true
        fi
        if command -v systemctl &> /dev/null; then
            systemctl enable --now docker 2>/dev/null || sudo systemctl enable --now docker 2>/dev/null || true
        elif command -v service &> /dev/null; then
            service docker start 2>/dev/null || sudo service docker start 2>/dev/null || true
        fi
    ensure_docker_access || true
    fi
    
    # Everything configurable lives in .env, which server.ts loads via dotenv.
    # Do NOT overwrite ecosystem.config.cjs here: it is a tracked repository file
    # and regenerating it left operators with a dirty git tree and silently
    # discarded any local customisation. Only NODE_ENV is asserted here, because
    # the authentication bypass and the fail-closed JWT check both key off it.
    env_set DEFAULT_RUNTIME "$DEFAULT_RT"
    env_set ENABLE_DOCKER "$ENABLE_DOCKER"
    env_set DOCKER_SOCKET_PATH "/var/run/docker.sock"

    if grep -q '^PORT=' ecosystem.config.cjs 2>/dev/null; then
        log_warning "ecosystem.config.cjs hardcodes PORT, which overrides .env."
        log_warning "Remove the PORT line from its env block so --panel-port takes effect."
    fi
}

install_dependencies() {
    if [ ! -f "package.json" ]; then
        echo "Error: package.json not found in $(pwd)."
        return 1
    fi
    if [ -d "node_modules" ] && [ -x "node_modules/.bin/vite" ] && [ -x "node_modules/.bin/esbuild" ] && [ -x "node_modules/.bin/tsx" ]; then
        return 0
    fi
    npm install --no-audit --no-fund --legacy-peer-deps 2>&1 || npm install --no-audit --no-fund 2>&1
}

setup_owner() {
    npm run createuser
}

setup_owner_docker() {
    local TARGET=$1
    if [ -n "$JTG_OWNER_USER" ] && [ -n "$JTG_OWNER_PASS" ]; then
        local DOCKER_CLI=$(get_docker_cmd)
        sleep 2
        $DOCKER_CLI exec -e JTG_OWNER_USER="$JTG_OWNER_USER" -e JTG_OWNER_PASS="$JTG_OWNER_PASS" "$TARGET" npm run createuser 2>&1 || {
            if command -v node &> /dev/null && [ -f "scripts/createuser.ts" ] && [ -d "node_modules" ]; then
                npm run createuser 2>&1 || true
            fi
        }
    fi
}

build_application() {
    npm run build
    if [ ! -f "dist/server.cjs" ] || [ ! -f "dist/index.html" ]; then
        echo "Build failed: dist/server.cjs or dist/index.html is missing."
        return 1
    fi
}

start_panel_docker() {
    local TARGET=$1
    local DOCKER_CLI=$(get_docker_cmd)
    local COMPOSE_CLI=$(get_compose_cmd)

    export PWD=$(pwd)

    # Free up port from PM2 if it was previously running under local Node.js
    if command -v pm2 &> /dev/null || [ -f "node_modules/.bin/pm2" ]; then
        run_pm2 delete "$TARGET" > /dev/null 2>&1 || true
        if [ "$TARGET" = "jtg-main" ]; then
            run_pm2 delete "jtg-panel" > /dev/null 2>&1 || true
        fi
    fi

    # Remove any existing container with the same name to prevent naming collision
    $DOCKER_CLI rm -f "$TARGET" > /dev/null 2>&1 || true

    # Pre-build on host if node/npm are present and dist is not yet built (saves container memory)
    if [ ! -f "dist/server.cjs" ] || [ ! -f "dist/index.html" ]; then
        if command -v npm &> /dev/null && [ -d "node_modules" ]; then
            NODE_OPTIONS="--max-old-space-size=2048" npm run build > /dev/null 2>&1 || true
        fi
    fi

    echo "Starting container $TARGET via $COMPOSE_CLI..."
    if ! $COMPOSE_CLI up -d --build "$TARGET"; then
        echo "Docker Compose command failed to build or start $TARGET."
        echo "--- Docker Compose Logs ---"
        $COMPOSE_CLI logs --tail 50 "$TARGET" 2>&1 || true
        return 1
    fi
    
    local container_status=""
    local check_attempts=0
    while [ $check_attempts -lt 15 ]; do
        sleep 2
        container_status=$($DOCKER_CLI inspect --format '{{.State.Status}}' "$TARGET" 2>/dev/null || echo "not_found")
        if [ "$container_status" = "running" ]; then
            break
        elif [ "$container_status" = "exited" ] || [ "$container_status" = "dead" ]; then
            echo "Docker container $TARGET failed to start. Status: $container_status"
            echo "--- Docker Logs for $TARGET ---"
            $DOCKER_CLI logs "$TARGET" --tail 50 2>&1 || true
            return 1
        fi
        check_attempts=$((check_attempts + 1))
    done

    if [ "$container_status" != "running" ]; then
        echo "Docker container $TARGET is not in running state (Status: $container_status)."
        echo "--- Container Status ---"
        $DOCKER_CLI ps -a --filter "name=$TARGET" 2>&1 || true
        echo "--- Docker Logs for $TARGET ---"
        $DOCKER_CLI logs "$TARGET" --tail 50 2>&1 || true
        return 1
    fi
    return 0
}

# Size PM2's restart threshold and the V8 heap ceiling from the machine's actual
# RAM. A hardcoded 1G limit on a 512 MB VPS lets the process grow past what the
# kernel can give it, so the OOM killer reaps it and PM2 reports "errored"
# without ever printing an error. Keeping both limits comfortably under total
# RAM makes PM2 restart first, with a reason, instead of the kernel killing it
# silently.
configure_memory_limits() {
    local total_kb=0 available_mb=0 limit_mb heap_mb

    if [ -r /proc/meminfo ]; then
        total_kb="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)"
        available_mb="$(awk '/^MemAvailable:/ {printf "%d", $2/1024; exit}' /proc/meminfo 2>/dev/null || echo 0)"
    fi

    if [ -z "$total_kb" ] || [ "$total_kb" -lt 262144 ] 2>/dev/null; then
        # Could not measure RAM; keep the documented default.
        export JTG_PANEL_MAX_MEMORY="1G"
        export JTG_PANEL_MAX_OLD_SPACE="1024"
        return 0
    fi

    # Only ever shrink the documented 1G default. Raising it above that would
    # just disable the guard on a large host, where the panel does not need it.
    limit_mb=$((total_kb / 1024 * 70 / 100))
    [ "$limit_mb" -gt 1024 ] && limit_mb=1024
    [ "$limit_mb" -lt 384 ] && limit_mb=384

    # Leave headroom for the OS, Docker and the game containers on the same box.
    heap_mb=$((limit_mb * 70 / 100))

    export JTG_PANEL_MAX_MEMORY="${limit_mb}M"
    export JTG_PANEL_MAX_OLD_SPACE="${heap_mb}"

    log_info "Detected $((total_kb / 1024)) MB RAM (${available_mb} MB available); PM2 memory limit set to ${limit_mb}M, Node heap to ${heap_mb}M"

    if [ "$((total_kb / 1024))" -lt 1536 ]; then
        log_warning "This machine has less than 1536 MB of RAM."
        log_warning "Building the panel (Vite + esbuild) and then running it leaves little headroom."
        log_warning "Add swap or move to a host with 2 GB or more if the panel is killed during startup:"
        log_warning "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
    fi
}

# Make the panel come back after a reboot. "pm2 save" only writes the process
# list to ~/.pm2/dump.pm2; without a systemd boot unit nothing reads it, so the
# panel stays down after any restart.
ensure_pm2_boot() {
    command -v systemctl > /dev/null 2>&1 || {
        log_warning "systemd is not available; the panel will not return automatically after a reboot."
        return 0
    }

    local unit
    unit="$(systemctl list-unit-files 2>/dev/null | awk '/^pm2[^ ]*\.service/ {print $1; exit}')"
    if [ -z "$unit" ]; then
        log_info "Creating a PM2 boot unit so the panel returns after a reboot"
        run_pm2 startup systemd -u "$(id -un)" --hp "$HOME" > /dev/null 2>&1 ||
            run_pm2 startup systemd > /dev/null 2>&1 ||
            true
        unit="$(systemctl list-unit-files 2>/dev/null | awk '/^pm2[^ ]*\.service/ {print $1; exit}')"
    fi

    if [ -n "$unit" ]; then
        systemctl enable "$unit" > /dev/null 2>&1 || true
        run_pm2 save --force > /dev/null 2>&1 || true
        log_info "PM2 boot unit enabled ($unit); the panel will start automatically after a reboot."
    else
        log_warning "Could not create a PM2 boot unit. Run 'pm2 startup' and 'pm2 save' manually,"
        log_warning "otherwise the panel will not return after a reboot."
    fi
}

pm2_target_failed() {
    run_pm2 list 2>/dev/null | grep "$1" | grep -qE "errored|stopped"
}

# PM2's God daemon resolves its own ProcessContainer module from the absolute
# pm2 path it recorded when the daemon started. If the repository is reinstalled
# at a different path (for example /root/Jtg -> /root/jtgsecret), or pm2 itself
# is reinstalled, that path stops existing and the daemon can no longer spawn
# anything. Every app then dies instantly with
#   Cannot find module '.../pm2/lib/ProcessContainer.js'
# before the application's own code runs, so the app error log stays empty and
# PM2 only reports a misleading "errored" status.
pm2_daemon_broken() {
    local log="${PM2_HOME:-$HOME/.pm2}/pm2.log"
    [ -r "$log" ] || return 1
    tail -n 300 "$log" 2>/dev/null | grep -q 'pm2/lib/ProcessContainer'
}

start_panel_node() {
    local TARGET=$1
    if [ "$TARGET" = "jtg-main" ]; then
        run_pm2 delete jtg-panel 2>/dev/null || true
        # Clean up conflicting Docker container if previously running via Docker
        local DOCKER_CLI=$(get_docker_cmd)
        $DOCKER_CLI rm -f jtg-main jtg-panel 2>/dev/null || true
    fi
    # Ensure Docker daemon is running and socket accessible for Minecraft containers
    if command -v systemctl & &> /dev/null; then
        systemctl enable --now docker 2>/dev/null || sudo systemctl enable --now docker 2>/dev/null || true
    elif command -v service & &> /dev/null; then
        service docker start 2>/dev/null || sudo service docker start 2>/dev/null || true
    fi
    ensure_docker_access || true
    configure_memory_limits
    run_pm2 delete "$TARGET" 2>/dev/null || true
    run_pm2 start ecosystem.config.cjs --only "$TARGET"

    # A daemon left over from a previous install path cannot spawn this app.
    # Rebuild it from the current directory instead of failing the install.
    local attempt=0
    while [ "$attempt" -lt 2 ]; do
        sleep 4
        if ! pm2_target_failed "$TARGET"; then
            break
        fi
        if pm2_daemon_broken; then
            log_warning "The PM2 daemon is stale - it was started from a directory that no longer exists."
            log_warning "Rebuilding it from $(pwd) so the panel process can be spawned."
            run_pm2 kill >/dev/null 2>&1 || true
            sleep 3
            run_pm2 start ecosystem.config.cjs --only "$TARGET" >/dev/null 2>&1 || true
        else
            # Not a stale daemon, so this is a genuine crash. Leave it for the
            # health check, which prints the diagnostics.
            break
        fi
        attempt=$((attempt + 1))
    done

    run_pm2 save --force 2>/dev/null || true
    ensure_pm2_boot
}

# Print everything needed to explain a startup failure. A process that dies
# instantly leaves a PM2 status of "errored" with no obvious cause, so collect
# the evidence while the user is still looking at the terminal.
print_startup_diagnostics() {
    local TARGET="$1" PORT="$2"

    # The most common cause of "errored with an empty error log" is a PM2 daemon
    # that was started from a directory that has since been replaced. Call it out
    # first, because the application logs will never mention it.
    if pm2_daemon_broken; then
        echo "!! CAUSE FOUND: the PM2 daemon is stale."
        echo "   It was started from a directory that no longer exists, so it cannot"
        echo "   load pm2/lib/ProcessContainer.js and every app it spawns dies"
        echo "   immediately - before the panel's own code runs. That is why the error"
        echo "   log below is empty."
        echo "   Fix with:  pm2 kill && cd <repo> && pm2 start ecosystem.config.cjs --only ${TARGET}"
        echo ""
    fi

    echo ""
    echo "--- PM2 status ---"
    run_pm2 list 2>&1 | grep -E "$TARGET|status" || run_pm2 list 2>&1 || true

    echo "--- PM2 describe $TARGET ---"
    run_pm2 describe "$TARGET" 2>&1 | grep -Ei 'status|script path|exec cwd|exec interpreter|restarts|unstable|out of memory' || true

    echo "--- error log (last 40 lines) ---"
    run_pm2 logs "$TARGET" --err --lines 40 --nostream 2>&1 || true

    echo "--- output log (last 20 lines) ---"
    run_pm2 logs "$TARGET" --out --lines 20 --nostream 2>&1 || true

    echo "--- listeners on port $PORT ---"
    if command -v ss > /dev/null 2>&1; then
        ss -lntp 2>/dev/null | grep ":${PORT}" || echo "(nothing is listening on $PORT)"
    elif command -v netstat > /dev/null 2>&1; then
        netstat -lntp 2>/dev/null | grep ":${PORT}" || echo "(nothing is listening on $PORT)"
    else
        echo "(install iproute2 or net-tools to inspect listeners)"
    fi

    echo "--- memory / OOM killer ---"
    if command -v free > /dev/null 2>&1; then
        free -m 2>/dev/null || true
    fi
    if [ -r /var/log/kern.log ]; then
        grep -iE 'killed process|out of memory' /var/log/kern.log 2>/dev/null | tail -5 || true
    elif command -v dmesg > /dev/null 2>&1; then
        dmesg -T 2>/dev/null | grep -iE 'killed process|out of memory' | tail -5 || true
    fi

    echo "--- effective panel config (.env) ---"
    if [ -f .env ]; then
        grep -E '^(PORT|BIND_ADDRESS|NODE_ENV|JWT_SECRET)=' .env 2>/dev/null |
            sed -E 's/^(JWT_SECRET=).*/\1<redacted>/' || true
        # A PM2 `env:` block wins over .env, so a stale value there silently
        # overrides whatever the operator just configured. Match only a real
        # assignment so explanatory comments do not trigger a false warning.
        if [ -f ecosystem.config.cjs ] &&
            grep -qE "^[[:space:]]*JWT_SECRET[[:space:]]*[:=]" ecosystem.config.cjs 2>/dev/null; then
            echo "WARNING: ecosystem.config.cjs assigns JWT_SECRET, which overrides .env for the panel process."
        fi
    else
        echo "(no .env in $(pwd))"
    fi
    echo ""
}

health_check() {
    local PORT=$1
    local RUNTIME_TYPE=$2
    local TARGET=$3
    local ATTEMPTS=0
    local MAX_ATTEMPTS=30
    local DOCKER_CLI=$(get_docker_cmd)

    while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
        if curl -s -f "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || curl -s -f "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
            return 0
        fi
        
        if [ "$RUNTIME_TYPE" = "docker" ]; then
            local cstatus=$($DOCKER_CLI inspect --format '{{.State.Status}}' "$TARGET" 2>/dev/null || echo "not_found")
            if [ "$cstatus" = "exited" ] || [ "$cstatus" = "dead" ] || [ "$cstatus" = "not_found" ]; then
                echo "Container $TARGET is not running during health check (Status: $cstatus)."
                echo "--- Logs for $TARGET ---"
                $DOCKER_CLI logs "$TARGET" --tail 50 2>&1 || true
                return 1
            fi
        else
            if run_pm2 list 2>/dev/null | grep "$TARGET" | grep -qE "errored|stopped"; then
                echo "PM2 process $TARGET crashed or stopped."
                print_startup_diagnostics "$TARGET" "$PORT"
                return 1
            fi
        fi
        
        sleep 2
        ATTEMPTS=$((ATTEMPTS + 1))
    done

    echo "Health check timed out waiting for application on port $PORT."
    if [ "$RUNTIME_TYPE" = "docker" ]; then
        echo "--- Container Status ---"
        $DOCKER_CLI ps -a --filter "name=$TARGET" || true
        echo "--- Docker Logs ---"
        $DOCKER_CLI logs "$TARGET" --tail 50 2>&1 || true
    else
        print_startup_diagnostics "$TARGET" "$PORT"
    fi
    return 1
}

check_port() {
    local PORT=$1
    if command -v ss &> /dev/null; then
        if ss -lnt | grep -q ":$PORT "; then return 1; fi
    elif command -v netstat &> /dev/null; then
        if netstat -tuln | grep -q ":$PORT "; then return 1; fi
    elif command -v lsof &> /dev/null; then
        if lsof -i :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then return 1; fi
    fi
    return 0
}

show_status() {
    local MAIN_STATUS="OFF"
    local DEV_STATUS="OFF"
    local SFTP_STATUS="OFF"
    
    if (run_pm2 list 2>/dev/null | grep "jtg-main" | grep -q "online") ||        (command -v docker &> /dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^jtg-main$") ||        curl -s -m 2 http://127.0.0.1:6767/api/health 2>/dev/null | grep -q "JTG Panel"; then
        MAIN_STATUS="ONLINE"
    fi
    
    if (run_pm2 list 2>/dev/null | grep "jtg-admin" | grep -q "online") ||        (command -v docker &> /dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^jtg-admin$") ||        curl -s -m 2 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q "JTG Panel"; then
        DEV_STATUS="ONLINE"
    fi
    
    if [ "$MAIN_STATUS" = "ONLINE" ] || [ "$DEV_STATUS" = "ONLINE" ]; then
        SFTP_STATUS="ONLINE"
    fi
    
    local IP=$(curl -s -m 2 ifconfig.me 2>/dev/null || curl -s -m 2 icanhazip.com 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

    echo -e "
${CYAN}${BOLD}╔══════════════════════════════════════════════╗"
    echo -e "║              JTG PANEL STATUS                ║"
    echo -e "╠══════════════════════════════════════════════╣${NC}"
    echo -e "║"
    if [ "$MAIN_STATUS" = "ONLINE" ]; then
        echo -e "║  Main Panel       : ${GREEN}ONLINE${NC} (http://${IP}:6767)"
    else
        echo -e "║  Main Panel       : ${RED}OFF${NC}"
    fi
    echo -e "║  Main Port        : 6767"
    if [ "$DEV_STATUS" = "ONLINE" ]; then
        echo -e "║  Developer Panel  : ${GREEN}ONLINE${NC} (http://${IP}:3000)"
    else
        echo -e "║  Developer Panel  : ${YELLOW}OFF${NC}"
    fi
    echo -e "║  Developer Port   : 3000"
    if [ "$SFTP_STATUS" = "ONLINE" ]; then
        echo -e "║  SFTP Service     : ${GREEN}ONLINE${NC} (Port 2022)"
    else
        echo -e "║  SFTP Service     : ${RED}OFF${NC}"
    fi
    echo -e "║"
    echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════╝${NC}
"
}

install_panel() {
    local TARGET=$1
    local PANEL_NAME="Main Panel"
    local PORT="6767"
    local SERVICE_NAME="jtg-main"
    
    if [ "$TARGET" = "dev" ]; then
        PANEL_NAME="Developer Panel"
        PORT="3000"
        SERVICE_NAME="jtg-admin"
    fi

    print_banner
    echo -e "╔══════════════════════════════════════════════╗"
    echo -e "║          SELECT INSTALLATION MODE            ║"
    echo -e "╠══════════════════════════════════════════════╣"
    echo -e "║                                              ║"
    echo -e "║  1) Node.js with PM2 (Recommended)          ║"
    echo -e "║     • Panel runs on Node.js via PM2          ║"
    echo -e "║     • Docker used for Minecraft servers      ║"
    echo -e "║  2) Pure Local Node.js                       ║"
    echo -e "║     • Panel runs on Node.js via PM2          ║"
    echo -e "║     • Node.js/Local for Minecraft servers    ║"
    echo -e "║  3) Back                                     ║"
    echo -e "║                                              ║"
    echo -e "╚══════════════════════════════════════════════╝"
    
    local MODE_CHOICE=""
    if [ -n "$RUN_CHOICE" ]; then
        MODE_CHOICE="$RUN_CHOICE"
    elif [ ! -t 0 ]; then
        MODE_CHOICE="1"
    else
        read -p " Choose an option (1-3): " MODE_CHOICE
    fi

    if [ "$MODE_CHOICE" = "3" ]; then
        return
    fi

    if [ "$MODE_CHOICE" != "1" ] && [ "$MODE_CHOICE" != "2" ]; then
        log_error "Invalid selection."
        sleep 1
        return
    fi
    
    if [ "$TARGET" = "main" ]; then
        print_banner
        echo -e "╔══════════════════════════════════════════════╗"
        echo -e "║              CREATE OWNER ACCOUNT            ║"
        echo -e "╠══════════════════════════════════════════════╣"
        
        local OWNER_USER=""
        local OWNER_PASS=""
        local OWNER_PASS2=""
        
        if [ -n "$JTG_OWNER_USER" ] && [ -n "$JTG_OWNER_PASS" ]; then
            OWNER_USER="$JTG_OWNER_USER"
            OWNER_PASS="$JTG_OWNER_PASS"
        elif [ ! -t 0 ]; then
            # Unattended without explicit credentials: generate a strong random
            # password and print it, rather than silently shipping a known default.
            OWNER_USER="owner"
            OWNER_PASS=$(head -c 24 /dev/urandom | base64 2>/dev/null | tr -d '/+=' | head -c 20)
            if [ ${#OWNER_PASS} -lt 10 ]; then
                OWNER_PASS="jtg$(date +%s)"
            fi
            GENERATED_PASS="$OWNER_PASS"
        else
            while true; do
                read -p "║ Username: " OWNER_USER
                if [ ${#OWNER_USER} -ge 3 ]; then
                    break
                else
                    echo "║ Username must be at least 3 characters. Try again."
                fi
            done
            
            while true; do
                read -s -p "║ Password: " OWNER_PASS
                echo ""
                read -s -p "║ Confirm Password: " OWNER_PASS2
                echo ""
                if [ ${#OWNER_PASS} -lt 6 ]; then
                    echo "║ Password must be at least 6 characters. Try again."
                elif [ "$OWNER_PASS" = "$OWNER_PASS2" ] && [ -n "$OWNER_PASS" ]; then
                    break
                else
                    echo "║ Passwords do not match or are empty. Try again."
                fi
            done
        fi
        echo -e "╚══════════════════════════════════════════════╝"
        
        export JTG_OWNER_USER="$OWNER_USER"
        export JTG_OWNER_PASS="$OWNER_PASS"
    fi
    
    # Decide how the panel is published before anything is written, so the bind
    # address and proxy trust in .env match the real topology.
    if [ "$TARGET" = "main" ]; then
        select_exposure
        resolve_bind_address
        if [ "$EXPOSURE" = "cloudflare" ]; then
            if ! prompt_domain; then
                log_error "Cannot continue without a valid panel domain."
                return 1
            fi
        fi
    else
        EXPOSURE="direct"
        resolve_bind_address
    fi

    # Environment Setup
    mkdir -p .data backups
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
        else
            : > .env
        fi
    fi

    # Refuse to start on an occupied port rather than silently replacing an
    # unrelated service. An already-installed panel is our own, so allow it.
    if [ "$TARGET" = "main" ] && ! check_port "$PANEL_PORT"; then
        if curl -fsS -m 2 "http://127.0.0.1:${PANEL_PORT}/api/health" > /dev/null 2>&1; then
            log_info "Port ${PANEL_PORT} is already serving a JTG panel; treating this as a reinstall."
        else
            log_error "Port ${PANEL_PORT} is in use by another process."
            log_error "Stop it, or re-run with --panel-port <other>."
            return 1
        fi
    fi

    print_banner
    echo -e "╔══════════════════════════════════════════════╗"
    echo -e "║              INSTALLATION PROGRESS           ║"
    echo -e "╚══════════════════════════════════════════════╝
"

    execute_step "System Requirement Check" check_system_deps
    execute_step "Java Runtime Environment" install_java
    
    if [ "$MODE_CHOICE" = "1" ] || [ "$MODE_CHOICE" = "2" ]; then
        local RUNTIME_ARG="docker"
        if [ "$MODE_CHOICE" = "2" ]; then
            RUNTIME_ARG="local"
        fi
        execute_step "Node.js Configuration" setup_node_env "$RUNTIME_ARG"
        execute_step "Writing Panel Configuration" apply_panel_config "$RUNTIME_ARG"
        execute_step "NPM Dependencies" install_dependencies
        if [ "$TARGET" = "main" ]; then
            execute_step "Owner Account Setup" setup_owner
            execute_step "Building Application" build_application
            execute_step "Starting PM2 Service" start_panel_node jtg-main
            execute_step "Waiting for Application on port ${PANEL_PORT}" health_check "$PANEL_PORT" pm2 jtg-main
        else
            execute_step "Building Application" build_application
            execute_step "Starting PM2 Service" start_panel_node jtg-admin
            execute_step "Waiting for Application & Port 3000" health_check 3000 pm2 jtg-admin
        fi

        # Cloudflare is configured only after the panel answers locally: the
        # tunnel origin must be live, and a public route pointing at a dead
        # origin is worse than no route at all.
        if [ "$TARGET" = "main" ] && [ "$EXPOSURE" = "cloudflare" ]; then
            execute_step "Installing cloudflared" install_cloudflared
            # Show the tunnel's output: it tells the operator which dashboard
            # page still needs their attention.
            JTG_STEP_VERBOSE=1 execute_step "Configuring Cloudflare Tunnel" configure_cloudflare_tunnel
        fi
    fi

    show_status

    if [ "$TARGET" = "main" ]; then
        print_deployment_summary
    else
        log_success "JTG Developer Panel installation is complete and verified!"
        echo -e "${GREEN}✓ Developer Panel running on http://127.0.0.1:3000.${NC}\n"
    fi
}

update_panel() {
    if [ ! -f "update.sh" ]; then
        log_error "update.sh not found."
        return
    fi
    bash update.sh
}

create_owner_user() {
    print_banner
    echo -e "╔══════════════════════════════════════════════╗"
    echo "║              CREATE OWNER ACCOUNT            ║"
    echo "╚══════════════════════════════════════════════╝"
    
    local OWNER_USER=""
    local OWNER_PASS=""
    local OWNER_PASS2=""
    
    while true; do
        read -p "  Username: " OWNER_USER
        if [ ${#OWNER_USER} -ge 3 ]; then
            break
        else
            echo "  Username must be at least 3 characters. Try again."
        fi
    done
    
    while true; do
        read -s -p "  Password: " OWNER_PASS
        echo ""
        read -s -p "  Confirm Password: " OWNER_PASS2
        echo ""
        if [ ${#OWNER_PASS} -lt 6 ]; then
            echo "  Password must be at least 6 characters. Try again."
        elif [ "$OWNER_PASS" = "$OWNER_PASS2" ] && [ -n "$OWNER_PASS" ]; then
            break
        else
            echo "  Passwords do not match or are empty. Try again."
        fi
    done
    
    export JTG_OWNER_USER="$OWNER_USER"
    export JTG_OWNER_PASS="$OWNER_PASS"
    execute_step "Setting up Owner Account" setup_owner
    log_success "Owner user setup completed successfully!"
}

uninstall_panel() {
    if [ ! -f "uninstall.sh" ]; then
        log_error "uninstall.sh not found."
        return
    fi
    bash uninstall.sh
}

# Direct invocation support: bash install.sh main / bash install.sh dev
if [ "$1" = "main" ]; then
    install_panel "main"
    exit 0
elif [ "$1" = "dev" ]; then
    install_panel "dev"
    exit 0
elif [ "$UNATTENDED" = "1" ]; then
    install_panel "main"
    exit $?
fi

while true; do
    print_banner
    echo -e "  ${BOLD}1)${NC} Initialize Main Panel"
    echo -e "  ${BOLD}2)${NC} Initialize Developer Panel"
    echo -e "  ${BOLD}3)${NC} Update JTG Panel"
    echo -e "  ${BOLD}4)${NC} Create Owner"
    echo -e "  ${BOLD}5)${NC} Uninstall JTG Panel"
    echo -e "  ${BOLD}6)${NC} Exit"
    echo -e "\n========================================================"
    if ! read -p " Choose an option (1-6): " CHOICE; then
        echo ""
        break
    fi
    case "$CHOICE" in
        1)
            install_panel "main"
            if [ -t 0 ]; then read -p "Press Enter to return to main menu..." || true; fi
            ;;
        2)
            install_panel "dev"
            if [ -t 0 ]; then read -p "Press Enter to return to main menu..." || true; fi
            ;;
        3)
            update_panel
            if [ -t 0 ]; then read -p "Press Enter to return to main menu..." || true; fi
            ;;
        4)
            create_owner_user
            if [ -t 0 ]; then read -p "Press Enter to return to main menu..." || true; fi
            ;;
        5)
            uninstall_panel
            if [ -t 0 ]; then read -p "Press Enter to return to main menu..." || true; fi
            ;;
        6)
            echo -e "\n${YELLOW}Exiting script... Goodbye!${NC}\n"
            exit 0
            ;;
        *)
            log_error "Invalid option!"
            sleep 1.5
            ;;
    esac
done
