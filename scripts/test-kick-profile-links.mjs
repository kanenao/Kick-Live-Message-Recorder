import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kickProfileUrl } from "../electron/kick-profile-link.ts";

assert.equal(kickProfileUrl("daibututv2"), "https://kick.com/daibututv2");
assert.equal(kickProfileUrl("DaibututV2"), "https://kick.com/daibututv2");
assert.equal(kickProfileUrl("user_name-1"), "https://kick.com/user_name-1");
for (const invalid of [
  "", " ", "/profile", "https://evil.example", "a/b", "../admin", 
  "abc?redirect=https://evil.example", "abc#fragment", "abc\\host",
  "名前", "name with spaces", "x".repeat(41), null, 123
]) {
  assert.throws(() => kickProfileUrl(invalid), /チャンネル名/);
}

const app = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
assert.match(app, /<LibraryChannelAvatar displayName=\{group\.displayName\} picture=\{group\.profilePicture\}/);
assert.match(app, /onOpenProfile=\{\(\) => void openKickProfile\(group\.slug\)\}/,
  "Avatar should open the matching Kick profile");
assert.match(app, /className="recording-channel-profile-link"/,
  "Broadcaster name should also be clickable");
assert.match(app, /onClick=\{\(\) => void openKickProfile\(group\.slug\)\}/,
  "Clickable display name should pass the slug, not untrusted display name");
assert.match(app, /aria-label=\{displayName \+ "のKickユーザーページを開く"\}/,
  "Profile avatar button must have an accessible action label");
assert.match(preload, /ipcRenderer\.invoke\("kick:open-profile", channelSlug\)/);
assert.match(main, /const url = kickProfileUrl\(channelSlug\)/);
assert.match(main, /await shell\.openExternal\(url\)/);
assert.match(css, /\.recording-channel-avatar:focus-visible/,
  "Keyboard users should be able to find the avatar action");

console.log("Kickアイコン・配信者名から公式ユーザーページを開く動作とURL検証テスト成功");
