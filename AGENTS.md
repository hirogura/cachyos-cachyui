# AGENTS.md

このリポジトリで AI エージェント（opencode / Codex / Claude 等）が作業する際のルール。

## プロジェクト概要
- serv-UI (Ubuntu/GRUB/apt) を CachyOS (Limine/pacman) に移植した Web 管理 UI「cachy-UI」。
- `main.py` FastAPIバックエンド / `templates/index.html` + `static/app.js` フロント / `setup.sh`・`uninstall.sh` CachyOS用導入スクリプト。
- GRUB編集→Limine編集 (cachy-isoboot方式)、バックアップ/復元→cachyos-clonezilla-auto方式、Timeshiftは除外 (snapperのため)、パッケージ管理はpacman。

## セットアップ / ビルド / テスト
- 依存関係の導入: `python3 -m venv venv && venv/bin/pip install -r requirements.txt`
- 構文チェック: `python3 -m py_compile main.py && node --check static/app.js`
- 開発起動: `venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 3355 --reload`
- 本番導入: `sudo bash setup.sh` (CachyOS + Tailscale接続済みが前提)

## コーディング規約
- 既存のコードスタイルに合わせる（フォーマッタ・リンタの設定があればそれに従う）
- 必要最小限の変更に留め、関係ないリファクタはしない
- 日本語でコメント・説明を書く

## 注意事項
- 秘密情報（APIキー・トークン・パスワード）をコードやログに含めない
- `.env` や認証情報ファイルは作成・変更してもコミットしない
- 破壊的な操作（`rm -rf` / `git reset --hard` / `git push --force` 等）は事前に確認を取る
- 不明点があれば推測で進めず、質問して確認する
