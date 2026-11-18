import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ui = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const live = readFileSync(new URL("../electron/live-articles.ts", import.meta.url), "utf8");
assert.ok(live.includes("retryResponse = await fetch"), "Ollamaの不完全応答をリトライする");
assert.ok(live.includes('note: "画像は送信していません。映像を見たと書かないでください。"'),
  "テキスト再試行で未確認の映像を記事根拠にしない");
assert.ok(live.includes("article.commentEvidenceCount = totalCommentsSeen;"), "実際に参照候補として抽出されたコメント数を保持");
assert.ok(ui.includes("AI参照候補"), "記事画面にコメント参照候補数を明示");
assert.ok(live.includes("session.pendingComments.length > 2000"), "コメントの一時的な集中で記事用コメントを即座に落とさない");
console.log("配信AI新聞：Ollamaリトライ・映像根拠の分離・コメント表示テスト成功");
