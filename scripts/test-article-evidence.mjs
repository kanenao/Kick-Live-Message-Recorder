import assert from "node:assert/strict";
import {
  buildArticleEvidenceTimeline, mergeArticleEvidenceTimeline, formatArticleEvidenceTime
} from "../electron/article-evidence.ts";
const began = "2026-11-18T10:00:00.000Z";
const chat = [
  { at: "2026-11-18T10:00:05.000Z", text: "冒頭のコメント" },
  { at: "2026-11-18T10:07:45.000Z", text: "[emote:123:NICE] 中盤の内容" },
  { at: "2026-11-18T11:00:00.000Z", text: "最後のコメント" },
  { at: "bad timestamp", text: "時刻不明の投稿" },
  { at: "2026-11-18T09:59:00.000Z", text: "配信前の投稿" }
];
const audio = [
  { startSeconds: 70, text: "冒頭の音声文字起こし" },
  { startSeconds: 3600, text: "終盤の音声文字起こし" }
];
const frames = [{ timeSeconds: 120 }, { timeSeconds: 3500 }];
const evidence = buildArticleEvidenceTimeline(began, chat, audio, frames);
assert.deepEqual(evidence.map(e => e.source), ["chat", "audio", "video", "chat", "video", "audio", "chat"]);
assert.ok(evidence.every(e => e.timeSeconds >= 0 && !e.detail.includes("[emote:")));
assert.ok(!evidence.some(e => e.detail.includes("時刻不明") || e.detail.includes("配信前")));
assert.equal(formatArticleEvidenceTime(3661.99), "01:01:01");
assert.deepEqual(buildArticleEvidenceTimeline("bad", [], [], []), []);
// VOD logs can have a valid relative offset but no reliable absolute wall-clock timestamp.
assert.deepEqual(
  buildArticleEvidenceTimeline(began, [{ at: "", timeInSeconds: 15, text: "VODコメント" }], [], []),
  [{ source: "chat", timeSeconds: 15, detail: "VODコメント" }]
);
assert.deepEqual(buildArticleEvidenceTimeline(began, [{at:"",text:"時刻なし"}], [], []), []);
const noisy = Array.from({ length: 100 }, (_, i) => ({ at: new Date(Date.parse(began) + i * 30_000).toISOString(), text: "視聴者の反応" + i }));
const sampled = buildArticleEvidenceTimeline(began, noisy, audio, frames, 12);
assert.ok(sampled.length <= 12);
assert.ok(sampled.some(e => e.source === "audio") && sampled.some(e => e.source === "video"));
assert.ok(sampled.some(e => e.timeSeconds === 0) && sampled.some(e => e.timeSeconds >= 2900), "長時間の冒頭と終盤を保持");
const merged = mergeArticleEvidenceTimeline(sampled, [sampled[0], {source:"chat", timeSeconds:3600, detail:"新しい反応"}], 18);
assert.equal(merged.filter(e => e.source === sampled[0].source && e.timeSeconds === sampled[0].timeSeconds && e.detail === sampled[0].detail).length, 1);
assert.ok(merged.some(e => e.detail === "新しい反応"));
console.log("配信AI新聞：映像・音声・コメント時刻別根拠と省略・重複回避テスト成功");
