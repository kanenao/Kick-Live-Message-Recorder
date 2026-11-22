import assert from "node:assert/strict";
import {
  getAiAnalysisRetryDelayMs,
  isRetryableAiAnalysisError,
  MAX_FINAL_AI_ANALYSIS_RETRIES
} from "../electron/ai-retry-policy.ts";

for (const message of [
  "Ollama APIエラー（HTTP 429）：rate limit",
  "Ollama APIエラー（HTTP 503）：service unavailable",
  "OpenAI APIエラー（HTTP 502）：bad gateway",
  "Ollamaへ接続できません。ECONNREFUSED",
  "AI記事の生成がタイムアウトしました。",
  "fetch failed: ECONNRESET"
]) assert.equal(isRetryableAiAnalysisError(new Error(message)), true, message);

for (const message of [
  "Ollama APIエラー（HTTP 400）：invalid request",
  "OpenAI APIエラー（HTTP 401）：unauthorized",
  "OpenAI APIキーを保存してください。",
  "現在のOllamaモデルは画像入力に対応していません。Vision対応モデルへ変更してください。",
  "AI応答に記事本文として利用できる文章がありません。"
]) assert.equal(isRetryableAiAnalysisError(new Error(message)), false, message);

assert.equal(MAX_FINAL_AI_ANALYSIS_RETRIES, 2);
assert.deepEqual(
  [1, 2, 3, 4, 10].map(getAiAnalysisRetryDelayMs),
  [2_000, 4_000, 8_000, 15_000, 15_000]
);
console.log("配信AI新聞：一時障害と設定エラーの分類・最終解析再試行待機テスト成功");
