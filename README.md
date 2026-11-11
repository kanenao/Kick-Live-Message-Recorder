# Kick Live Message Recorder

Kick配信の録画・コメント保存を行うWindowsデスクトップアプリです。

**開発版：0.1.0-beta.15**

## 主な機能

- Kickチャンネルの登録・削除
- 配信中／オフライン状態の確認と自動監視
- 配信開始時のWindows通知
- yt-dlpによる配信映像・音声の保存
- 手動録画・配信開始時の自動録画
- Kickコメントのリアルタイム受信・JSONL保存
- アプリ内のコメント一覧表示
- 録画ファイル一覧と保存先フォルダー表示
- 起動時・定期的なアップデート確認

## コメント受信の使い方

1. ダッシュボードでコメントを取得したいKickチャンネルを登録します。
2. 設定画面の「Kickチャット受信」で「コメント受信を開始」を押します。
3. 受信したコメントは画面に表示され、設定が有効なら録画データの保存先にある `Chat/チャンネル名/YYYY-MM-DD.jsonl` に保存されます。

**ngrok、Cloudflare Tunnel、独自ドメイン、Webhook URLの登録、コメント受信用の追加トークンは不要です。** Kickの公開チャットへアプリから直接接続します。切断時は自動で再接続します。

### コメント受信方式について

コメント受信はKickのWebサイトが利用するリアルタイム接続（Centrifugo）と内部エンドポイントに依存します。Kickの公式公開Webhook/APIではありません。Kick側の仕様変更、アクセス制限、接続方法の変更により、一時的または恒久的に動作しなくなる可能性があります。公式APIとは異なるため、安定性を保証するものではありません。

## Kick API接続設定

Kick公式APIを使った配信状態の自動監視には、Kick Developerで作成したアプリのClient IDとClient Secretが必要です。設定画面で入力すると、Client SecretはWindowsの暗号化機能で保護して保存されます。

**コメントの直接受信だけなら、Kick DeveloperのClient ID／Client Secretも不要です。**

## 開発環境

- Node.js 22以上
- Windows 10/11（デスクトップアプリ）
- Electron、React、TypeScript、Vite

```bash
npm install
npm run dev
```

Windows向けインストーラーを作成する場合：

```bash
npm run dist:win
```

GitHub Actionsは型チェックとビルドを実行し、Windowsインストーラーを作成します。バージョンと一致する `release/vX.Y.Z` ブランチをpushすると、GitHub Releasesへのβ版公開処理が実行されます。

## データ保存

- チャンネル一覧・設定：Electronのユーザーデータ領域
- 録画映像・音声：設定画面で指定したフォルダー
- チャット：`Chat/チャンネル名/YYYY-MM-DD.jsonl`
- Client Secret：WindowsのElectron safeStorageで暗号化して保存

## 利用上の注意

録画・チャット保存はKickの利用規約、配信者の権利、プライバシー、適用法令を守って利用してください。配信者の許可を得たうえで利用し、保存したデータを適切に管理してください。
