import assert from "node:assert/strict";
import {
  getAudioTranscriptionRetryDelayMs,
  isRetryableAudioTranscriptionError
} from "../electron/audio-retry-policy.ts";

for (const message of [
  "音声認識モデルへ接続できません。Ollamaの起動と接続URLを確認してください。",
  "音声の抽出処理がタイムアウトしました。",
  "Ollama音声認識エラー（HTTP 429）：rate limit",
  "Ollama音声認識エラー（HTTP 503）：service unavailable",
  "fetch failed: ECONNRESET"
]) {
  assert.equal(isRetryableAudioTranscriptionError(new Error(message)), true, message);
}

for (const message of [
  "音声認識モデル「frozenlab/qwen3-asr:0.6b」がありません。",
  "現在のOllamaではこの音声モデルを実行できません。qwen3a音声入力に対応したOllamaへ更新してください。",
  "音声チャンクのサイズが上限を超えています。",
  "Ollama音声認識エラー（HTTP 400）：invalid request",
  "Ollama音声認識エラー（HTTP 401）：unauthorized"
]) {
  assert.equal(isRetryableAudioTranscriptionError(new Error(message)), false, message);
}

assert.deepEqual(
  [1, 2, 3, 4, 5, 6, 20].map(getAudioTranscriptionRetryDelayMs),
  [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]
);

console.log("LIVE音声認識の一時障害判定・再試行間隔テスト成功");
