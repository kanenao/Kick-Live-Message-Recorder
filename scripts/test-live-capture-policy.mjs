import assert from "node:assert/strict";
import {
  classifyLiveCaptureExit,
  detachCaptureIfCurrent,
  getLiveAudioCaptureOffsetSeconds,
  isPermanentLiveAudioCaptureError,
  nextLiveAudioCaptureRetryDelayMs,
  nextManualCaptureRetryDelayMs
} from "../electron/live-capture-policy.ts";

assert.equal(classifyLiveCaptureExit(0, 1), "completed");
assert.equal(classifyLiveCaptureExit(0, 0), "error");
assert.equal(classifyLiveCaptureExit(1, 8), "error");
assert.equal(classifyLiveCaptureExit(null, 8), "error");

assert.deepEqual(
  [1, 2, 3, 4, 5, 6].map(nextManualCaptureRetryDelayMs),
  [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]
);

const captures = new Map();
const original = { stop: true };
const replacement = { stop: false };
captures.set("channel", original);
assert.equal(detachCaptureIfCurrent(captures, "channel", original), true);
assert.equal(captures.has("channel"), false);

captures.set("channel", replacement);
assert.equal(detachCaptureIfCurrent(captures, "channel", original), false);
assert.equal(captures.get("channel"), replacement);

assert.deepEqual([1, 2, 3, 4, 5, 6].map(nextLiveAudioCaptureRetryDelayMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
assert.equal(isPermanentLiveAudioCaptureError("spawn ffmpeg ENOENT"), true);
assert.equal(isPermanentLiveAudioCaptureError("Stream map '0:a:0' matches no streams"), true);
assert.equal(isPermanentLiveAudioCaptureError("HTTP connection reset by peer"), false);
assert.equal(getLiveAudioCaptureOffsetSeconds(120, 10_000, 12_500), 122.5);

console.log("LIVE映像・音声キャプチャの終了判定・再接続待機・時刻整合性テスト成功");
