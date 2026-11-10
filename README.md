# Kick Live Message Recorder

Kick のライブ配信を録画し、チャットを保存する Windows デスクトップアプリです。

<aside>
<strong>開発版：0.1.0-beta.1</strong><br />
この段階はβ版の初期土台です。Kick配信の検知・録画・チャット取得はまだ利用できません。
</aside>

## β版で利用できる機能

- 日本語ダッシュボード
- Kickチャンネルの追加・削除
- チャンネルごとの自動/手動モード設定
- Electronデスクトップアプリの起動基盤
- チャンネル一覧と基本設定のPC内保存
- 録画データ保存先フォルダーの選択
- GitHub Actionsによる型チェック・Windowsインストーラー作成

## これから実装する機能

- Kick公式APIによる配信状態の検知
- 自動録画の開始・終了、手動録画の開始・停止
- 映像・音声の保存
- チャットの取得・時刻付き保存
- 録画ライブラリ、再生、検索、CSV/JSON出力

## 動作確認・開発

Node.js 22 以上を用意し、次を実行します。

```bash
npm install
npm run dev
```

Windows向けインストーラーをローカルで作成する場合：

```bash
npm run dist:win
```

GitHub Actionsでは、型チェック・ビルド後にWindows向けNSISインストーラーを作成し、ActionsのArtifactsに14日間保存します。

## データ保存

- チャンネル一覧と設定はElectronのユーザーデータ領域にJSON形式で保存します。
- 録画ファイルの保存先は設定画面から選択できます（録画機能は未実装）。
- ブラウザープレビューでは、設定をブラウザーのlocalStorageに保存します。

## 技術構成

- Electron 45
- React 19 + TypeScript + Vite
- Windows NSIS installer
- 今後：SQLite、FFmpeg、Kick公式API/イベント

## 注意事項

録画・チャット保存はKickの利用規約、配信者の権利、プライバシー、適用法令を守って利用してください。チャットの保存期間や削除要求への対応を含め、公式に利用可能な方法を優先します。未公開の内部APIに依存する機能は、安定機能として提供しません。
