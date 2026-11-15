import assert from "node:assert/strict";
import { join } from "node:path";
import { buildRecordingSessions, classifyRecordingFile } from "../electron/library-sessions.ts";

const root = process.platform === "win32" ? "C:\\Recordings" : "/recordings";
const uuid = "11111111-2222-4333-8444-555555555555";
const live = "sample_20261115_141000.mp4";
const retry = "sample_20261115_141000_retry02.ts";
const vod = `sample_VOD_${uuid}_an_old_stream.mkv`;
const oldVod = "sample_VOD_20261114_101000.mp4";
const file = (name, size = 1000) => ({
  path: join(root, name), name, extension: name.split(".").pop().toUpperCase(),
  size, modifiedAt: "2026-11-15T05:45:00.000Z"
});
const log = (slug, name, kind) => ({
  path: join(root, "Chat", slug, name), name, channelSlug: slug, kind,
  size: 2048, modifiedAt: "2026-11-15T05:35:00.000Z"
});
assert.equal(classifyRecordingFile(vod, "2026-11-15T01:00:00Z").id, "sample_VOD_" + uuid);
assert.equal(classifyRecordingFile(retry, "2026-11-15T01:00:00Z").id, "sample_20261115_141000");
assert.equal(classifyRecordingFile("unsafe.html", "2026-11-15T01:00:00Z"), null);
const article = {
  id: "sample_20261115_141000", slug: "sample", displayName: "配信者",
  headline: "ライブのまとめ", category: "", startedAt: "2026-11-15T05:10:00.000Z",
  durationSeconds: 2100, commentCount: 5, uniqueCommenters: 4, keywords: [],
  paragraphs: ["配信の内容"], sourceVideo: join(root, live),
  sourceLogs: [join(root, "Chat", "sample", "2026-11-15.jsonl")],
  createdAt: "2026-11-15T06:00:00.000Z"
};
const sessions = buildRecordingSessions(
  [file(live), file(retry), file(vod), file(oldVod)],
  [log("sample", `VOD_${uuid}_20261115_120000.jsonl`, "VOD"), log("sample", "2026-11-15.jsonl", "LIVE")],
  [article],
  [{ schemaVersion: 1, id:"sample_20261115_141000", slug:"sample", kind:"LIVE",
    status:"stopped", startedAt:"2026-11-15T05:10:00.000Z", finishedAt:"2026-11-15T05:45:00.000Z" }]
);
const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
assert.equal(byId["sample_20261115_141000"].videos.length, 2, "再接続時の分割ファイルは同一配信として扱う");
assert.equal(byId["sample_20261115_141000"].status, "interrupted", "途中停止を完了と誤表示しない");
assert.equal(byId["sample_20261115_141000"].article.headline, "ライブのまとめ");
assert.equal(byId["sample_20261115_141000"].commentAssociation, "exact");
assert.equal(byId["sample_VOD_" + uuid].logs.length, 1, "VOD IDで正確にコメントを関連付け");
assert.equal(byId["sample_VOD_20261114_101000"].logs.length, 0, "別VODのコメントを誤結合しない");
assert.equal(byId["sample_chat_2026-11-15"].videos.length, 0, "日別LIVEログを別の番組に誤結合しない");
assert.ok(byId["sample_chat_2026-11-15"].warnings.length > 0);
const failures = buildRecordingSessions([], [], [], [{
  schemaVersion: 1, id: "sample_20261115_152000", slug: "sample",
  kind: "LIVE", startedAt: "2026-11-15T06:20:00.000Z", status: "completed"
}]);
assert.equal(failures[0].status, "failed", "保存ファイルがない完了記録は異常として扱う");
console.log("録画セッションのLIVE再接続・VODコメント・AI記事・途中停止・未保存の分類テスト成功");
