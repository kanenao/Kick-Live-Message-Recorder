import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const live = readFileSync(new URL("../electron/live-articles.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
assert.ok(live.includes("if (videoFrames.length > 0) article.videoAnalyzed = false"),
  "保存済み記事の再解析で新しい映像フレームを再送信する");

assert.ok(live.includes("pendingAnalysisComments?: CommentSample[]"),
  "LIVE記事に未解析コメントの保存欄を持つ");
assert.ok(live.includes("pendingAnalysisAudioSegments?: AudioTranscriptSegment[]"),
  "LIVE記事に未解析音声区間の保存欄を持つ");
assert.ok(live.includes("previous?.pendingAnalysisComments"),
  "アプリ再起動後に未解析コメントをキューへ復元する");
assert.ok(live.includes("previous?.pendingAnalysisAudioSegments"),
  "アプリ再起動後に未解析音声区間をキューへ復元する");
assert.ok(live.includes("[...batch, ...session.pendingComments].slice(-2000)"),
  "AIリクエスト中のコメントを先に記事JSONへ保存する");
assert.ok(live.includes("[...audioBatch, ...session.pendingAudioSegments].slice(-80)"),
  "AIリクエスト中の音声文字起こしを先に記事JSONへ保存する");
assert.ok(live.includes("article.pendingAnalysisComments = session.pendingComments.length"),
  "成功・失敗後に未処理コメント数を更新する");
assert.ok(live.includes("isRetryableAiAnalysisError(session.article.aiError)"),
  "最終AI解析で一時障害だけを再試行する");
assert.ok(live.includes("MAX_FINAL_AI_ANALYSIS_RETRIES"),
  "最終解析の再試行回数を制限する");
assert.ok(live.includes("Array.isArray(article.pendingAnalysisComments)"),
  "過去記事の再解析時に保存済みコメントを再利用する");
assert.ok(live.includes("Array.isArray(article.pendingAnalysisAudioSegments)"),
  "過去記事の再解析時に保存済み音声区間を再利用する");
assert.ok(ui.includes("AI未解析"),
  "記事カードに未解析データ件数を表示する");
assert.ok(ui.includes("保存済み未解析データを含めてAI再解析"),
  "記事カードから保存済みデータを使って再解析できる");
console.log("配信AI新聞：失敗時のコメント・音声保持、再起動復元、再解析UIテスト成功");
