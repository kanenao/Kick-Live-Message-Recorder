# 0.3.3-alpha.66 の自動更新404修復

既存アプリが誤って `Kick-Live-Message-Recorder-Setup-0.3.3-alpha.66.exe` を取得しようとして404になる。
公開済みの正しいファイルは `Kick.Live.Message.Recorder.Setup.0.3.3-alpha.66.exe`。

既存インストーラーのSHA512とサイズを検証したうえで、GitHub Release内の `alpha.yml`、`beta.yml`、`latest.yml` を修正する。旧マニフェストをキャッシュしているアプリ向けに同じバイナリを旧名でも配布する。録画データには触れない。
