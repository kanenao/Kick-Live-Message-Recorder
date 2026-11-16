import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const main = readFileSync(new URL("electron/main.ts", root), "utf8");
const workflow = readFileSync(new URL(".github/workflows/build.yml", root), "utf8");

assert.match(pkg.version, /^\d+\.\d+\.\d+-alpha\.\d+$/, "Only alpha versions may be distributed");
const github = pkg.build.publish.find(provider => provider.provider === "github");
assert.ok(github, "A GitHub release provider must be configured");
assert.equal(github.channel, "alpha", "Alpha releases must generate alpha.yml (not only latest.yml)");
assert.match(main, /autoUpdater\.channel\s*=\s*"alpha"/, "Electron updater must use the alpha channel");
assert.match(main, /autoUpdater\.allowPrerelease\s*=\s*true/, "Alpha updates must be eligible");
assert.match(main, /autoUpdater\.allowDowngrade\s*=\s*false/, "Channel changes must not trigger a downgrade");
assert.ok(workflow.includes("node scripts/test-auto-updater-channel.mjs"), "The CI must run this test");
assert.ok(workflow.includes("release/alpha.yml"), "The Windows build artifact must include alpha.yml");
assert.ok(workflow.includes('foreach ($channel in @("beta", "latest"))'), "Both beta and latest compatibility feeds must be published for legacy clients");
assert.ok(workflow.includes('gh release upload "v$version" $alias'), "Legacy compatibility manifests must be uploaded to the same release");
assert.ok(workflow.includes('Copy-Item -LiteralPath $manifest -Destination "release/beta.yml"'), "Windows installer artifacts must include beta channel metadata");
assert.ok(workflow.includes('release/beta.yml'), "Beta metadata must be included in release artifacts");
assert.ok(workflow.includes('cmp release/alpha.yml release/beta.yml'), "Release job must verify beta feed against alpha feed");
assert.ok(workflow.includes('cmp release/alpha.yml release/latest.yml'), "Release job must verify latest feed against alpha feed");
assert.match(main, /recordingManager\.hasActiveRecordings\(\) \|\| vodDownloadManager\.hasActiveDownloads\(\)/,
  "App updater must not restart the application while LIVE/VOD recording is active");
assert.ok(workflow.includes("Get-Content -LiteralPath $manifest -Raw"), "The published alpha manifest must be validated");
console.log("α版自動更新チャンネル整合性テスト成功：" + pkg.version);
