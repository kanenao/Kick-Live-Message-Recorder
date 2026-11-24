import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = p => readFileSync(new URL(p, root), "utf8");
const pkg = JSON.parse(source("package.json"));
const beta = pkg.version.includes("-beta.");
const main = source("electron/main.ts");
const preload = source("electron/preload.ts");
const types = source("src/types/electron.d.ts");
const ui = source("src/ui/App.tsx");
const relay = source("feedback-relay/src/index.mjs");

for (const marker of ["feedback:open", "feedback:availability", "feedback:submit"]) {
  assert.ok(main.includes('ipcMain.handle("' + marker + '"'), "Missing trusted IPC: " + marker);
  assert.ok(preload.includes('ipcRenderer.invoke("' + marker + '"'), "Missing preload IPC: " + marker);
}
assert.match(main, /assertTrustedSender\(event\)/);
assert.match(main, /app\.getVersion\(\)\.includes\("-beta\."\)/);
assert.match(main, /KICK_FEEDBACK_ENDPOINT/);
assert.match(main, /new AbortController\(\)/);
assert.match(main, /if \(!feedbackConfigured\)/);
for (const template of ["01-beta-bug.yml", "02-stable-bug.yml", "03-beta-feature.yml", "04-stable-feature.yml"]) {
  assert.ok(main.includes(template), "Existing GitHub fallback must remain: " + template);
}
assert.match(preload, /getFeedbackAvailability:/);
assert.match(preload, /submitFeedback:/);
assert.match(types, /getFeedbackAvailability:/);
assert.match(types, /submitFeedback:/);
assert.match(ui, /tab === "feedback" && <section className="panel feedback-panel"/);
assert.match(ui, /onClick=\{\(\)=>void submitFeedback\(\)\}/);
assert.match(ui, /onClick=\{\(\)=>void openFeedback\(feedbackKind\)\}/);
assert.match(ui, /localStorage\.setItem\("kick-feedback-draft"/);
assert.match(ui, /!feedbackConfigured \|\| !feedbackConsent/);
assert.match(relay, /GITHUB_TOKEN/);
assert.match(relay, /FEEDBACK_RATE_LIMITER/);
assert.match(relay, /AI判定待ち/);
assert.ok(!main.includes("issues:create"), "Never directly embed GitHub issue API in Electron");
assert.equal(pkg.build.publish[0].channel, beta ? "beta" : "latest");
console.log("アプリ内報告フォーム・安全な中継送信・代替導線の回帰テスト成功：", pkg.version);

assert.match(ui,/kick-feedback-history/);
assert.match(ui,/feedbackBusyRef/);
assert.match(main,/requestId/);
assert.match(relay,/FEEDBACK_RECEIPTS/);
assert.match(relay,/storage\.transaction/);
