import assert from "node:assert/strict";
import {
  getLiveAudioCaptureOffsetSeconds,
  isPermanentLiveAudioCaptureError,
  nextLiveAudioCaptureRetryDelayMs
} from "../electron/live-capture-policy.ts";

assert.deepEqual(
  [1, 2, 3, 4, 5, 6, 8].map(nextLiveAudioCaptureRetryDelayMs),
  [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]
);

for (const message of [
  "spawn ffmpeg ENOENT",
  "Stream map '0:a:0' matches no streams",
  "Output file does not contain any stream",
  "Unrecognized option 'bad-flag'"
]) {
  assert.equal(isPermanentLiveAudioCaptureError(message), true, message);
}
for (const message of [
  "HTTP 503 Service Unavailable",
  "Connection reset by peer",
  "The TLS connection was non-properly terminated",
  "LIVE音声ストリームの取得が終了しました（終了コード：1）。"
]) {
  assert.equal(isPermanentLiveAudioCaptureError(message), false, message);
}

assert.equal(getLiveAudioCaptureOffsetSeconds(0, 1_000, 1_000), 0);
assert.equal(getLiveAudioCaptureOffsetSeconds(120, 10_000, 12_500), 122.5);
assert.equal(getLiveAudioCaptureOffsetSeconds(-5, 10_000, 8_000), 0);

console.log("LIVE音声キャプチャの再接続間隔・恒久エラー判定・時刻オフセットテスト成功");
