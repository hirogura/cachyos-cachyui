#!/usr/bin/env bash
# =============================================================================
# install-selfrdp-cachy.sh
#   SelfRDP (https://github.com/hirogura/selfrdp.git) を cachy-UI 内蔵用に
#   CachyOS (pacman) へ導入する。
#
#   - 接続先はこの PC (127.0.0.1:3389) 固定
#   - Devolutions Gateway は 7171、SelfRDP 制御 API は 7172 のループバックのみ
#   - Tailscale Serve の公開ポートは作らない。WASM 配信と Gateway 中継は
#     cachy-UI (3355) が行うため、ブラウザから見えるポートは 3355 のまま
#
#   実行場所: cachy-UI を稼働させている PC (root)
#   使い方:   sudo bash /opt/cachy-ui/install-selfrdp-cachy.sh
# =============================================================================
set -Eeuo pipefail

SR_DIR="/opt/selfrdp"
SR_REPO="https://github.com/hirogura/selfrdp.git"
SR_DATA_DIR="/opt/selfrdp-data"
DGW_CFG_DIR="/etc/devolutions-gateway"
DGW_PORT="7171"
SR_API_PORT="7172"
SR_VERSION="v.0.9.0"

log()  { printf '\033[1;34m[selfRDP]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "行 $LINENO で失敗しました"' ERR

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,/^set -Eeuo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

[[ $EUID -eq 0 ]] || die "root で実行してください"
command -v pacman >/dev/null 2>&1 || die "pacman が使えません (CachyOS 用のスクリプトです)"

# 中断した pacman が残したロックを除去 (setup.sh と同じ対策)
remove_stale_pacman_lock() {
  if [[ -e /var/lib/pacman/db.lck ]]; then
    if pgrep -x pacman >/dev/null 2>&1 || pgrep -f "pacman -S" >/dev/null 2>&1; then
      die "pacman が実行中です。完了後に再実行してください"
    fi
    warn "残留ロック /var/lib/pacman/db.lck を削除します"
    rm -f /var/lib/pacman/db.lck
  fi
}
remove_stale_pacman_lock

# ---------------------------------------------------------------- 依存パッケージ
log "依存パッケージを確認します"
MISSING=()
for pkg in git curl jq openssl python python-pyjwt libarchive; do
  pacman -Q "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if (( ${#MISSING[@]} > 0 )); then
  log "pacman で導入します: ${MISSING[*]}"
  pacman -S --needed --noconfirm "${MISSING[@]}"
fi

# SelfRDP 本体 (IronRDP WASM アセット / 制御 API) を取得する
log "SelfRDP $SR_VERSION を $SR_DIR に配置します"
if [[ -d "$SR_DIR/.git" ]]; then
  git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$SR_DIR" \
    || git config --system --add safe.directory "$SR_DIR" 2>/dev/null || true
  git -C "$SR_DIR" pull --ff-only
else
  [[ ! -e "$SR_DIR" ]] || die "$SR_DIR が既に存在します (git リポジトリではありません)"
  git clone --depth 1 "$SR_REPO" "$SR_DIR"
fi
for f in selfrdp-control.py iron-assets/index.html iron-assets/pkg/ironrdp_web.js iron-assets/pkg/ironrdp_web_bg.wasm; do
  [[ -f "$SR_DIR/$f" ]] || die "$SR_DIR/$f が見つかりません"
done
chmod 0755 "$SR_DIR/selfrdp-control.py"

# ---------------------------------------------- Devolutions Gateway (RDP 中継)
log "Devolutions Gateway を導入します"
case "$(uname -m)" in
  x86_64|amd64) DGW_ARCH="x64" ;;
  aarch64|arm64) DGW_ARCH="arm64" ;;
  *) die "未対応のアーキテクチャです: $(uname -m)" ;;
esac

dgw_url="$(curl -fsSL https://api.github.com/repos/Devolutions/devolutions-gateway/releases/latest \
  | jq -r --arg a "$DGW_ARCH" '[.assets[] | select(.name | test("^devolutions-gateway-.*-" + $a + "\\.rpm$"))][0].browser_download_url')"
[[ -n "$dgw_url" && "$dgw_url" != "null" ]] || die "$DGW_ARCH 用の Gateway RPM が見つかりません"

