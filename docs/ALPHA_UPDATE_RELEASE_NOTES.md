# Kick Live Message Recorder 0.3.8-alpha.71

Windows 64bit向けのα版（Pre-release）です。

## ASS字幕のemote削除機能

- 「コメント付き動画を生成」と「過去配信コメント取得」に「ASS出力時にemoteを削除する」を追加しました（初期設定ON）。
- ONの場合はKickのemote（例：`[emote:123:Nice]`）部分のみ取り除き、通常の文章をASS字幕に残します。
- emoteのみのコメントは字幕にしません。OFFの場合は従来どおりemote名を文字として出力します。
- コメント付き動画のプレビューにもON/OFFを反映し、選択状態はアプリ設定に保存します。

## データ保護と更新

- 保存済みの元コメントJSONL・TXT、録画動画、AI記事は変更しません。
- Windowsインストーラーは公開前に型チェック・ASS変換テスト・ビルド・更新マニフェスト（alpha.yml／beta.yml／latest.yml）整合性を検証します。
- アプリの自動更新が使えない古いβ版・α版では、最新インストーラーを一度手動導入してください。
