import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEditionReleases } from "../electron/edition-releases.ts";

const root = "https://github.com/kanenao/Kick-Live-Message-Recorder/releases";
function release(version, prerelease, options = {}) {
  const tag = "v" + version;
  const installer = "Kick-Live-Message-Recorder-Setup-" + version + ".exe";
  const channel = prerelease ? "beta" : "latest";
  return {
    tag_name: tag, draft: false, prerelease, published_at: "2026-11-23T00:00:00Z",
    name: "Kick " + version, body: "Release notes",
    assets: [
      { name: installer, size: 230000000, browser_download_url: root + "/download/" + tag + "/" + installer },
      { name: channel + ".yml", size: 500 }
    ], ...options
  };
}
const beta = release("0.8.1-beta.89", true);
const stable = release("1.0.0", false);
const output = parseEditionReleases([
  release("1.0.0", false, { draft: true }),
  release("1.0.0", true), // Stable tag is not a product prerelease
  release("0.8.1-beta.90", true, { assets: [] }), // No installer
  release("0.8.1-alpha.87", true), // Legacy alpha
  release("1.1.0", false, { assets: [{ name:"latest.yml" }] }), // Missing exe
  release("1.2.0", false, { assets: [
    {name:"Kick-Live-Message-Recorder-Setup-1.2.0.exe", size:230000000,
      browser_download_url:"https://untrusted.example/installer.exe"},
    {name:"latest.yml", size:500}
  ]}),
  stable, beta
]);
assert.deepEqual(output.beta.map(r => r.version), ["0.8.1-beta.89"]);
assert.deepEqual(output.stable.map(r => r.version), ["1.0.0"]);
assert.equal(output.beta[0].installerUrl, root + "/download/v0.8.1-beta.89/Kick-Live-Message-Recorder-Setup-0.8.1-beta.89.exe");
assert.equal(output.stable[0].url, root + "/tag/v1.0.0");
assert.deepEqual(parseEditionReleases([beta]), { beta: output.beta, stable: [] });
assert.throws(() => parseEditionReleases({ error: "rate limit" }), /不正/);

const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
assert.match(main, /ipcMain.handle\("editions:list"/);
assert.match(main, /ipcMain.handle\("editions:switch"/);
assert.match(main, /recordingManager\.hasActiveRecordings\(\) \|\| vodDownloadManager\.hasActiveDownloads\(\)/);
assert.match(main, /commentVideoGenerator\.isRunning\(\)/);
assert.match(main, /dialog\.showMessageBox/);
assert.match(main, /await shell\.openExternal\(release\.installerUrl\)/);
assert.match(preload, /ipcRenderer\.invoke\("editions:list"\)/);
assert.match(preload, /ipcRenderer\.invoke\("editions:switch", target\)/);
assert.match(ui, /className="version-history-section edition-switch-panel"/);
assert.match(ui, /editionReleases\.stable\.map/);
assert.match(main, /if \\(!app\\.getVersion\\(\\)\\.includes\\("-beta\\."\\)\\)/);
assert.match(ui, /openEditionSwitcher\\(target\\)/);
assert.match(ui, /\\(\\["beta", "stable"\\] as const\\)\\.map\\(target/);
assert.match(ui, /β版専用/);
console.log("公開済み製品版履歴・悪意あるURL拒否・β版専用の両版選択UIの回帰テスト成功");
