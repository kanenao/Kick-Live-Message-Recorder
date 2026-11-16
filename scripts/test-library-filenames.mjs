import assert from "node:assert/strict";
import { getRecordingChannelSlug } from "../src/shared/recording-library.ts";
import { broadcastFileStem, broadcastFileDate, parseBroadcastFileStem, safeKickDisplayName } from "../electron/recording-filenames.ts";

const cases = [
  ["sample_20261114_123456.mp4", "sample"],
  ["sample_channel_20261114_123456.mkv", "sample_channel"],
  ["sample_channel_VOD_3c4c8e7d-1234-4abc-9def-0123456789ab_title.mp4", "sample_channel"],
  ["sample_VOD_20261114_123456.mp4", "sample"],
  ["sample_20261114_123456_retry02.ts", "sample"],
  ["sample_20261114_123456_comments.mp4", "sample"],
  ["sample_20261114_123456_comments_2.mp4", "sample"],
  ["sample_channel_20261114_123456_comments_10.mp4", "sample_channel"],
  ["SAMPLE_20261114_123456.MP4", "sample"],
  ["sample_channel.mp4", "sample_channel"],
  ["not a recorder output.txt", null],
  ["not-a-recorder-output.txt", "not-a-recorder-output"],
  ["../sample_20261114_123456.mp4", null],
  ["sample_20261114_12345.mp4", null]
];

for (const [fileName, expected] of cases) {
  assert.equal(getRecordingChannelSlug(fileName), expected, fileName);
}
assert.equal(getRecordingChannelSlug("x".repeat(261)), null);

const startedAt = new Date(2026, 10, 16, 20, 54, 47);
const liveStem = broadcastFileStem({
  slug: "daibututv2", displayName: "だいぶつv2", startedAt: startedAt.toISOString(), kind: "LIVE"
});
assert.equal(liveStem, "だいぶつv2__daibututv2__2026-11-16_20-54-47__LIVE");
assert.equal(broadcastFileDate(startedAt), "2026-11-16_20-54-47");
assert.equal(getRecordingChannelSlug(liveStem + ".mp4"), "daibututv2");
assert.equal(getRecordingChannelSlug(liveStem + "_retry02.ts"), "daibututv2");
assert.deepEqual(parseBroadcastFileStem(liveStem + ".jsonl"), {
  slug: "daibututv2", displayName: "だいぶつv2", kind: "LIVE", startedAt: startedAt.toISOString()
});
const vodUuid = "11111111-2222-4333-8444-555555555555";
const vodStem = broadcastFileStem({
  slug: "daibututv2", displayName: "だいぶつv2", startedAt: startedAt.toISOString(),
  kind: "VOD", videoId: vodUuid
});
assert.equal(vodStem, "だいぶつv2__daibututv2__2026-11-16_20-54-47__VOD_" + vodUuid);
assert.equal(parseBroadcastFileStem(vodStem + ".ass")?.videoId, vodUuid);
assert.equal(getRecordingChannelSlug(vodStem + "_take2.mkv"), "daibututv2");
assert.equal(safeKickDisplayName('CON', "daibututv2"), "daibututv2");
assert.equal(safeKickDisplayName('配信者:名前/テスト', "user"), "配信者_名前_テスト");
assert.equal(parseBroadcastFileStem("../wrong.mp4"), null);
assert.equal(broadcastFileDate("invalid"), "date-unknown");
assert.equal(broadcastFileStem({ slug: "channel", displayName: "配信者", startedAt: null, kind: "VOD", videoId: vodUuid }),
  "配信者__channel__date-unknown__VOD_" + vodUuid);

console.log("録画ライブラリのファイル分類テスト成功（LIVE／VOD／再接続／コメント付き動画の連番）");
