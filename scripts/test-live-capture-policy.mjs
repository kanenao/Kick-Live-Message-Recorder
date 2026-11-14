import assert from "node:assert/strict";
import {
  classifyLiveCaptureExit,
  detachCaptureIfCurrent,
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

console.log("LIVE映像キャプチャの終了判定・再接続待機・世代安全性テスト成功");
