# 更新履歴

## 0.1.0-beta.14

- Kickチャット受信で使用する `cloudflared.exe` がGitHub Releases向けインストーラーから漏れる問題を修正。
- Releases公開ジョブでも `yt-dlp.exe` と `cloudflared.exe` を取得・検査してからパッケージ化。
- 起動時にCloudflare Tunnel実行ファイルの配置場所を検査し、見つからない場合は確認した場所を含む日本語エラーを表示。


## 0.1.0-beta.13

- 配信の自動監視間隔を最短30秒から10秒へ短縮。
- 10秒・15秒・20秒・30秒・1分・2分・5分・10分から選択可能に変更。
- Kick APIがHTTP 429を返した場合はRetry-Afterを読み取り、指定時間の間は自動監視リクエストを抑制。

## 0.1.0-beta.12

- Kick公式Webhookで `chat.message.sent` を受信するローカルHTTPサーバーを追加。
- Cloudflare Tunnelを同梱し、Windowsアプリから公開HTTPS URLを発行できるように変更。
- Kick公開鍵を取得してWebhook署名（RSA-SHA256）を検証し、重複イベントを除外。
- 登録チャンネルのBroadcaster User IDを取得し、チャットイベント購読をKick APIへ登録。
- コメントをチャンネル・日付ごとのJSONLファイルに保存し、直近コメントをアプリ内に表示。
- チャット保存のON/OFFを設定可能に変更。

## 0.1.0-beta.11

- Kick APIのClient Credentials認証を単独で確認できる「接続テスト」を追加。
- 接続テストでApp Access Tokenを取得できるか確認し、結果を日本語で表示。
- Client Secretは従来どおりWindowsの暗号化ストレージに保存し、テスト結果や画面に表示しない。
- チャット取得に必要な公開HTTPS Webhookとイベント購読が、API認証とは別設定であることを明記。

## 0.1.0-beta.10

- Electronのfile://起動時に画面が白くなる問題に対応するため、ビルド済みアセットの参照を相対パスに変更。
- CIで相対アセットパスを検証。
