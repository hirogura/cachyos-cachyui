# cachy-UI

Webベースの CachyOS 管理ツール。Tailscale内のHTTPS経由でアクセス可能。
[serv-UI](https://github.com/hirogura/servui) (Ubuntu/GRUB/apt) を CachyOS (Limine/pacman) 用に移植したもの。

現在のバージョン: **v3.4.4**

## serv-UI からの主な変更点

| 項目 | serv-UI (Ubuntu) | cachy-UI (CachyOS) |
|------|------------------|---------------------|
| パッケージ管理 | apt (`apt update/upgrade`, dpkg修復) | pacman (`pacman -Qu/-Syu/-Syyu`, キーリング修復, 孤立パッケージ削除) + AUR / Flatpak 更新 (cachy-update 相当) |
| ブートローダ編集 | GRUB編集 (`/etc/grub.d/40_custom` + `update-grub` + `grub-reboot`) | Limine編集 (`/boot/limine.conf` の `/+ISO Boot` + `/boot/isos/` カーネル取り出し。即時反映) |
| ISOブート方式 | GRUB loopback (ISO内カーネル直接起動) | cachy-isoboot 方式 (ISOからvmlinuz/initramfsを取り出して linux プロトコル起動。archiso/casper/live 対応) |
| /iso 作成 | 手動 | create-isopart 連携 (Btrfs縮小 + ext4 /iso 作成の状態表示・ターミナル誘導) |
| ISOダウンロード | Ubuntu ISO一覧 + 汎用URL | CachyOS ISO一覧 (desktop / kde / handheld / cli のエディション選択) + 汎用URL |
| バックアップ/復元 | GRUBループバック + `grub-reboot` による次回1回起動 | cachyos-clonezilla-auto 方式 (Limine サブエントリ Clonezilla-AutoBackup/Restore + default_entry 操作。toram 必須)。Clonezilla Live ISO のダウンロードにも対応 |
| ディスク管理 | このUI内でパーティション操作 | ディスク情報は表示専用。作成・削除・マウント等操作は別アプリ「Disk Manager」に分離 |
| Timeshift | あり (rsync/btrfs) | なし (snapper があるため当面外す) |
| 連携アプリ導入先 | Ubuntu版リポジトリ | Ubuntu/CachyOS共通リポジトリ (selfEx / selfcode / easylxd / vmmanager / Disk Manager / Ventoy-UI) |
| インストール先 | `/opt/servui` / `servui` ユーザー / `servui.service` | `/opt/cachy-ui` / `cachyui` ユーザー / `cachyui.service` |
| ポート | 3355 | 3355 (同じ)。連携アプリは 3329 / 3339 / 3361 / 3362 / 3363 / 3379 / 8090 |

## 機能

| 機能 | 説明 |
|------|------|
| ダッシュボード | CPU・温度・メモリ・ディスク使用率、トッププロセス、システム情報を表示 |
| サービス管理 | systemdサービスの起動・停止・再起動・有効化/無効化・ステータス確認 |
| パッケージ管理 | pacman更新確認・一括更新 (`-Syu`)・個別更新・DB更新/キーリング修復・強制更新 (`-Syyu`)・孤立パッケージ削除。公式/AUR/Flatpak をまとめて確認・更新する cachy-update 相当の一括更新、AUR・Flatpak の個別更新にも対応 |
| 公開ポート | `ss -tulnp` で待受ポートとプロセスを一覧表示し、LANからの到達性を表示 |
| ターミナル | ブラウザ上のWebターミナル (ユーザーアカウントで~に接続)。サーバー側でセッションを保持するため、ブラウザを閉じても実行中の処理は継続し、再接続時に出力を復元。「新規セッション」「クリア」「セッション終了」ボタンを装備 |
| Wi-Fi管理 | 周囲のWi-Fiスキャン・接続・切断・保存済み接続の削除・Wi-FiラジオのON/OFF |
| ディスク | ディスク・パーティション情報の表示専用ページ。パーティションの作成・削除・マウント・LVM操作は「Disk Manager」で実施 |
| Limine編集 | Limineエントリー一覧・削除、ISOブートエントリー追加 (cachy-isoboot 方式)、/iso 状態表示・create-isopart 誘導、CachyOS ISO (エディション選択)・汎用ISOダウンロード（/isoへwget保存、進捗表示・キャンセル対応）、default_entry・表示時間(timeout) 設定 |
| selfEx / Disk Manager / selfcode / Easy LXD / VM Manager | 連携アプリの導入状態確認と起動。未インストールの場合は確認ダイアログ表示後にターミナルでインストール、インストール済みならサイトを新しいタブで開く |
| バックアップ/復元 | /iso 内の Clonezilla Live ISO からカーネルを取り出して Limine 起動する無人パーティションバックアップ・復元 (cachyos-clonezilla-auto 方式)。SourceForge から Clonezilla Live ISO を選択・ダウンロードして /iso に保存可能 |
| Snapper | snapper スナップショットの一覧・作成・復元 (rollback)・削除、複数一括削除、設定 (保持数など) とサブボリュームの管理 |
| アプリ/設定 | よく使うアプリ (日本語入力・Chrome・Edge・Thunderbird・LibreOffice・VLC・SSH・リモートデスクトップ) のチェック式一括インストールとデスクトップショートカット作成 (cachyos-scripts の 3-soft.sh / 4-desktopicon.sh と同じ内容)。Ventoy-UI の導入、OpenCode Desktop の導入 (pacman + Tailscale Serve の HTTPS:3379 でテールネット内のみ公開) とペアリングリンク・パスワード表示、URLを開く・サービス再起動、ノートPCの蓋閉じスリープ抑止、pacman ロックファイル削除、旧 simdjson への切り戻し (更新直前のバージョンを自動選択、nodejs 再ビルドまで) |
| cachy-UI一括管理 | Tailnet内で稼働中のcachy-UIを自動検出して一覧表示。ピン留めしたサーバーをページ上部に固定表示し、更新間隔 (5秒〜1分) やタブ非表示時の更新停止を設定可能。ホスト名クリックで新しいタブで開く |
| システム操作 | cachy-UIの再起動・アップデート、PC本体の再起動・シャットダウン |

### Limine編集について

- [create-isopart](https://github.com/hirogura/create-isopart.git) で作成した `/iso` (ext4) を前提とします。
- [cachy-isoboot](https://github.com/hirogura/cachyos-isoboot.git) と同じ方式で、ISO から `vmlinuz` / `initramfs` を `/boot/isos/<名前>/` に取り出し、`/boot/limine.conf` の「`/+ISO Boot`」セクションにサブエントリを追加します（同名は上書き更新、変更前は `/root/limine-boot-backups/` にバックアップ）。
- `limine.conf` は即時反映のため `update-grub` のような再生成コマンドは不要です。
- ブートメニューの表示時間 (`timeout`) は 1〜10 秒で変更できます（変更前はバックアップ取得）。
- CachyOS ISO は `desktop` / `kde` / `handheld` / `cli` のエディションから選んでミラーよりダウンロードできます。
- live (Debian/Clonezilla) 方式の制限として、`/iso` が LUKS 暗号化・btrfs サブボリューム配下・xfs/f2fs の場合は起動に失敗します。ext4/vfat または btrfs 既定サブボリューム直下に置いてください（検出時は警告を表示）。

### バックアップ/復元について

[cachyos-clonezilla-auto](https://github.com/hirogura/cachyos-clonezilla-auto.git) と同じ方式の無人バックアップ/復元です。

- **パーティションのみ対応**（LVMは非対応）
- 事前に**保存用パーティション**を用意し、**`/iso` にマウント**しておく必要があります ([create-isopart](https://github.com/hirogura/create-isopart.git) 推奨)
- `clonezilla-live-*.iso` を `/iso` 直下に配置しておきます。UI から SourceForge の Clonezilla Live stable のバージョン・ISO を選んでダウンロードすることもできます
- イメージ名は `cachyos-YYYY-MM-DD` (同日実行済みなら時刻付き)
- バックアップ/復元時: 次回1回のみ `default_entry` を AutoBackup/AutoRestore に設定し、Live 内 `ocs_prerun`/`ocs_postrun` で通常 (バックアップ時は `linux-cachyos` の番号、例: 2) へ戻し、`remember_last_entry` は no に固定する (yes に戻すと AutoBackup を再選択して無限ループになるため)
- メインのパーティション開始直前の superblock 読み込みに時間がかかることがあるが、partclone が使用中ブロック特定のためファイルシステム全体を走査する仕様であり、対応は困難 (待てば処理自体は成功する)
- `toram` で起動するため RAM に余裕が必要です（目安: 空き 2GB 以上）
- **Secure Boot非対応**のため、無効化しておく必要があります

### アプリ導入について

[cachyos-scripts](https://github.com/hirogura/cachyos-scripts.git) と同じ内容です。

- **アプリのインストール**: [3-soft.sh](https://github.com/hirogura/cachyos-scripts.git) を参考に、日本語入力 (fcitx5 + Mozc の [cachyos-mozcjp.sh](https://github.com/hirogura/scripts/main/cachyos-mozcjp.sh) を実行)・Google Chrome / Microsoft Edge (`paru` 経由)・Thunderbird・LibreOffice・VLC・SSH (`sshd` 有効化 + `ufw allow ssh`)・リモートデスクトップ (`krdp`) をチェック式で一括インストールします。
- **デスクトップショートカット**: [4-desktopicon.sh](https://github.com/hirogura/cachyos-scripts.git) を参考に、Chrome / Edge / Thunderbird / LibreOffice (Calc・Writer・Impress) / VLC / Dolphin / KDEシステム設定 / Konsole / KWrite / システムモニタ / アップデート (`pacman -Syu`) のショートカットをチェック式でデスクトップに作成します。
- **Ventoy-UI**: [ventoy-ui](https://github.com/hirogura/ventoy-ui.git) を `/opt/ventoy-ui` に取得し、systemd サービス (`ventoy-ui`) として登録・起動します。Tailscale Serve 経由 (HTTPS:3363) で利用できます。
- **その他の設定**: ノートPCで画面を閉じてもスリープしない設定 (systemd-logind の蓋閉じ動作を `ignore` に変更) と、pacman のロックファイル (`/var/lib/pacman/db.lck`) の削除 (CachyOS Hello の「Remove db lock」と同じ動作) を切り替えられます。
- **旧 simdjson への切り戻し**: `cachyupdate` で simdjson が 2:5.2.0 に更新されると `libsimdjson.so.36` が消え、旧 SONAME にリンクされた nodejs が起動不可になります (pacman は SONAME 変更を検出できず nodejs が再ビルドされないため)。「実行」ボタンでキャッシュ済み simdjson から `vercmp` により更新直前のバージョンを自動選択して戻し (バージョン固定なし)、`selfcode` / `easy-lxd` サービスを再起動します。`IgnorePkg` は設定しないため、nodejs が再ビルドされたら通常の更新に戻してください。

### 連携アプリ

- [selfEx](https://github.com/hirogura/selfex.git) — `/opt/selfex`, `:3362`
- [Disk Manager](https://github.com/hirogura/diskmanager.git) — `/opt/diskmanager`, `:3361` (ディスク・パーティション操作)
- [selfcode (Ubuntu/CachyOS共通)](https://github.com/hirogura/selfcode.git) — `/opt/lxd-data/selfcode`, `:3339`
- [Easy LXD (Ubuntu/CachyOS共通)](https://github.com/hirogura/easylxd.git) — `/opt/easy-lxd`, `:3329`
- [vmmanager (Ubuntu/CachyOS共通)](https://github.com/hirogura/vmmanager.git) — `/opt/vm-manage`, `:8090`
- [Ventoy-UI](https://github.com/hirogura/ventoy-ui.git) — `/opt/ventoy-ui`, `:3363` (「アプリ/設定」から導入)

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
    ├── psutil (システム情報)
    ├── ss (公開ポート一覧)
    ├── systemctl (サービス管理)
    ├── pacman / paru / flatpak (パッケージ管理)
    ├── lsblk / mount (ディスク情報表示)
    ├── limine.conf + /boot/isos (Limine編集)
    ├── Clonezilla Live 取り出しブート (バックアップ/復元)
    ├── snapper (スナップショット管理)
    └── WebSocket (ターミナル)

[連携アプリ (別サービス・Tailscale Serve 経由)]
    ├── selfEx       :3362  /opt/selfex
    ├── Disk Manager :3361  /opt/diskmanager
    ├── selfcode     :3339  /opt/lxd-data/selfcode
    ├── Easy LXD     :3329  /opt/easy-lxd
    ├── VM Manager   :8090  /opt/vm-manage
    └── Ventoy-UI    :3363  /opt/ventoy-ui
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
