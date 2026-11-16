import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { KickVodDownloadManager, parseKickVodUrl, parseVodProgress } from "../electron/vod-download-queue.ts";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555"
];
const url = (videoId, slug = "sample_channel") => `https://kick.com/${slug}/videos/${videoId}`;

assert.deepEqual(parseKickVodUrl(url(ids[0]) + "?foo=bar"), {
  slug: "sample_channel", videoId: ids[0], url: url(ids[0])
});
for (const invalid of [
  "http://kick.com/sample/videos/" + ids[0],
  "https://kick.com.evil.example/sample/videos/" + ids[0],
  "https://evil.example/sample/videos/" + ids[0],
  "https://user:pass@kick.com/sample/videos/" + ids[0],
  "https://kick.com:444/sample/videos/" + ids[0],
  "https://kick.com/sample/videos/not-a-valid-uuid",
  "https://kick.com/sample"
]) {
  assert.throws(() => parseKickVodUrl(invalid), undefined, invalid);
}
assert.deepEqual(parseVodProgress("[download]  23.4% of 1.00GiB at 9MiB/s ETA 00:21"), {
  progress: 23.4, estimatedRemainingSeconds: 21
});
assert.deepEqual(parseVodProgress("[download] 100% of 1.0GiB ETA 01:02:03"), {
  progress: 100, estimatedRemainingSeconds: 3723
});
assert.equal(parseVodProgress("[info] Downloading page"), null);

const children = [];
const emitted = [];
function fakeSpawn(command, args) {
  assert.ok(command.includes("yt-dlp"), command);
  assert.ok(args.includes("--no-playlist"));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { process.nextTick(() => child.emit("close", null)); return true; };
  child.outputTemplate = args[args.indexOf("--output") + 1];
  children.push(child);
  return child;
}
const directory = mkdtempSync(join(tmpdir(), "kick-vod-batch-"));
try {
  const manager = new KickVodDownloadManager(event => emitted.push(event), fakeSpawn);
  const created = manager.enqueue(ids.slice(0, 4).map(x => url(x)), directory);
  assert.equal(created.length, 4);
  assert.equal(children.length, 3, "同時実行は最大3件");
  assert.deepEqual(manager.list().map(job => job.status), ["queued", "downloading", "downloading", "downloading"]);

  children[0].stdout.write("[download]  45.5% of 600MiB ETA 00:07\n");
  assert.equal(manager.list().find(job => job.id === created[0].id).progress, 45.5);
  assert.equal(manager.list().find(job => job.id === created[0].id).estimatedRemainingSeconds, 7);

  assert.throws(() => manager.enqueue([url(ids[1])], directory), /ダウンロード待ち、または実行中/);
  manager.cancel(created[3].id);
  assert.equal(manager.list().find(job => job.id === created[3].id).status, "cancelled", "待機中の番組を個別にキャンセル");

  const more = manager.enqueue([url(ids[4])], directory);
  assert.equal(more.length, 1);
  const outputTemplate = children[0].outputTemplate;
  writeFileSync(outputTemplate.replace("%(title).90B", "sample").replace("%(ext)s", "mp4"), "recorded bytes");
  children[0].emit("close", 0);
  assert.equal(manager.list().find(job => job.id === created[0].id).status, "completed");
  assert.equal(children.length, 4, "完了すると次の番組を自動開始");
  assert.ok(manager.list().find(job => job.id === created[0].id).durationMs >= 0);

  manager.cancel(created[1].id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.list().find(job => job.id === created[1].id).status, "cancelled", "進行中の番組を個別停止");
  assert.ok(emitted.some(event => event.status === "completed"));
  manager.stopAll();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("Kick VODの複数キュー・進捗・経過時間・個別停止テスト成功");
