import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { samplePreviewCommentsByTime } from "../electron/comment-preview-sampling.ts";

const early = Array.from({ length: 20000 }, (_, i) => ({
  seconds: i * 0.006, text: "early-" + i
}));
const late = Array.from({ length: 35 }, (_, i) => ({
  seconds: 6900 + i * 3, text: "late-" + i
}));
const sparseTail = samplePreviewCommentsByTime([...early, ...late], 7200, 1200);
assert.equal(sparseTail.length, 1200, "Bound the IPC payload to 1200 comments");
assert.ok(sparseTail.some(item => item.seconds < 1), "Early part is still visible");
assert.equal(sparseTail.filter(item => item.seconds >= 6900).length, late.length,
  "Every sparse late comment must survive a huge early chat burst");
assert.ok(sparseTail.every((item, i) => i === 0 || item.seconds >= sparseTail[i - 1].seconds),
  "Selected comments remain in chronological order");
assert.equal(sparseTail[0], early[0], "First comment in busy time window is preserved");
assert.equal(sparseTail.at(-1), late.at(-1), "Last actual comment must survive sampling");

const evenlySpread = Array.from({ length: 12000 }, (_, i) => ({
  seconds: i * 0.6, text: "tick-" + i
}));
const spread = samplePreviewCommentsByTime(evenlySpread, 7200, 1200);
assert.equal(spread.length, 1200);
for (let bucket = 0; bucket < 60; bucket++) {
  assert.ok(spread.some(item => item.seconds >= bucket * 120 &&
    item.seconds < (bucket + 1) * 120), "Every active time window is represented: " + bucket);
}
assert.equal(spread.at(-1).text, evenlySpread.at(-1).text,
  "When the VOD is active throughout, its end must remain represented");

assert.deepEqual(samplePreviewCommentsByTime([], 7200), []);
assert.deepEqual(samplePreviewCommentsByTime([{ seconds: 1, text: "hello" }], 7200, 0), []);
assert.deepEqual(samplePreviewCommentsByTime([
  { seconds: 15, text: "second" }, { seconds: Number.NaN, text: "invalid" },
  { seconds: 1, text: "first" }, { seconds: -1, text: "bad" }
], 60), [
  { seconds: 1, text: "first" }, { seconds: 15, text: "second" }
], "Nonfinite/negative timestamps do not reach the renderer");
assert.deepEqual(samplePreviewCommentsByTime(
  [{ seconds: 3, text: "a" }, { seconds: 5, text: "b" }], 0, 1200
), [{ seconds: 3, text: "a" }, { seconds: 5, text: "b" }],
"Missing duration should be handled gracefully");

const backend = readFileSync(new URL("../electron/comment-video.ts", import.meta.url), "utf8");
const stage = readFileSync(new URL("../src/ui/comment-live-preview.ts", import.meta.url), "utf8");
assert.match(backend, /samplePreviewCommentsByTime\(previewCandidates, info\.duration, 1200\)/,
  "Live preview uses time-stratified sampling");
assert.match(stage, /if \(occupied\[lane\] - comment\.seconds > 0\.8\) continue/,
  "No hidden multi-minute queue shift for overflowing chat during preview");

console.log("長時間Kick VODのコメントプレビュー：全時間帯の抽出、配信後半の表示、負荷制限、時刻ずれ対策テスト成功");
