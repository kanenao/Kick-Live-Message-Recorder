# チャット受信方式（β15）

β15では、Kickの公開チャットにアプリから直接接続する方式へ変更しました。

## 接続手順

1. チャンネル名からKickのチャットルームIDを解決します。
2. Kick Webサイト側のリアルタイム接続APIからCentrifugoの接続先とゲストトークンを取得します。
3. CentrifugoへWebSocket接続し、`chatrooms.<chatroom_id>.v2` を購読します。
4. 切断時は指数バックオフで再接続し、ゲストトークンの期限前にも接続を更新します。

## ユーザー設定

- ngrok、Cloudflare Tunnel、独自ドメインは不要です。
- Kick DeveloperのWebhook設定は不要です。
- チャット受信にClient ID／Client Secretは使いません。
- 配信状態をKick公式APIで自動監視する場合のみ、Client ID／Client Secretを設定します。

## 注意

この受信方式はKickのWebサイト内部APIとCentrifugo接続仕様に依存する非公式方式です。Kickが内部仕様やアクセス制御を変更した場合、修正が必要になる可能性があります。公式APIと同等の安定性は保証できません。

## テスト

型チェック・アプリビルド・Windowsインストーラー作成はGitHub Actionsで確認します。実際のコメント受信はWindows版を起動して、公開チャンネルのチャットで別途実機確認してください。
