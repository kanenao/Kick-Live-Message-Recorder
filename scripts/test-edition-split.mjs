import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/channel-release.yml", import.meta.url), "utf8");
const provider = pkg.build.publish.find(value => value.provider === "github");
const beta = /^\d+\.\d+\.\d+-beta\.\d+$/.test(pkg.version);
const stable = /^\d+\.\d+\.\d+$/.test(pkg.version);
assert.ok(beta || stable, "β版か製品版以外はこの公開経路に入れない");
assert.equal(provider.channel, beta ? "beta" : "latest");
assert.equal(provider.releaseType, beta ? "prerelease" : "release");
assert.ok(ui.includes('const APP_VERSION = "' + pkg.version + '";'), "画面とpackage.jsonのバージョンは必ず一致");
assert.match(main, new RegExp('autoUpdater\\.channel\\s*=\\s*"' + (beta ? "beta" : "latest") + '"'));
assert.match(main, new RegExp('autoUpdater\\.allowPrerelease\\s*=\\s*' + (beta ? "true" : "false")));
assert.match(main, /autoUpdater\.allowDowngrade\s*=\s*false/, "バージョンの逆行は禁止");
assert.ok(workflow.includes("node scripts/validate-channel-release.mjs release"));
assert.ok(workflow.includes("test \"$GITHUB_REF_NAME\" = \"release/v$version\""));
if (stable) {
  assert.notEqual(pkg.build.appId, "jp.kanenao.kickrecorder", "製品版はβ版と別のアプリIDを持つ");
  assert.ok(ui.includes('const ARTICLES_ENABLED = APP_VERSION.includes("-beta.");'), "製品版には配信記事メニューを出さない");
  assert.ok(ui.includes('ARTICLES_ENABLED && tab === "articles"'), "製品版の記事表示を禁止");
  assert.ok(ui.includes('ARTICLES_ENABLED && <button className={tab === "articles"'), "製品版の記事メニューを非表示");
  assert.ok(main.includes('const ARTICLE_FEATURE_ENABLED = app.getVersion().includes("-beta.");'), "製品版の記事エンジンは無効");
  assert.ok(main.includes('enabled: ARTICLE_FEATURE_ENABLED && settings.aiArticleEnabled'));
  assert.ok(main.includes('if (ARTICLE_FEATURE_ENABLED) {\n  ipcMain.handle("articles:live:start"'), "製品版で記事生成IPCは登録しない");
  assert.ok(main.includes('if (ARTICLE_FEATURE_ENABLED) {\n  ipcMain.handle("ai-article:get-status"'), "製品版でAIモデル取得IPCは登録しない");
}
console.log((beta ? "β版" : "製品版") + "の分離・自動更新ポリシーテスト成功：" + pkg.version);
