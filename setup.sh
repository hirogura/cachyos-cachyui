#!/bin/bash
# ============================================================
# cachy-UI Setup Script for CachyOS
# ============================================================
# serv-UI (Ubuntu/GRUB/apt) を CachyOS (Limine/pacman) に移植した
# cachy-UI のセットアップスクリプト。
#
# Usage: sudo bash setup.sh [--branch <name>] [--no-restart]
#
# Options:
#   --branch <name>   Install from the given branch (default: main)
#   --no-restart      Deploy files only; restart cachy-UI manually
#
# This script:
# 1. Installs system dependencies (pacman)
# 2. Creates a dedicated user for cachy-UI
# 3. Sets up sudoers for management commands
# 4. Clones from GitHub and deploys cachy-UI
# 5. Creates systemd service
# 6. Configures Tailscale serve (HTTPS)
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

APP_NAME="cachy-ui"
APP_DIR="/opt/cachy-ui"
APP_USER="cachyui"
APP_PORT=3355
REPO_URL="https://github.com/hirogura/cachyos-cachyui.git"
BRANCH="main"
NO_RESTART=0

log() { echo -e "${GREEN}[✔]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✘]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ $# -ge 2 ]] || err "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    *)
      err "Unknown option: $1"
      ;;
  esac
done

# --- Root check ---
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo bash setup.sh)"
fi

info "Installing cachy-UI from branch: ${BRANCH}"

# --- Check Tailscale is installed ---
if ! command -v tailscale &>/dev/null; then
  warn "Tailscale is not installed. Installing now..."
  pacman -S --needed --noconfirm tailscale
fi

# --- Check Tailscale is connected ---
if ! tailscale status &>/dev/null; then
  warn "Tailscale is not connected. Please run 'tailscale up' first."
  warn "After connecting, re-run this script."
  exit 1
fi

# --- Install dependencies (CachyOS/pacman) ---
log "Installing system dependencies..."
pacman -Syu --needed --noconfirm python python-pip python-virtualenv git \
  networkmanager iw wpa_supplicant wget efibootmgr tailscale \
  pacman-contrib parted dosfstools e2fsprogs

# --- Create app user ---
if ! id "$APP_USER" &>/dev/null; then
  log "Creating user: $APP_USER"
  useradd -r -m -s /bin/bash "$APP_USER"
else
  info "User $APP_USER already exists"
fi

# --- Sudoers: allow management commands for cachyui user ---
SUDOERS_FILE="/etc/sudoers.d/cachyui-systemctl"
log "Configuring sudoers for $APP_USER..."
cat > "$SUDOERS_FILE" << 'EOF'
# cachy-UI: allow management and maintenance commands without password
Defaults:cachyui env_keep += "DEBIAN_FRONTEND"
cachyui ALL=(ALL) NOPASSWD: /usr/bin/systemctl, \
    /usr/bin/pacman, \
    /usr/bin/checkupdates, \
    /usr/bin/pacman-key, \
    /usr/sbin/reboot, \
    /sbin/reboot, \
    /usr/bin/reboot, \
    /usr/sbin/poweroff, \
    /sbin/poweroff, \
    /usr/bin/poweroff, \
    /usr/bin/nmcli, \
    /usr/sbin/wpa_cli, \
    /usr/sbin/iw, \
    /usr/bin/iw, \
    /usr/bin/rfkill, \
    /usr/sbin/ip, \
    /usr/bin/ip, \
    /usr/bin/mount, \
    /usr/bin/umount, \
    /usr/bin/findmnt, \
    /usr/bin/lsblk, \
    /usr/bin/blkid, \
    /usr/bin/sfdisk, \
    /usr/bin/partprobe, \
    /usr/bin/parted, \
    /usr/bin/snapper, \
    /usr/sbin/snapper, \
    /usr/bin/btrfs, \
    /usr/sbin/btrfs, \
    /usr/bin/ufw, \
    /usr/sbin/ufw, \
    /usr/bin/efibootmgr, \
    /usr/bin/mokutil, \
    /usr/bin/du, \
    /usr/bin/df, \
    /usr/bin/wget, \
    /usr/bin/tailscale, \
    /usr/bin/env, \
    /usr/bin/su, \
    /usr/bin/sudo
EOF
chmod 440 "$SUDOERS_FILE"

visudo -cf "$SUDOERS_FILE" || err "Invalid sudoers file"

