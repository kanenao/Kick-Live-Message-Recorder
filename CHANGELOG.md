# 更新履歴

## 0.1.0-beta.11

- Kick APIのClient Credentials認証を単独で確認できる「接続テスト」を追加。
- 接続テストでApp Access Tokenを取得できるか確認し、結果を日本語で表示。
- Client Secretは従来どおりWindowsの暗号化ストレージに保存し、テスト結果や画面に表示しない。
- チャット取得に必要な公開HTTPS Webhookとイベント購読が、API認証とは別設定であることを明記。

## 0.1.0-beta.10

- Electronのfile://起動時に画面が白くなる問題に対応するため、ビルド済みアセットの参照を相対パスに変更。
- CIで相対アセットパスを検証。
