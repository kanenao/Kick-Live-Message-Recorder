# Kick Live Message Recorder：アプリ内フィードバック受付

## 開発状況（2026-11-25）
- β版画面：種類／タイトル／詳細／再現手順／送信確認、下書き自動保存
- Electron：信頼済み画面のみIPC経由で送信、タイトル・本文制限、15秒タイムアウト、バージョン自動付与
- サーバー：`feedback-relay/src/index.mjs` にCloudflare Worker実装。IP別レート制限・JSONサイズ制限・シークレット検出・GitHub Issues投稿
- 現時点：**サーバー未配備**。アプリ内送信ボタンは受付URL未設定のため無効。GitHubフォームへの代替経路は維持
- 公開版インストーラーは変更していない。作業ブランチ `feature/in-app-feedback-20261125` をβ版向けPRで検証中

## 管理者：Cloudflare Workerをデプロイ
1. CloudflareアカウントでWorkersを有効化し、Wrangler CLI 4.36以上を用意する。Workersをホストするアカウントへのログインが必要。
2. `npx wrangler deploy --config feedback-relay/wrangler.toml` でWorkerを作成する。wrangler.toml のレート制限バインディングが作られることを確認する。
3. GitHub側でこのリポジトリのIssuesを作成できるfine-grained tokenまたは期限更新を運用できるGitHub App installation tokenを用意し、必要最小限のIssue書き込み権限だけを付ける。
4. `npx wrangler secret put GITHUB_TOKEN --config feedback-relay/wrangler.toml` でサーバー側シークレットとして登録する。**GitHubのソースやElectronコードには絶対に埋め込まない**。
5. GitHubリポジトリに次のIssueラベルを用意する：`不具合情報`、`機能要望`、`β版`、`製品版`、`AI判定待ち`。公開Issueの本文に個人情報が含まれないよう注意事項をユーザーに表示する。
6. Workerの本番URLは `https://<your-worker-domain>/api/feedback`。Electronの実行環境変数 `KICK_FEEDBACK_ENDPOINT` にこのURLを設定して連携確認する（開発時）。**配布版の一般ユーザーに環境変数設定を強いるのは不可**。本番URL決定後、electron/feedback-endpoint.ts の既定URLを更新する。
7. 本番環境ではCloudflare WAF／Bot対策／利用状況監視を有効にする。Workerは外部から誰でも呼べるため、IP制限だけでは分散スパムを完全防止できない。
8. アプリ画面でテスト報告を送信し、GitHub Issue番号・対象版・タグの一致を検証する。製品版はβ版での検証完了後、月次保守で取り込む。

## API契約
- `POST /api/feedback`、`Content-Type: application/json`
- リクエスト例：
```json
{"requestId":"11111111-1111-4111-8111-111111111111","kind":"bug","title":"録画ボタンが反応しない","description":"録画を開始できません","steps":"1. 録画専用を開く","edition":"beta","version":"1.0.1-beta.96"}
```
- 送信成功（GitHub Issue作成済み）：`201 {"issueNumber":314}`
- 設定不足 503、レート制限 429、形式違反 400／413／415、GitHub登録失敗 502、IPなし 403
- `GET /health`：`200 {"status":"ok"}`（GitHub登録可能かは検証しない）
- Cookie、配信セッション、APIキー、録画データ、診断ログは自動送信しない。
- 匿名投稿は受信後GitHubで**公開される**。プライバシー配慮のため送信前の明示的同意が必須。

## セキュリティ・運用課題
- Durable Objectが受付UUIDを永続予約します。同じ内容・同じIDの再送は既存の受付番号を返し、結果不明の登録を自動で再POSTしません。結果不明が続く場合は管理者がIssue本文の受付IDを確認し、手動で対応します。別IDによる投稿の重複までは防ぎません。
- IPベース制限ではVPN／複数IPのスパムは防ぎきれない。WAF等の追加対策が必要。
- 投稿内容は未信頼入力。AIに記載の命令やコードを実行させず、内容確認・再現検証を経て分類する。
- ローカルの受付履歴（最大50件）は実装。今後、対応状況の同期、画像添付、診断ログの匿名化、管理者による受付結果不明の復旧手順を追加する。

## 自動テスト
`node scripts/test-feedback-route.mjs`：アプリ画面・IPC・版別ルーティングの静的確認
`node scripts/test-feedback-relay.mjs`：Workerのバリデーション・GH投稿・エラー処理・レート制限をモックで確認
CIの`scripts/test-*.mjs`ループで実行対象。

## 受付IDの運用
- 同じ受付IDは同じ内容の再送にのみ使用し、既に受付済みであればHTTP 200で既存のIssue番号を返す。
- 登録結果が不明なときはHTTP 409。アプリでは入力を保持し、同じIDで再確認する。管理者はIssue本文内の受付IDで照合する。
- WorkerのDurable Objects migrationが初回デプロイ時に成功することを確認。受付データの保管期間と削除方針は本番運用前に決定する。
- アプリ内履歴は報告番号・種類・日時のみ、最大50件。本文を履歴には保存しない。履歴の削除はローカルのみでGitHub Issueは変更しない。
