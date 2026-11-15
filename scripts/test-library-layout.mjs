import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");

assert.match(app, /<main className=\{tab === "library" \? "main main-library" : "main"\}>/, "The library should use a wide page layout.");
assert.match(css, /\.main\.main-library\{[^}]*max-width:none;[^}]*min-width:0;/, "The library must be able to grow horizontally.");

const channelListRule = css.match(/\.recording-channel-list\{([^}]*)\}/)?.[1];
assert.ok(channelListRule, "Channel list CSS must exist.");
assert.doesNotMatch(channelListRule, /max-height|overflow:auto|overflow:hidden/, "The entire channel list must not trap scrolling.");

assert.match(app, /className="recording-library-video-list" role="region" aria-label=\{group\.displayName \+ "の録画一覧"\} tabIndex=\{0\}/, "The video list should have a keyboard-accessible scroll region.");
assert.match(css, /\.recording-library-video-list\{[^}]*max-height:clamp\([^)]*\);[^}]*overflow-y:auto;/, "The video list should scroll vertically with a viewport-relative height.");
assert.match(css, /\.recording-library-video-list:focus-visible\{[^}]*outline:/, "Keyboard focus should be visible.");
assert.match(app, /className="recording-library-video-actions"/, "Recording actions should have a flexible group.");
assert.match(css, /@media\(max-width:1100px\)\{[\s\S]*?\.recording-library-video-actions\{grid-column:2;/, "Video actions should move below the filename in narrower windows.");
assert.doesNotMatch(css, /\.recording-library-video-row button\{margin-left:44px\}/, "Old button indentation must be removed.");
for (const action of ["再生", "場所を表示", "削除"]) {
  assert.ok(app.includes(action), "Missing recording operation: " + action);
}
assert.ok(workflow.includes("node scripts/test-library-layout.mjs"), "The library layout test should run in CI.");

console.log("録画ライブラリの幅・スクロール・操作ボタン・レスポンシブ表示テスト成功");
