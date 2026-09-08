# cachy-UI

Webベースの CachyOS 管理ツール。Tailscale内のHTTPS経由でアクセス可能。
[serv-UI](https://github.com/hirogura/servui) (Ubuntu/GRUB/apt) を CachyOS (Limine/pacman) 用に移植したもの。

## serv-UI からの主な変更点

| 項目 | serv-UI (Ubuntu) | cachy-UI (CachyOS) |
|------|------------------|---------------------|
| パッケージ管理 | apt (`apt update/upgrade`, dpkg修復) | pacman (`pacman -Qu/-Syu/-Syyu`, キーリング修復, 孤立パッケージ削除) |
| ブートローダ編集 | GRUB編集 (`/etc/grub.d/40_custom` + `update-grub` + `grub-reboot`) | Limine編集 (`/boot/limine.conf` の `/+ISO Boot` + `/boot/isos/` カーネル取り出し。即時反映) |
| ISOブート方式 | GRUB loopback (ISO内カーネル直接起動) | cachy-isoboot 方式 (ISOからvmlinuz/initramfsを取り出して linux プロトコル起動。archiso/casper/live 対応) |
| /iso 作成 | 手動 | create-isopart 連携 (Btrfs縮小 + ext4 /iso 作成の状態表示・ターミナル誘導) |
| ISOダウンロード | Ubuntu ISO一覧 + 汎用URL | CachyOS ISO一覧 (build.cachyos.org ミラー) + 汎用URL |
| バックアップ/復元 | GRUBループバック + `grub-reboot` による次回1回起動 | cachyos-clonezilla-auto 方式 (Limine サブエントリ Clonezilla-AutoBackup/Restore + default_entry 操作。toram 必須) |
| Timeshift | あり (rsync/btrfs) | なし (snapper があるため当面外す) |
| 連携アプリ導入先 | Ubuntu版リポジトリ | CachyOS版リポジトリ (cachyos-selfcode / cachyos-easylxd / vmmanager-cachyos) |
| インストール先 | `/opt/servui` / `servui` ユーザー / `servui.service` | `/opt/cachy-ui` / `cachyui` ユーザー / `cachyui.service` |
| ポート | 3355 | 3355 (同じ) |

## 機能

| 機能 | 説明 |
|------|------|
| ダッシュボード | CPU・温度・メモリ・ディスク使用率、トッププロセス、システム情報を表示 |
| サービス管理 | systemdサービスの起動・停止・再起動・ステータス確認 |
| パッケージ管理 | pacman更新確認・一括更新 (`-Syu`)・個別更新・DB更新/キーリング修復・強制更新 (`-Syyu`)・孤立パッケージ削除 |
| ターミナル | ブラウザ上のWebターミナル (ユーザーアカウントで~に接続) |
| Wi-Fi管理 | 周囲のWi-Fiスキャン・接続・切断・設定管理 |
| ディスク管理 | パーティションのマウント（一時/永続）・作成・拡張・削除、LVM (VG/LV) の作成・リサイズ・削除 |
| Limine編集 | Limineエントリー一覧・削除、ISOブートエントリー追加 (cachy-isoboot 方式)、/iso 状態表示・create-isopart 誘導、CachyOS ISOダウンロード・汎用ISOダウンロード（/isoへwget保存、進捗表示・キャンセル対応）、default_entry 設定 |
| selfcode / Easy LXD / VM Manager | 連携アプリの導入と起動。未インストールの場合は確認ダイアログ表示後にターミナルでインストール、インストール済みならサイトを新しいタブで開く |
| バックアップ/復元 | /iso 内の Clonezilla Live ISO からカーネルを取り出して Limine 起動する無人パーティションバックアップ・復元 (cachyos-clonezilla-auto 方式) |
| Snapper | snapper スナップショットの一覧・作成・復元 (rollback)・削除 |
| アプリ | よく使うアプリ (日本語入力・Chrome・Thunderbird・LibreOffice・VLC・SSH・リモートデスクトップ・ddrescueGUI) のチェック式一括インストールとデスクトップショートカット作成 (cachyos-scripts の 3-soft.sh / 4-desktopicon.sh と同じ内容 + ddrescueGUI) |
| cachy-UI一括管理 | Tailnet内で稼働中のcachy-UIを自動検出して一覧表示。ピン留めしたサーバーをページ上部に固定表示し、ホスト名クリックで新しいタブで開く |
| システム操作 | cachy-UIの再起動・アップデート、PC本体の再起動・シャットダウン |

### Limine編集について

- [create-isopart](https://github.com/hirogura/create-isopart.git) で作成した `/iso` (ext4) を前提とします。
- [cachy-isoboot](https://github.com/hirogura/cachyos-isoboot.git) と同じ方式で、ISO から `vmlinuz` / `initramfs` を `/boot/isos/<名前>/` に取り出し、`/boot/limine.conf` の「`/+ISO Boot`」セクションにサブエントリを追加します（同名は上書き更新、変更前は `/root/limine-boot-backups/` にバックアップ）。
- `limine.conf` は即時反映のため `update-grub` のような再生成コマンドは不要です。
- live (Debian/Clonezilla) 方式の制限として、`/iso` が LUKS 暗号化・btrfs サブボリューム配下・xfs/f2fs の場合は起動に失敗します。ext4/vfat または btrfs 既定サブボリューム直下に置いてください（検出時は警告を表示）。

### バックアップ/復元について

[cachyos-clonezilla-auto](https://github.com/hirogura/cachyos-clonezilla-auto.git) と同じ方式の無人バックアップ/復元です。

- **パーティションのみ対応**（LVMは非対応）
- 事前に**保存用パーティション**を用意し、**`/iso` にマウント**しておく必要があります ([create-isopart](https://github.com/hirogura/create-isopart.git) 推奨)
- `clonezilla-live-*.iso` を `/iso` 直下に配置しておきます
- イメージ名は `cachyos-YYYY-MM-DD` (同日実行済みなら時刻付き)
- バックアップ時: 既定を `linux-cachyos` に固定 + `remember_last_entry` 無効化し、再起動後の Limine メニューで **ISO Boot → Clonezilla-AutoBackup** を手動選択
- 復元時: `default_entry` を AutoRestore に一時設定 (ocs_prerun 先頭で元に戻すため繰り返し実行なし)
- `toram` で起動するため RAM に余裕が必要です（目安: 空き 2GB 以上）
- **Secure Boot非対応**のため、無効化しておく必要があります

### アプリ導入について

[cachyos-scripts](https://github.com/hirogura/cachyos-scripts.git) と同じ内容です。

- **アプリのインストール**: [3-soft.sh](https://github.com/hirogura/cachyos-scripts.git) を参考に、日本語入力 (fcitx5 + Mozc の [cachyos-mozcjp.sh](https://github.com/hirogura/scripts/main/cachyos-mozcjp.sh) を実行)・Google Chrome (`paru` 経由)・Thunderbird・LibreOffice・VLC・SSH (`sshd` 有効化 + `ufw allow ssh`)・リモートデスクトップ (`krdp`)・[ddrescueGUI](https://github.com/hirogura/ddrescuegui.git) (`install.sh` を実行) をチェック式で一括インストールします。
- **デスクトップショートカット**: [4-desktopicon.sh](https://github.com/hirogura/cachyos-scripts.git) を参考に、Chrome / Thunderbird / LibreOffice (Calc・Writer・Impress) / VLC / Dolphin / KDEシステム設定 / Konsole / KWrite / システムモニタ / アップデート (`pacman -Syu`) のショートカットをチェック式でデスクトップに作成します。

### 連携アプリ

- [selfcode (CachyOS版)](https://github.com/hirogura/cachyos-selfcode.git) — `/opt/lxd-data/selfcode`, `:3339`
- [Easy LXD (CachyOS版)](https://github.com/hirogura/cachyos-easylxd.git) — `/opt/easy-lxd`, `:3329`
- [vmmanager (CachyOS版)](https://github.com/hirogura/vmmanager-cachyos.git) — `/opt/vm-manage`, `:8090`

## インストール

### 前提条件

- CachyOS (Limine ブートローダ、`/boot/limine.conf`)
- Tailscale がインストール済み・接続済み

```bash
# Tailscale インストール (未インストールの場合)
sudo pacman -S --needed tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
```

### 自動インストール (通常)

```bash
git clone https://github.com/hirogura/cachyos-cachyui.git
cd cachyos-cachyui
sudo bash setup.sh
```

または `install.sh` をダウンロードして実行 (タイムゾーン設定・Tailscale 接続まで自動で行います):

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/hirogura/cachyos-cachyui/main/install.sh
bash install.sh
```

オプション:

```bash
sudo bash setup.sh --branch main    # 指定ブランチからインストール (デフォルト: main)
sudo bash setup.sh --no-restart     # デプロイのみ行い、再起動は手動で実施
```

スクリプトは以下を自動で実行します:

1. pacman 依存パッケージのインストール (python/git/networkmanager/wget/efibootmgr 等)
2. `cachyui` ユーザーの作成
3. sudoers の設定 (systemctl/pacman 等をパスワードなしで実行可能)
4. GitHub からリポジトリをクローンして `/opt/cachy-ui` にデプロイ
5. systemd サービス (`cachyui.service`) の作成・起動
6. `tailscale serve` の設定 (HTTPS:3355)

### アクセス

Tailscale ネットワーク内のブラウザから:

```
https://YOUR-TAILSCALE-HOSTNAME:3355
```

※LANからはアクセス不可。Tailscale内からのみアクセス可能。

## アンインストール

```bash
git clone https://github.com/hirogura/cachyos-cachyui.git
cd cachyos-cachyui
sudo bash uninstall.sh
```

以下のものが削除されます:

- systemd サービス (cachyui.service)
- sudoers 設定 (/etc/sudoers.d/cachyui-systemctl)
- アプリケーション (/opt/cachy-ui)
- cachyui ユーザー
- Tailscale serve 設定 (HTTPS:3355)

※ `/boot/isos` や limine.conf の ISO Boot 項目、`/iso` パーティションは保持されます。

## サービス管理

```bash
# ステータス
systemctl status cachyui

# 再起動
sudo systemctl restart cachyui

# ログ
journalctl -u cachyui -f

# 停止
sudo systemctl stop cachyui
```

## セキュリティ

- ポート3355は**Tailscale内のみ**で公開
- LANからはアクセス不可 (`tailscale serve` が外部リクエストを拒否)
- `cachyui` ユーザーによる権限分離と sudoers によるコマンド制御

## アーキテクチャ

```
[ブラウザ (Tailscale内)]
    │
    ▼ HTTPS:3355
[Tailscale Serve] ← TLS終端
    │
    ▼ HTTP:127.0.0.1:3355
[FastAPI (cachy-UI)]
    │
    ├── psutil (システム情報)
    ├── systemctl (サービス管理)
    ├── pacman (パッケージ管理)
    ├── lsblk / mount / LVM (ディスク管理)
    ├── limine.conf + /boot/isos (Limine編集)
    ├── Clonezilla Live 取り出しブート (バックアップ/復元)
    └── WebSocket (ターミナル)
```

## 開発

```bash
git clone https://github.com/hirogura/cachyos-cachyui.git
cd cachyos-cachyui
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 3355 --reload
```

## License

[MIT](LICENSE)
