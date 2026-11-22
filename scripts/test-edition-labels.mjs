import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ui = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const edition = pkg.version.includes("-beta.") ? "β版" : "製品版";
assert.ok(ui.includes('const APP_VERSION = "' + pkg.version + '";'), "アプリUIと配布版数が一致する");
assert.ok(ui.includes("Windows 64bit・" + edition), "更新画面のエディション表示が一致する");
assert.ok(ui.includes(edition + "の録画動作・保存先の設定"), "基本設定もエディションを表示する");
assert.ok(!ui.includes("新しいα版の確認・ダウンロード・更新履歴"), "旧α版の案内を現役版として表示しない");
assert.ok(!ui.includes("起動時と約6時間ごとに最新α版を自動確認"), "旧α版を自動更新先と表示しない");
assert.ok(!main.includes("旧β版からの移行時はGitHub Releasesにある最新α版"), "旧α版への誘導は禁止");
assert.ok(ui.includes("現在のバージョン"), "バージョン表示を維持");
console.log(edition + "の更新画面表記・旧α表記の混入防止テスト成功：" + pkg.version);
