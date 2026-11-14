import assert from "node:assert/strict";
import {
  createVodChatAssHeader,
  escapeVodAssText,
  formatVodAssTimestamp,
  VodChatAssComposer
} from "../electron/vod-chat-ass.ts";

assert.equal(formatVodAssTimestamp(0), "0:00:00.00");
assert.equal(formatVodAssTimestamp(65.239), "0:01:05.23");
assert.equal(formatVodAssTimestamp(3661.999), "1:01:01.99");

const escaped = escapeVodAssText("こんにちは, {\\pos(1,2)}\n[emote:123:Nice]");
assert.ok(escaped.includes("\\\\{"));
assert.ok(escaped.includes("\\\\}"));
assert.ok(escaped.includes("Nice"));
assert.ok(!escaped.includes("\n"));

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
assert.ok(first.includes("\\\\move("));
assert.ok(first.includes("テストコメント"));
const second = composer.createDialogue({ content: "別のコメント", timeInSeconds: 12.345 });
assert.ok(second);
assert.notEqual(first, second, "同時刻のコメントは別レーンへ配置する");
assert.equal(composer.createDialogue({ content: "配信終了後", timeInSeconds: 3600 }), null);
assert.equal(composer.createDialogue({ content: " ", timeInSeconds: 10 }), null);
assert.equal(composer.createDialogue({ content: "負の時刻", timeInSeconds: -1 }), null);
console.log("VOD ASS字幕生成テスト成功（タイムスタンプ・文字エスケープ・同時刻レーン・時間範囲）");
