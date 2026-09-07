#!/bin/bash
set -e

# --- yes/noプロンプト関数 ---
ask_yn() {
    local prompt="$1"
    local answer
    while true; do
        read -rp "$prompt [y/n]: " answer
        case "$answer" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
            *) echo "y か n で答えてください。" ;;
        esac
    done
}

sudo timedatectl set-timezone Asia/Tokyo
sudo pacman -Syu --needed --noconfirm curl git

# --- Tailscale インストール ---
curl -fsSL https://tailscale.com/install.sh | sh

echo ""
if ask_yn "Tailscale の authkey がありますか？"; then
    read -rsp "authkey を入力してください（tskeyから始まる文字列。入力は非表示）: " TS_AUTHKEY
    echo ""
    USE_TS_AUTHKEY=true
else
    USE_TS_AUTHKEY=false
fi

echo ""
if [ "$USE_TS_AUTHKEY" = true ]; then
    sudo tailscale up --authkey="$TS_AUTHKEY"
else
    echo "[info] authkey未入力のためブラウザ認証フローを開始します"
    sudo tailscale up
fi

# --- cachyos-cachyui セットアップ ---
if [ -d cachyos-cachyui ]; then
    cd cachyos-cachyui
    git pull
else
    git clone https://github.com/hirogura/cachyos-cachyui.git
    cd cachyos-cachyui
fi
sudo bash setup.sh