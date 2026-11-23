import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = path => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(source("package.json"));
const beta = pkg.version.includes("-beta.");
const main = source("electron/main.ts");
const preload = source("electron/preload.ts");
const types = source("src/types/electron.d.ts");
const ui = source("src/ui/App.tsx");

assert.match(main, /ipcMain\.handle\("feedback:open", async \(event, kind: unknown\)/);
assert.match(main, /assertTrustedSender\(event\)/);
assert.match(main, /kind !== "bug" && kind !== "feature"/);
assert.match(main, /app\.getVersion\(\)\.includes\("-beta\."\)/);
for (const path of ["01-beta-bug.yml", "02-stable-bug.yml", "03-beta-feature.yml", "04-stable-feature.yml"]) {
  assert.ok(main.includes(path), "official report template URL must be present: " + path);
}
assert.match(main, /shell\.openExternal\(link\)/);
assert.match(preload, /openFeedbackForm: \(kind: "bug" \| "feature"\)/);
assert.match(preload, /ipcRenderer\.invoke\("feedback:open", kind\)/);
assert.match(types, /openFeedbackForm: \(kind: "bug" \| "feature"\)/);
assert.match(ui, /"feedback" \| "settings"/);
assert.match(ui, /setTab\("feedback"\)/);
assert.match(ui, /tab === "feedback" && <section className="panel feedback-panel"/);
assert.match(ui, /onClick=\{\(\) => void openFeedback\("bug"\)\}/);
assert.match(ui, /onClick=\{\(\) => void openFeedback\("feature"\)\}/);
assert.match(ui, /パスワード、APIキー、認証Cookie/);
assert.ok(!main.includes("issues:create"), "do not silently post reports or credentials to GitHub");
assert.equal(pkg.build.publish[0].channel, beta ? "beta" : "latest", "don't cross release channels");
console.log("フィードバックの4種類・版別ルーティング・本人送信・IPCの回帰テスト成功：", pkg.version);
