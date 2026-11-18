import assert from "node:assert/strict";
import {
  ARTICLE_AUDIO_WINDOW_SECONDS, ARTICLE_AUDIO_CONTIGUOUS_LIMIT_SECONDS,
  ARTICLE_AUDIO_LONG_SAMPLE_LIMIT, articleAudioSamplingMode, planArticleAudioWindows
} from "../electron/article-audio-sampling.ts";

assert.deepEqual(planArticleAudioWindows(0), []);
assert.deepEqual(planArticleAudioWindows(Number.NaN), []);
assert.deepEqual(planArticleAudioWindows(90), [
  { startSeconds: 0, durationSeconds: 45 },
  { startSeconds: 45, durationSeconds: 45 }
]);
assert.deepEqual(planArticleAudioWindows(91), [
  { startSeconds: 0, durationSeconds: 45 },
  { startSeconds: 45, durationSeconds: 45 },
  { startSeconds: 90, durationSeconds: 1 }
]);
const short = planArticleAudioWindows(ARTICLE_AUDIO_CONTIGUOUS_LIMIT_SECONDS);
assert.equal(articleAudioSamplingMode(7200), "continuous");
assert.equal(short.length, 160);
assert.equal(short[0].startSeconds, 0);
assert.equal(short.at(-1).startSeconds, 7155);
const longDuration = 6 * 60 * 60 + 300;
const long = planArticleAudioWindows(longDuration);
assert.equal(articleAudioSamplingMode(longDuration), "distributed");
assert.equal(long.length, ARTICLE_AUDIO_LONG_SAMPLE_LIMIT);
assert.equal(long[0].startSeconds, 0, "6時間配信の冒頭を解析する");
assert.ok(long.at(-1).startSeconds >= longDuration - ARTICLE_AUDIO_WINDOW_SECONDS - 0.01, "最後まで音声を対象とする");
assert.ok(long.some(w => w.startSeconds > 2 * 3600 && w.startSeconds < 3 * 3600), "2時間以降も解析する");
assert.ok(long.some(w => w.startSeconds > 3 * 3600 && w.startSeconds < 5 * 3600), "中盤の音声も解析する");
assert.ok(long.every((w,i) => w.durationSeconds > 0 && w.durationSeconds <= 45 &&
  (i === 0 || w.startSeconds >= long[i-1].startSeconds + long[i-1].durationSeconds)));
const justOver = planArticleAudioWindows(7201);
assert.equal(justOver.length, ARTICLE_AUDIO_LONG_SAMPLE_LIMIT);
assert.ok(justOver.at(-1).startSeconds >= 7156);
const week = planArticleAudioWindows(7 * 86400);
assert.equal(week.length, ARTICLE_AUDIO_LONG_SAMPLE_LIMIT);
assert.ok(week.at(-1).startSeconds > 500000);
console.log("配信AI新聞：長時間VODの全時間帯・短時間連続音声サンプリング検証成功");
