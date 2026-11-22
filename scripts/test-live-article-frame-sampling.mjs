import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addLiveArticleFrameSample,
  LIVE_ARTICLE_FRAME_ANALYSIS_LIMIT,
  LIVE_ARTICLE_FRAME_HISTORY_LIMIT
} from "../electron/live-article-frame-sampling.ts";

const frame = (index) => ({ timeSeconds: index * 25, imageBase64: "jpeg-" + index });
let history = [];
let seenCount = 0;

// Keep the first seven samples while still including the current frame.
for (let index = 0; index < 7; index += 1) {
  const next = addLiveArticleFrameSample(history, frame(index), seenCount, () => 0.99);
  history = next.historyFrames;
  seenCount = next.seenCount;
  assert.equal(seenCount, index + 1);
  assert.ok(next.frames.some(item => item.timeSeconds === index * 25));
}
assert.equal(history.length, LIVE_ARTICLE_FRAME_HISTORY_LIMIT);
const eighth = addLiveArticleFrameSample(history, frame(7), seenCount, () => 0.99);
assert.equal(eighth.seenCount, 8);
assert.equal(eighth.frames.length, LIVE_ARTICLE_FRAME_ANALYSIS_LIMIT);
assert.equal(eighth.frames.at(-1)?.timeSeconds, 175);
assert.ok(eighth.frames.some(item => item.timeSeconds === 0), "初期の場面を保持する");

// A deterministic reservoir replacement proves that old samples are not
// simply shifted out as a rolling last-eight window.
const ninth = addLiveArticleFrameSample(eighth.historyFrames, frame(8), eighth.seenCount, () => 0);
assert.equal(ninth.seenCount, 9);
assert.ok(ninth.historyFrames.some(item => item.timeSeconds === 200));
assert.ok(ninth.frames.some(item => item.timeSeconds === 200), "最新場面を必ず含める");
assert.ok(ninth.frames.length <= LIVE_ARTICLE_FRAME_ANALYSIS_LIMIT);
assert.equal(new Set(ninth.frames.map(item => item.timeSeconds)).size, ninth.frames.length);

// Long streams remain bounded while the retained historical frames span the
// beginning, middle and end of the stream.
let state = { historyFrames: [], seenCount: 0 };
let seed = 0x12345678;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4_294_967_296;
};
let finalFrames = [];
for (let index = 0; index < 1200; index += 1) {
  const next = addLiveArticleFrameSample(state.historyFrames, frame(index), state.seenCount, random);
  state = { historyFrames: next.historyFrames, seenCount: next.seenCount };
  finalFrames = next.frames;
}
assert.equal(state.seenCount, 1200);
assert.ok(state.historyFrames.length <= LIVE_ARTICLE_FRAME_HISTORY_LIMIT);
assert.ok(finalFrames.length <= LIVE_ARTICLE_FRAME_ANALYSIS_LIMIT);
assert.equal(finalFrames.at(-1)?.timeSeconds, 1199 * 25);
assert.ok(finalFrames[0].timeSeconds < 5 * 60 * 25, "冒頭付近の場面を保持");
assert.ok(finalFrames.some(item => item.timeSeconds > 400 * 25 && item.timeSeconds < 800 * 25), "中盤の場面を保持");
assert.ok(finalFrames.some(item => item.timeSeconds > 900 * 25), "終盤の場面を保持");

// Invalid frames do not advance the sampling counter.
const invalid = addLiveArticleFrameSample(state.historyFrames, { timeSeconds: -1, imageBase64: "" }, state.seenCount);
assert.equal(invalid.seenCount, state.seenCount);
assert.deepEqual(invalid.historyFrames, state.historyFrames);


const mainSource = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
const liveSource = readFileSync(new URL("../electron/live-articles.ts", import.meta.url), "utf8");
const uiSource = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const captureSource = readFileSync(new URL("../electron/live-video-frames.ts", import.meta.url), "utf8");
assert.ok(mainSource.includes("liveArticleFrameSampleStates"), "キャプチャ再接続後も抽出履歴を維持する");
assert.ok(mainSource.includes("addLiveArticleFrameSample(frames, frame, sampleState.seenCount)"),
  "LIVE映像を全時間帯のリザーバー抽出へ接続する");
assert.ok(mainSource.includes("liveArticleFrameSampleStates.delete(slug)"),
  "配信終了時に配信者別のサンプル履歴を解放する");
assert.ok(!/frames\\.push\\(frame\\);\\s*if \\(frames\\.length > 8\\) frames\\.shift\\(\\)/.test(mainSource),
  "直近8枚だけを残すローリング方式を使わない");
assert.ok(liveSource.includes("videoAnalyzedSampleCount = videoFramesForAnalysis.length"),
  "AIに実際に送ったフレーム数を保存する");
assert.ok(uiSource.includes("AI解析した代表フレーム") && uiSource.includes("取得累計"),
  "AI解析枚数と取得累計を分けて表示する");
assert.ok(captureSource.includes("配信全体から選んだ代表フレーム最大8枚"),
  "LIVEキャプチャの状態表示が新しい抽出方式と一致する");

console.log("LIVE配信AI新聞：長時間映像の均等リザーバー抽出・最新場面保持・メモリ上限テスト成功");
