import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deduplicateArticleSentences,
  deduplicateArticleList
} from "../electron/article-text-dedupe.ts";
import { parseAiArticleResponse } from "../electron/ai-response.ts";

const repetitive = "映画『フレディ・バザズ・フレディ』の配信に関するコメントと音声文字起こしを紹介します。";
const action = "映画の内容は、ジェイソンが中国に連れて行かれるシーンから始まり、その後ジェイソンの墓が掘り起こされます。";
const ending = "最後には、ジェイソンが四年後に復活する様子が描かれています。";
const scene = repetitive + action + ending;
const unique = "映像ではベッドの上にいる猫が画面に映っています。";
const nearRepeat = "映画『フレディ・バザズ・フレディ』の配信に関するコメントと音声文字起こしを紹介します！";
assert.equal(deduplicateArticleSentences(repetitive + action + repetitive + ending), [repetitive, action, ending].join(" "),
  "同一文章内で繰り返される長い文を除去する");
assert.deepEqual(deduplicateArticleList([scene, scene, nearRepeat, unique]), [[repetitive, action, ending].join(" "), unique],
  "AIが同じ映像説明を何度列挙しても1件にする");
assert.deepEqual(deduplicateArticleList([scene, scene, unique], 8, 1000, scene), [unique],
  "映像要約に書いた文章を場面一覧で繰り返さない");
assert.deepEqual(deduplicateArticleList(["00:01:20 映像では猫が寝ています。", "00:59:55 放送者が猫を抱き上げています。"]), [
  "00:01:20 映像では猫が寝ています。",
  "00:59:55 放送者が猫を抱き上げています。"
], "異なる映像場面・時刻は消さない");
assert.deepEqual(deduplicateArticleList(["短い反応", "短い反応", "違う反応"]), ["短い反応", "違う反応"],
  "短い定型文の完全重複だけ除去");

const payload = { message: { content: JSON.stringify({
  headline: "映画配信を紹介",
  summary: repetitive + repetitive,
  paragraphs: [repetitive + action, repetitive + action, "視聴者コメントを集計しています。"],
  highlights: [repetitive, repetitive],
  videoSummary: scene + scene,
  videoScenes: [scene, scene, unique],
  audioSummary: "音声から映画の話題を確認しました。音声から映画の話題を確認しました。"
}) } };
const parsed = parseAiArticleResponse(payload);
assert.equal(parsed.summary, repetitive);
assert.deepEqual(parsed.paragraphs, [repetitive + " " + action, "視聴者コメントを集計しています。"]);
assert.equal(parsed.highlights.length, 1);
assert.equal(parsed.videoSummary, [repetitive, action, ending].join(" "));
assert.deepEqual(parsed.videoScenes, [unique]);
assert.equal(parsed.audioSummary, "音声から映画の話題を確認しました。");
const source = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
assert.match(source, /deduplicateArticleList\(article\.videoScenes/, "保存済みの記事の画面表示も重複除去する");
assert.match(source, /deduplicateArticleSentences\(article\.videoSummary/, "古い映像要約にも重複除去を適用");
assert.match(source, /deduplicateArticleList\(article\.paragraphs/, "記事本文にも重複除去を適用");
console.log("配信AI新聞：重複した映像場面・要約・記事本文・古い記事の表示対策テスト成功");
