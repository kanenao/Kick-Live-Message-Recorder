# Kickチャット受信の設定（β11）

## 仕組み

本アプリはKick公式Events APIの `chat.message.sent`（version 1）を購読し、Kickから届くWebhookを受信します。受信内容はKickの公開鍵を取得してRSA署名を検証した後、録画保存先の `ChatLogs` フォルダーにJSONL形式で保存します。

## 初回設定

1. Kick Developerで作成済みアプリを開き、Webhooksを有効にします。
2. アプリの設定画面でKick API認証情報を登録します。
3. 「チャット受信を開始」を押します。ローカル受信サーバーとCloudflare Quick Tunnelが起動します。
4. 表示されたWebhook URLをコピーし、Kick DeveloperのWebhook URL欄へ登録して保存します。
5. アプリに戻って「登録チャンネルを購読」を押します。
6. 配信中の対象チャンネルでコメントを投稿し、受信件数と `ChatLogs` を確認します。

Webhook送信先は `https://...trycloudflare.com/kick/webhook` です。Quick Tunnelは再起動ごとにURLが変わるため、アプリを再起動した場合はKick Developer側のURLも更新してください。

## 保存先

録画保存先の `ChatLogs/<チャンネル名>_YYYYMMDD.jsonl` に1コメント1行で保存します。本文・投稿者名・配信者名・Kickの作成時刻・アプリ受信時刻・バッジ・エモート位置を保存します。

## 注意事項

- 受信サーバーとTunnelはアプリ起動中のみ稼働します。連続受信にはWindowsでアプリを起動したままにしてください。
- 公式WebhookのURL設定はKick Developer側で手動操作が必要です。アプリからDeveloper Portalの設定は変更できません。
- 購読登録APIの成功と実際にWebhookが到着することは別です。画面の受信件数が増えることを必ず確認してください。
- Kick公式資料にはWebhookが届かないケースの報告もあります。受信が0件のままの場合はDeveloper設定、購読状態、Kick側のWebhook配信制限・障害を確認してください。
- 視聴者が送信したコメントは配信者本人の発言ではありません。AI記事生成時も発言者を区別してください。
