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

assert.match(app, /<LibraryChannelAvatar displayName=\{group\.displayName\} picture=\{group\.profilePicture\}/,
  "Library broadcaster cards must show the official Kick avatar when available.");
assert.match(app, /checkKickChannels\(batch\)/,
  "Profiles must also be fetched for archived broadcasters, not only monitored channels.");
assert.match(app, /listCommentFileMessages\(log\.channelSlug, log\.name, 100\)/,
  "Each saved comment file must support an independent preview.");
assert.match(css, /\.recording-channel-avatar\{[^}]*border-radius:50%/,
  "Broadcaster avatars should be round in the Nico-style cards.");

assert.match(app, /<option value="articles">AI記事付きの録画<\/option>/,
  "Users should be able to filter sessions that have attached AI articles.");
assert.match(app, /AI記事付きの配信/,
  "Library dashboard should count sessions with an attached article.");

assert.match(app, /className="recording-session-list" role="region" tabIndex=\{0\}/, "The session list should have a keyboard-accessible scroll region.");
assert.match(app, /window\.setInterval\(refreshIfVisible, 10_000\)/,
  "The library must refresh when files are deleted outside the app.");
assert.match(app, /window\.addEventListener\("focus", refreshIfVisible\)/,
  "Returning from Explorer should refresh the library.");
assert.match(app, /setRecordingSessions\(current => current\.map\(session => \(\{/,
  "Deleting a video inside the app must also update session cards.");
assert.match(app, /setLibraryRefreshKey\(value => value \+ 1\)/,
  "Deleting a file should re-scan on-disk metadata.");
assert.match(css, /\.recording-session-list\{[^}]*max-height:[^;]*;overflow:auto;/, "Session list should scroll within viewport.");
assert.match(css, /\.recording-session-card\{/, "Session cards should be styled.");
assert.match(app, /className="recording-library-video-actions"/, "Recording actions should have a flexible group.");
assert.match(css, /@media\(max-width:1100px\)\{[\s\S]*?\.recording-library-video-actions\{grid-column:2;/, "Video actions should move below the filename in narrower windows.");
assert.doesNotMatch(css, /\.recording-library-video-row button\{margin-left:44px\}/, "Old button indentation must be removed.");
for (const action of ["再生", "場所", "削除"]) {
  assert.ok(app.includes(action), "Missing recording operation: " + action);
}
assert.ok(workflow.includes("node scripts/test-library-layout.mjs"), "The library layout test should run in CI.");

console.log("録画ライブラリの幅・スクロール・操作ボタン・レスポンシブ表示テスト成功");
