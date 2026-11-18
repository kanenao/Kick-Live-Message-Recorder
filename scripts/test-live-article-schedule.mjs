import assert from "node:assert/strict";
import { nextLiveArticleAnalysisDelayMs } from "../electron/article-analysis-policy.ts";
const base = { pendingComments: 0, pendingAudio: false, pendingVisual: false, lastAnalysisAt: 0, intervalSeconds: 120, now: 5000 };
assert.equal(nextLiveArticleAnalysisDelayMs(base), null);
assert.equal(nextLiveArticleAnalysisDelayMs({ ...base, pendingComments: 1 }), 30000,
  "LIVE記事は少数コメントでも30秒以内に分析予約する");
assert.equal(nextLiveArticleAnalysisDelayMs({ ...base, pendingComments: 12 }), 0,
  "大量コメントはすぐに解析する");
assert.equal(nextLiveArticleAnalysisDelayMs({ ...base, pendingVisual: true }), 0);
assert.equal(nextLiveArticleAnalysisDelayMs({ ...base, pendingAudio: true }), 0);
assert.equal(nextLiveArticleAnalysisDelayMs({ ...base, pendingComments: 1, lastAnalysisAt: 3000, now: 5000 }), 118000,
  "連続更新はAIモデルへの呼び出し間隔を守る");
assert.equal(nextLiveArticleAnalysisDelayMs({ ...base, pendingComments: 1, lastAnalysisAt: 3000, now: 125000 }), 0);
console.log("AI新聞：少数コメントのLIVE自動解析・更新間隔の制限テスト成功");
