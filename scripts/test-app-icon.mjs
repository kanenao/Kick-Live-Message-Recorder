import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = spawnSync(process.execPath, [join(root, "scripts/generate-app-icon.mjs")], {
  encoding: "utf8", cwd: root
});
assert.equal(build.status, 0, build.stderr || build.stdout);

const read = name => readFileSync(join(root, name));
const png = read("build/icon.png");
const icon = read("build/icon.ico");
const uiPng = read("public/app-icon.png");
assert.equal(png.readUInt32BE(16), 256);
assert.equal(png.readUInt32BE(20), 256);
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(createHash("sha256").update(png).digest("hex"),
  "c9002832acfc74bc0a4ed8985cfd6abe11344dba1567d24ff93059905cf0d946");
assert.deepEqual(uiPng, png, "サイドバーとWindowsアイコンは同じ画像を使う");
assert.equal(icon.readUInt16LE(0), 0);
assert.equal(icon.readUInt16LE(2), 1, "Windows ICO signature");
assert.equal(icon.readUInt16LE(4), 1, "Exactly one lossless PNG image in ICO");
assert.equal(icon[6], 0, "Width zero in ICO means 256");
assert.equal(icon[7], 0, "Height zero in ICO means 256");
assert.equal(icon.readUInt32LE(14), png.length);
assert.equal(icon.readUInt32LE(18), 22);
assert.deepEqual(icon.subarray(22), png, "ICO embeds the same generated image");
assert.ok(statSync(join(root, "build/icon.ico")).size > 5000);

const packageJson = JSON.parse(read("package.json").toString("utf8"));
assert.equal(packageJson.build.win.icon, "build/icon.ico");
assert.match(packageJson.scripts.build, /build:icons/, "アイコンを作ってから本体をビルドする");
assert.match(packageJson.scripts.predev, /build:icons/, "開発時もアイコンを生成する");
assert.ok(packageJson.build.extraResources.some(
  asset => asset.from === "build/icon.png" && asset.to === "branding/icon.png"
), "トレイ・ウィンドウ用画像をアプリ内に同梱する");

const app = read("src/ui/App.tsx").toString("utf8");
const main = read("electron/main.ts").toString("utf8");
const index = read("index.html").toString("utf8");
assert.match(app, /brand-mark brand-icon" src="\.\/app-icon\.png"/,
  "アプリ左上に正式アイコンを表示する");
assert.match(app, /avatar avatar-brand" src="\.\/app-icon\.png"/,
  "ヘッダーにも正式アイコンを表示する");
assert.match(main, /function loadAppBrandIcon\(/,
  "Electronで正式画像を読み込む");
assert.match(main, /icon: loadAppBrandIcon\(\)/,
  "ウィンドウに正式アイコンを設定する");
assert.match(main, /tray = new Tray\(trayIcon\)/,
  "通知領域にも新アイコンを設定する");
assert.match(index, /rel="icon" type="image\/png" href="\.\/app-icon\.png"/);

console.log("Kick正式アプリアイコン：PNG/ICO/ハッシュ・ショートカット・トレイ・画面統合テスト成功");
