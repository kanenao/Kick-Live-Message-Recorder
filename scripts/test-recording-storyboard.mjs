import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { planStoryboardTimes, recordingVideoStoryboard } from "../electron/recording-storyboard.ts";

assert.deepEqual(planStoryboardTimes(0), []);
assert.deepEqual(planStoryboardTimes(Number.NaN), []);
assert.deepEqual(planStoryboardTimes(-10), []);
assert.deepEqual(planStoryboardTimes(20 * 24 * 3600), []);
const short = planStoryboardTimes(80);
assert.equal(short.length, 6, "短い録画にも時刻別プレビューを生成する");
assert.ok(short.every((value, index) => value >= 0 && value < 80 && (!index || value > short[index - 1])));
const long = planStoryboardTimes(3 * 3600 + 1800);
assert.equal(long.length, 30, "長時間録画の表示件数は30件まで");
assert.ok(long.some(time => time > 3600 && time < 7200), "中盤の場面も表示");
assert.ok(long.some(time => time > 10000), "配信の後半も表示");
assert.ok(long.at(-1) < 12600, "動画の終了時刻より前のみをサンプリング");

const root = mkdtempSync(join(tmpdir(), "kick-storyboard-test-"));
const outside = mkdtempSync(join(tmpdir(), "kick-storyboard-outside-"));
try {
  const file = join(root, "recorded.mp4");
  writeFileSync(file, Buffer.alloc(4096));
  const before = statSync(file).size;
  await assert.rejects(recordingVideoStoryboard(root, root, file, () => true),
    /録画中/, "録画中の動画にはFFmpegを実行しない");
  await assert.rejects(recordingVideoStoryboard(root, root, join(outside, "outside.mp4"), () => false),
    /ライブラリ外/, "録画ライブラリ外の動画は拒否する");
  await assert.rejects(recordingVideoStoryboard(root, root, join(root, "missing.mp4"), () => false),
    /見つからない/, "削除済み動画は安全に拒否");
  const link = join(root, "shortcut.mp4");
  try {
    symlinkSync(file, link, "file");
    await assert.rejects(recordingVideoStoryboard(root, root, link, () => false),
      /見つからない/, "シンボリックリンクで経路検証を回避できない");
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  assert.equal(statSync(file).size, before, "元動画は変更しない");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
const app = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
assert.match(main, /ipcMain\.handle\("recording:storyboard"/, "安全なIPC経路を追加");
assert.match(preload, /getRecordingStoryboard:/, "プリロードの許可APIに追加");
assert.match(app, /<RecordingStoryboardDialog/, "共通の場面一覧モーダルを表示");
assert.match(app, /onOpenStoryboard=\{\(path, title\)/, "配信記事から場面プレビューを開ける");
assert.match(app, /onPreview=\{\(\) =>/, "録画ライブラリの動画サムネから開ける");
assert.match(app, /className="storyboard-gallery"/, "時刻付きの場面グリッドを表示");
assert.match(css, /\.storyboard-layout\{display:grid/, "記事に合う2列レイアウト");
console.log("Kick録画・配信AI新聞：時刻別場面プレビューの計画・ファイル安全性・共通UIテスト成功");
