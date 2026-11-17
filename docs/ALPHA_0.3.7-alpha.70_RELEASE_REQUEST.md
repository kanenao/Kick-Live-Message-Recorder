# Kick Live Message Recorder 0.3.7-alpha.70 公開指示

要望：録画ライブラリのコメントログも個別に削除できるように改善する。

実装：配信別ファイル欄のコメントJSONLへ削除ボタンを追加。削除確認後、対象JSONLのみWindowsのごみ箱へ移動。録画動画・AI記事・TXT/ASSファイルは保持。書き込み中のLIVEコメントとVODコメント取得中の削除は禁止。

公開条件：GitHub Actionsの型チェック、コメント削除・保存先保護テスト、アプリビルド、Windowsインストーラー生成、配布ファイルと更新情報（alpha.yml、beta.yml、latest.yml）の名前・サイズ・ハッシュ整合性が全て成功した場合のみ、Pre-release v0.3.7-alpha.70 として公開する。
