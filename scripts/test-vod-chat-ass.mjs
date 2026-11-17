import assert from "node:assert/strict";
import {
  createVodChatAssHeader,
  escapeVodAssText,
  formatKickEmoteTokens,
  formatVodAssTimestamp,
  normalizeVodChatAssOptions,
  VodChatAssComposer
} from "../electron/vod-chat-ass.ts";

assert.equal(formatVodAssTimestamp(0), "0:00:00.00");
assert.equal(formatVodAssTimestamp(65.239), "0:01:05.23");
assert.equal(formatVodAssTimestamp(3661.999), "1:01:01.99");

const escaped = escapeVodAssText("こんにちは, {\\pos(1,2)}\n[emote:123:Nice]");
assert.ok(escaped.includes("\\{"));
assert.ok(escaped.includes("\\}"));
assert.ok(escaped.includes("Nice"));
assert.ok(!escaped.includes("\n"));

assert.equal(formatKickEmoteTokens("こんにちは [emote:123:Nice] ありがとう", true), "こんにちは ありがとう");
assert.equal(formatKickEmoteTokens(" [emote:123:Nice] [emote:456:Pog] ", true), "");
assert.equal(formatKickEmoteTokens("こんにちは [emote:123:Nice]", false), "こんにちは Nice");
assert.equal(formatKickEmoteTokens("emoteは普通の単語です", true), "emoteは普通の単語です");
assert.equal(escapeVodAssText("ありがとう [emote:123:Nice]", true), "ありがとう");

const filteredComposer = new VodChatAssComposer(3600, true);
assert.equal(filteredComposer.createDialogue({ content: "[emote:123:Nice]", timeInSeconds: 10 }), null);
const filteredDialogue = filteredComposer.createDialogue({ content: "おはよう [emote:123:Nice] ございます", timeInSeconds: 11 });
assert.ok(filteredDialogue?.includes("おはよう ございます"));
assert.ok(!filteredDialogue?.includes("Nice"));

const header = createVodChatAssHeader("sample_channel", "過去配信タイトル");
assert.ok(header.includes("[Script Info]"));
assert.ok(header.includes("[V4+ Styles]"));
assert.ok(header.includes("[Events]"));
assert.ok(header.includes("PlayResX: 1920"));
assert.ok(header.includes("ＭＳ Ｐゴシック"));

const composer = new VodChatAssComposer(3600);
const first = composer.createDialogue({ content: "テストコメント", timeInSeconds: 12.345 });
assert.ok(first);
assert.ok(first.startsWith("Dialogue: 0,0:00:12.34,"));
assert.ok(first.includes("\\move("));
assert.ok(first.includes("テストコメント"));
const second = composer.createDialogue({ content: "別のコメント", timeInSeconds: 12.345 });
assert.ok(second);
assert.notEqual(first, second, "同時刻のコメントは別レーンへ配置する");
assert.equal(composer.createDialogue({ content: "配信終了後", timeInSeconds: 3600 }), null);
assert.equal(composer.createDialogue({ content: " ", timeInSeconds: 10 }), null);
assert.equal(composer.createDialogue({ content: "負の時刻", timeInSeconds: -1 }), null);
// Slow/fast flow, right-edge entrance, sync offset, and collision-aware overflow.
const tuned = new VodChatAssComposer(120, false, { autoFlow: false,
  crossingSeconds: 4, speedPercent: 150, entryOffsetPx: 180,
  rowLimit: 1, collisionGap: 50, delaySeconds: 1.5
});
const tunedFirst = tuned.createDialogue({ content: "一つ目", timeInSeconds: 12 });
assert.ok(tunedFirst?.startsWith("Dialogue: 0,0:00:13.50,"));
assert.ok(tunedFirst?.includes("\\move(2100,24,"), "右端より外側から進入する");
assert.equal(tuned.createDialogue({ content: "二つ目", timeInSeconds: 12 }), null,
  "すべての行が使用中なら無理に重ねずスキップする");
assert.ok(tuned.createDialogue({ content: "次のコメント", timeInSeconds: 18 }),
  "先行コメントが通過した行は再利用できる");
const slow = new VodChatAssComposer(120, false, { autoFlow: false, crossingSeconds: 6, speedPercent: 50, rowLimit: 1 });
const fast = new VodChatAssComposer(120, false, { autoFlow: false, crossingSeconds: 6, speedPercent: 200, rowLimit: 1 });
const getEnd = (dialogue) => dialogue.split(",")[2];
const slowEnd = getEnd(slow.createDialogue({ content: "速度確認", timeInSeconds: 10 }));
const fastEnd = getEnd(fast.createDialogue({ content: "速度確認", timeInSeconds: 10 }));
assert.ok(slowEnd > fastEnd, "ゆっくりの方が画面移動時間が長い");
const burst = new VodChatAssComposer(120, true, { rowLimit: 3, autoFlow: false });
assert.equal([0,1,2,3,4].filter(() => burst.createDialogue({ content: "同時刻", timeInSeconds: 5 }) !== null).length, 3,
  "同時刻の大量コメントは3行に制限し、重なりを発生させない");
const bounds = normalizeVodChatAssOptions({ crossingSeconds: 0, speedPercent: Infinity, entryOffsetPx: 99999, rowLimit: 99, collisionGap: -100, delaySeconds: -999 });
assert.equal(bounds.crossingSeconds, 2);
assert.equal(bounds.speedPercent, 100);
assert.equal(bounds.entryOffsetPx, 300);
assert.equal(bounds.rowLimit, 18);
assert.equal(bounds.collisionGap, 0);
assert.equal(bounds.delaySeconds, -10);
assert.equal(new VodChatAssComposer(10, false, { delaySeconds: -3 }).createDialogue({ content: "早すぎ", timeInSeconds: 1 }), null);
console.log("VOD ASS字幕生成テスト成功（速度・進入位置・同期・行数・衝突防止・emote除去）");