# --- Sudoers for primary user (terminal access without password) ---
PRIMARY_USER=$(getent passwd 1000 | cut -d: -f1 2>/dev/null || echo "")
if [[ -n "$PRIMARY_USER" ]]; then
  USER_SUDOERS="/etc/sudoers.d/${PRIMARY_USER}-nopasswd"
  log "Configuring sudoers for $PRIMARY_USER (terminal)..."
  cat > "$USER_SUDOERS" << EOF
# Allow $PRIMARY_USER to run management commands without password (terminal)
Defaults:$PRIMARY_USER env_keep += "DEBIAN_FRONTEND"
$PRIMARY_USER ALL=(ALL) NOPASSWD: ALL
EOF
  chmod 440 "$USER_SUDOERS"
  visudo -cf "$USER_SUDOERS" || err "Invalid sudoers file for $PRIMARY_USER"
fi

# --- Deploy app from GitHub ---
log "Cloning cachy-UI from GitHub..."
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "${TEMP_DIR:?}"' EXIT

if [[ -d "$APP_DIR/.git" ]]; then
  info "Existing installation found. Updating..."
  cd "$APP_DIR"
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR"; then
    git config --global --add safe.directory "$APP_DIR"
  fi
  git fetch origin "$BRANCH"
  git reset --hard FETCH_HEAD
else
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$TEMP_DIR"
  mkdir -p "$APP_DIR"
  # ドットファイルも含めてコピーし、.gitもデプロイする (/opt/cachy-ui自体がgitリポジトリになる)。
  # 新しい環境でここをワークスペースとして開いても git init 不要にするため。
  # TEMP_DIRはEXITトラップで削除される。
  cp -a "$TEMP_DIR/." "$APP_DIR/"
fi

# --- Python venv ---
log "Setting up Python virtual environment..."
if [[ ! -d "$APP_DIR/venv" ]]; then
  python3 -m venv "$APP_DIR/venv"
fi
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# --- Set ownership ---
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- Systemd service ---
log "Creating systemd service..."
cat > /etc/systemd/system/cachyui.service << EOF
[Unit]
Description=cachy-UI - Web-based CachyOS Management Interface
After=network.target

[Service]
Type=simple
# Run as root to allow setpriv-based user switching for the terminal (like selfcode)
# The web UI is only accessible via Tailscale serve (HTTPS), so this is safe.
User=root
Group=root
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port $APP_PORT
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cachyui.service

if [[ $NO_RESTART -eq 1 ]]; then
  log "Update deployed. Restart cachy-UI manually to apply the new version."
else
  systemctl restart cachyui.service

  sleep 2
  if systemctl is-active --quiet cachyui.service; then
    log "cachy-UI is running on port $APP_PORT"
  else
    err "Failed to start cachy-UI. Check: journalctl -u cachyui -f"
  fi
fi

# --- Tailscale serve configuration ---
log "Configuring Tailscale serve (HTTPS on port 3355)..."

TS_HOSTNAME=$(tailscale status --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'].rstrip('.'))" 2>/dev/null || echo "")
if [[ -z "$TS_HOSTNAME" ]]; then
  warn "Could not determine Tailscale hostname."
  warn "Please run manually: tailscale serve --bg --https 3355 http://127.0.0.1:$APP_PORT"
else
  info "Tailscale hostname: $TS_HOSTNAME"
  info "URL: https://$TS_HOSTNAME:3355"
fi

tailscale serve --bg --https 3355 http://127.0.0.1:$APP_PORT 2>/dev/null || {
  warn "Tailscale serve configuration failed."
  warn "Run this manually after the script completes:"
  warn "  tailscale serve --bg --https 3355 http://127.0.0.1:$APP_PORT"
}

# --- Done ---
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ✅ cachy-UI Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${CYAN}Local URL:${NC}  http://127.0.0.1:$APP_PORT"
if [[ -n "$TS_HOSTNAME" ]]; then
  echo -e "  ${CYAN}Tailscale:${NC}  https://$TS_HOSTNAME:3355"
fi
echo ""
echo -e "  ${CYAN}Service:${NC}    systemctl status cachyui"
echo -e "  ${CYAN}Logs:${NC}       journalctl -u cachyui -f"
echo -e "  ${CYAN}Dir:${NC}        $APP_DIR"
echo ""
echo -e "${YELLOW}⚠  Only accessible from within Tailnet!${NC}"
echo -e "${YELLOW}   LAN access is blocked by Tailscale serve.${NC}"
echo ""