curl -fsSL "$dgw_url" -o /tmp/selfrdp-gateway.rpm
rm -rf /tmp/selfrdp-gateway-extract
mkdir -p /tmp/selfrdp-gateway-extract
bsdtar -xf /tmp/selfrdp-gateway.rpm -C /tmp/selfrdp-gateway-extract
rm -f /tmp/selfrdp-gateway.rpm

install -Dm755 /tmp/selfrdp-gateway-extract/usr/bin/devolutions-gateway /usr/bin/devolutions-gateway
install -Dm644 /tmp/selfrdp-gateway-extract/usr/lib/devolutions-gateway/libxmf.so \
  /usr/lib/devolutions-gateway/libxmf.so
if [[ -d /tmp/selfrdp-gateway-extract/usr/share/devolutions-gateway/webapp ]]; then
  mkdir -p /usr/share/devolutions-gateway
  cp -a /tmp/selfrdp-gateway-extract/usr/share/devolutions-gateway/webapp \
    /usr/share/devolutions-gateway/
fi
rm -rf /tmp/selfrdp-gateway-extract

# 公開用の Web UI は使わない。ASSOCIATION トークンの検証鍵だけを共有する。
mkdir -p "$DGW_CFG_DIR"
if [[ ! -s "$DGW_CFG_DIR/provisioner.key" ]]; then
  openssl genrsa -out "$DGW_CFG_DIR/provisioner.key" 2048 2>/dev/null
  openssl rsa -in "$DGW_CFG_DIR/provisioner.key" -pubout -out "$DGW_CFG_DIR/provisioner.pem" 2>/dev/null
fi
chmod 600 "$DGW_CFG_DIR/provisioner.key"

tmp="$(mktemp)"
jq -n \
  --arg int "http://127.0.0.1:$DGW_PORT" \
  --arg key "$DGW_CFG_DIR/provisioner.key" \
  --arg pem "$DGW_CFG_DIR/provisioner.pem" \
  '{
    Hostname: "localhost",
    ProvisionerPublicKeyFile: $pem,
    ProvisionerPrivateKeyFile: $key,
    Listeners: [{ InternalUrl: $int, ExternalUrl: $int }],
    WebApp: { Enabled: false }
  }' > "$tmp"
install -m 0640 "$tmp" "$DGW_CFG_DIR/gateway.json"
rm -f "$tmp"

cat > /etc/systemd/system/selfrdp-gateway.service <<EOF
[Unit]
Description=Devolutions Gateway for cachy-UI Remote Desktop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/devolutions-gateway --service
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------- SelfRDP 制御 API / 接続先データ
log "SelfRDP の制御 API と接続先データを設定します"
install -d -m 0700 "$SR_DATA_DIR"
if [[ ! -f "$SR_DATA_DIR/profiles.json" ]]; then
  printf '{"profiles":[]}\n' > "$SR_DATA_DIR/profiles.json"
  chmod 0600 "$SR_DATA_DIR/profiles.json"
fi

cat > /etc/systemd/system/selfrdp.service <<EOF
[Unit]
Description=SelfRDP Control Service ($SR_VERSION / cachy-UI built-in)
After=network-online.target selfrdp-gateway.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SR_DIR
Environment=SELFRDP_API_PORT=$SR_API_PORT
ExecStart=/usr/bin/python3 $SR_DIR/selfrdp-control.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now selfrdp-gateway.service
systemctl enable --now selfrdp.service

for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$SR_API_PORT/api/status" >/dev/null 2>&1 && break
  sleep 1
done

cat <<EOF

==================== SelfRDP $SR_VERSION (cachy-UI 内蔵) 完了 ====================
  利用方法   : cachy-UI サイドバーの「リモートデスクトップ」
  接続先     : この PC (127.0.0.1:3389) 固定
  公開ポート : なし (cachy-UI の 3355 経由のみ。tailscale serve は未変更)
  内部ポート : Gateway $DGW_PORT / 制御 API $SR_API_PORT (どちらも loopback のみ)

  RDP サーバー (krdp など) がこの PC で待受していないと接続できません。
  ログ確認   : journalctl -u selfrdp-gateway -u selfrdp -f
================================================================================
EOF
