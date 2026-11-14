import assert from "node:assert/strict";
import { getRecordingChannelSlug } from "../src/shared/recording-library.ts";

const cases = [
  ["sample_20261114_123456.mp4", "sample"],
  ["sample_channel_20261114_123456.mkv", "sample_channel"],
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
console.log("録画ライブラリのファイル分類テスト成功（LIVE／VOD／再接続／コメント付き動画の連番）");
