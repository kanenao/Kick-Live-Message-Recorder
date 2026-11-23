import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betaHistoryPath, readBetaHistory, registerBetaHistory } from "../electron/beta-history.ts";

const root = mkdtempSync(join(tmpdir(), "kick-beta-eligibility-"));
try {
  const location = betaHistoryPath(root);
  assert.equal(readBetaHistory(root).eligible, false, "new stable user has no beta history");
  assert.equal(registerBetaHistory(root, "1.0.0", {packaged:true, platform:"win32"}), false);
  assert.equal(registerBetaHistory(root, "0.9.0-beta.93", {packaged:false, platform:"win32"}), false);
  assert.equal(registerBetaHistory(root, "0.9.0-beta.93", {packaged:true, platform:"linux"}), false);
  assert.equal(readBetaHistory(root).eligible, false);
  assert.equal(registerBetaHistory(root, "0.9.0-beta.93", {packaged:true, platform:"win32"}), true);
  const data = readBetaHistory(root);
  assert.equal(data.eligible, true);
  assert.equal(data.version, "0.9.0-beta.93");
  assert.equal(registerBetaHistory(root, "0.9.0-beta.94", {packaged:true, platform:"win32"}), true);
  assert.equal(readBetaHistory(root).version, "0.9.0-beta.93", "preserve original beta activation");
  const raw = JSON.parse(readFileSync(location, "utf8"));
  assert.equal(raw.edition, "beta");
  assert.equal(raw.schema, 1);
  assert.ok(!JSON.stringify(raw).includes("password"));
  writeFileSync(location, JSON.stringify({ ...raw, edition:"stable" }));
  assert.equal(readBetaHistory(root).eligible, false);
  writeFileSync(location, JSON.stringify({ ...raw, version:"1.0.0" }));
  assert.equal(readBetaHistory(root).eligible, false);
  writeFileSync(location, "invalid-json");
  assert.equal(readBetaHistory(root).eligible, false);
  writeFileSync(location, "X".repeat(2500));
  assert.equal(readBetaHistory(root).eligible, false);
} finally {
  rmSync(root, {recursive:true, force:true});
}

const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version.includes("-beta.")) {
  assert.match(main, /registerBetaHistory\(app\.getPath\("appData"\)/);
  assert.match(main, /autoUpdater\.autoDownload\s*=\s*false/);
  assert.match(main, /autoUpdater\.setFeedURL\(\{ provider: "generic"/);
  assert.match(main, /result\?\.updateInfo\?\.version !== release\.version/);
  assert.match(main, /await autoUpdater\.downloadUpdate\(\)/);
  assert.match(main, /verifiedBetaUpdate/);
  assert.match(main, /return checkBetaOnlyUpdates\(\)/);
  assert.match(ui, /製品版の取得は/);
} else {
  assert.doesNotMatch(main, /registerBetaHistory\(/);
  assert.match(main, /ipcMain\.handle\("editions:beta-return-status"/);
  assert.match(main, /ipcMain\.handle\("editions:beta-return-open"/);
  assert.match(main, /readBetaHistory\(app\.getPath\("appData"\)\)/);
  assert.match(main, /if \(!history\.eligible\)/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /if \(confirm\.response !== 0\) return \{ opened: false as const \}/);
  assert.match(ui, /betaReturnStatus\.eligible/);
  assert.match(ui, /β版の取得を許可する/);
}
console.log("β版利用履歴とβ版専用更新・明示同意の回帰テスト成功");
