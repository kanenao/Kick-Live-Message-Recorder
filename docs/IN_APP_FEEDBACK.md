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
3. GitHub側でこのリポジトリのIssuesを作成できるGitHub Appまたはfine-grained tokenを用意し、必要最小限のIssue書き込み権限だけを付ける。
4. `npx wrangler secret put GITHUB_TOKEN --config feedback-relay/wrangler.toml` でサーバー側シークレットとして登録する。**GitHubのソースやElectronコードには絶対に埋め込まない**。
5. GitHubリポジトリに次のIssueラベルを用意する：`不具合情報`、`機能要望`、`β版`、`製品版`、`AI判定待ち`。公開Issueの本文に個人情報が含まれないよう注意事項をユーザーに表示する。
6. Workerの本番URLは `https://<your-worker-domain>/api/feedback`。Electronの実行環境変数 `KICK_FEEDBACK_ENDPOINT` にこのURLを設定して連携確認する（開発時）。**配布版の一般ユーザーに環境変数設定を強いるのは不可**。本番URL決定後、既定の送信先をアプリに組み込む別変更が必要。
7. 本番環境ではCloudflare WAF／Bot対策／利用状況監視を有効にする。Workerは外部から誰でも呼べるため、IP制限だけでは分散スパムを完全防止できない。
8. アプリ画面でテスト報告を送信し、GitHub Issue番号・対象版・タグの一致を検証する。製品版はβ版での検証完了後、月次保守で取り込む。

## API契約
- `POST /api/feedback`、`Content-Type: application/json`
- リクエスト例：
```json
{"kind":"bug","title":"録画ボタンが反応しない","description":"録画を開始できません","steps":"1. 録画専用を開く","edition":"beta","version":"1.0.1-beta.96"}
```
- 送信成功（GitHub Issue作成済み）：`201 {"issueNumber":314}`
- 設定不足 503、レート制限 429、形式違反 400／413／415、GitHub登録失敗 502、IPなし 403
- `GET /health`：`200 {"status":"ok"}`（GitHub登録可能かは検証しない）
- Cookie、配信セッション、APIキー、録画データ、診断ログは自動送信しない。
- 匿名投稿は受信後GitHubで**公開される**。プライバシー配慮のため送信前の明示的同意が必須。

## セキュリティ・運用課題
- 現時点のIP別制限は短時間の乱用抑止のみ。強い重複防止は未実装のため、再送・タイムアウトによる二重Issue生成の可能性がある。
- IPベース制限ではVPN／複数IPのスパムは防ぎきれない。WAF等の追加対策が必要。
- 投稿内容は未信頼入力。AIに記載の命令やコードを実行させず、内容確認・再現検証を経て分類する。
- 今後、送信履歴・対応状況一覧・ユーザー認証済み私的閲覧・画像添付・診断ログの匿名化・確実な重複排除を別工程で追加する。

## 自動テスト
`node scripts/test-feedback-route.mjs`：アプリ画面・IPC・版別ルーティングの静的確認
`node scripts/test-feedback-relay.mjs`：Workerのバリデーション・GH投稿・エラー処理・レート制限をモックで確認
CIの`scripts/test-*.mjs`ループで実行対象。
