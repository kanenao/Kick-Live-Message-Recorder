# Kick Live Message Recorder

Kickの配信を監視・録画し、公式Webhookでチャットを保存するWindowsデスクトップアプリです。ローカルOllamaを使った日本語の配信記事生成にも対応します。

<aside>
<strong>開発版：0.1.0-beta.14</strong><br />
チャットWebhook受信・JSONL保存、Ollamaによるライブ記事の自動生成を実装中です。Kick Developer側のWebhook URL設定と実配信での受信確認は、利用環境での初回設定が必要です。
</aside>

## β14 更新内容

- Kick公式APIから購読一覧を取得し、登録チャンネルごとの状態を表示
- 購読登録時は登録済みと確認できたチャンネルをスキップ
- 登録処理後に購読一覧を再取得して画面を更新

## 主な機能

- 日本語ダッシュボード・日本語メニュー・右クリックメニュー
- Kickチャンネルの追加・削除、自動/手動モード
- Kick公式APIで配信中/オフライン状態を確認
- 30秒〜10分間隔の配信自動監視、Windows通知
- 配信状態に応じた手動録画・自動録画
- yt-dlp / FFmpegを使った映像・音声の保存
- 録画ライブラリ、録画ファイルの再生・保存先表示
- Client SecretをWindowsのElectron safeStorageで暗号化して保存
- Kick公式Events APIの `chat.message.sent` をWebhookで購読
- チャンネル別の購読状態確認と、登録済みチャンネルの重複登録スキップ
- Cloudflare Quick TunnelでローカルのWebhook受信サーバーを公開
- Webhook署名をKick公開鍵で検証し、コメントをJSONL保存
- コメント投稿者・本文・時刻・バッジ・エモート位置を記録
- アプリ内チャットビューアーでリアルタイム表示・履歴検索
- チャットログのCSV（Excel向けUTF-8 BOM）/ JSONL書き出し
- Ollamaによる日本語の配信記事生成（クラウドAI APIキー不要）
- 新着コメントから約3分ごとのライブ記事スナップショット
- 配信終了を検知した際の最終記事生成
- 記事タブ、保存済み記事一覧、チャンネルごとの手動生成
- 起動時・6時間ごとの自動更新確認とダウンロード

## チャットWebhookの初回設定

1. Kick Developerで作成済みアプリを開き、Webhooksを有効にします。
2. アプリの設定画面でClient IDとClient Secretを保存します。
3. 「チャット受信を開始」を押し、表示されたWebhook URLをコピーします。
4. Kick DeveloperのWebhook URL欄に貼り付けて保存します。
5. アプリで「登録チャンネルを購読」を押します。
6. 実際の配信チャットを投稿して、アプリの受信件数が増えることを確認します。

Webhook URLはCloudflare Quick Tunnelから毎回発行されます。アプリ再起動後はURLが変わるため、Kick Developer側のWebhook URLも更新してください。設定手順の詳細は [CHAT-WEBHOOK-SETUP.md](CHAT-WEBHOOK-SETUP.md) を参照してください。

購読APIへの登録成功とWebhookの実配信成功は別です。Kick側のWebhook配信状況も含め、受信件数が増えることを確認してから運用してください。

## 無料のAI記事生成（Ollama）

1. Windows版Ollamaを https://ollama.com/download からインストールします。
2. PowerShellでモデルを取得します。

```powershell
ollama pull qwen2.5:3b
```

3. Ollamaを起動した状態でアプリの設定画面を開き、Ollamaの接続を確認します。
4. 「配信中の記事を自動生成」を有効にします。
5. チャット受信中に新着コメントがあれば約3分ごとに記事を保存します。

記事は録画保存先の `Articles` フォルダー、チャットは `ChatLogs` フォルダーに保存します。記事は保存した視聴者コメントとKickの番組情報を元に生成します。現時点では映像・音声の内容を直接解析する機能ではありません。記事生成はPC内のOllamaで行い、OpenAI APIキーや従量課金は不要です。モデルの実行速度はPCのメモリー・CPU/GPU性能に依存します。

## 自動アップデート

- Windows版は起動時と6時間ごとにGitHub Releasesを確認します。
- 新版があれば自動ダウンロードし、アプリ終了時に適用します。
- 設定画面から手動確認と再起動による更新適用ができます。
- リリース公開はバージョンと一致する `v*` タグをpushして実行します。

現在のWindowsビルドにはコード署名証明書がありません。一般配布前にコード署名証明書の導入を推奨します。

## 開発環境

Node.js 22以上を用意し、次を実行します。

```bash
npm install
npm run dev
```

Windows向けインストーラーをローカル作成する場合：

```bash
npm run dist:win
```

GitHub Actionsではmainブランチの型チェック・アプリビルド・Windowsインストーラー作成を実行します。

## データ保存

- チャンネル一覧、設定、暗号化認証情報はPC内に保存します。
- 録画ファイル、チャットログ、AI記事は設定画面の保存先フォルダーに保存します。
- チャットログ：`ChatLogs/<チャンネル名>_YYYYMMDD.jsonl`
- AI記事：`Articles/<チャンネル名>-<生成日時>.json`

## 技術構成

- Electron 45
- React 19 + TypeScript + Vite
- yt-dlp / FFmpeg
- Kick Public API / Events API
- Cloudflare Tunnel（Quick Tunnel）
- Ollama（既定モデル：qwen2.5:3b）
- Windows NSIS installer

## 注意事項

録画・チャット保存はKickの利用規約、配信者の権利、プライバシー、適用法令を守って利用してください。チャット保存の期間や削除要求への対応も含め、保存データを適切に管理してください。未公開の内部APIに依存する機能は安定機能として扱いません。
