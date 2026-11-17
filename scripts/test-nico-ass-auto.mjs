import assert from "node:assert/strict";
import { computeNicoAssProfile, reserveNicoAssLane, updateNicoAssActivity } from "../electron/nico-ass-auto.ts";
import { normalizeVodChatAssOptions, VodChatAssComposer } from "../electron/vod-chat-ass.ts";

const short = computeNicoAssProfile(1920, 190, 44, 1);
const long = computeNicoAssProfile(1920, 1100, 44, 1);
const busy = computeNicoAssProfile(1920, 190, 44, 40);
assert.ok(long.speed > short.speed, "長文は表示が間延びしないよう速く動く");
assert.ok(busy.speed > short.speed, "集中時は速度を自動で上げる");
assert.ok(busy.entryOffsetPx > short.entryOffsetPx, "集中時は画面外から入る位置を調整");
assert.ok(updateNicoAssActivity(30, 10) < updateNicoAssActivity(30, 0), "混雑が解消すると元に戻す");
assert.equal(normalizeVodChatAssOptions({}).autoFlow, true, "初期状態は自動調整");
assert.equal(normalizeVodChatAssOptions({ autoFlow: false }).autoFlow, false, "手動モードも維持");

const lane = [{ start: 2, end: 12, entryX: 1930, width: 240, speed: 420 }];
const first = reserveNicoAssLane(lane, 2.1, 120, 1930, 140, 400, 30, 1.2);
assert.ok(first && first.start > 2.1 && first.start <= 3.3, "混雑時は最大1.2秒ずらして入場");
assert.equal(reserveNicoAssLane(lane, 2.1, 120, 1930, 140, 400, 30, 0), null,
  "手動モードの投稿時刻を動かさない");
const overtaking = [{ start: 0, end: 15, entryX: 1930, width: 160, speed: 300 }];
assert.equal(reserveNicoAssLane(overtaking, 2, 120, 1930, 140, 480, 30, 0), null,
  "出現時に離れていても後続が追いつく場合は同じ行を使わない");
assert.equal(reserveNicoAssLane(lane, 130, 120, 1930, 140, 400, 30, 1.2), null,
  "動画終了後は出力しない");
const full = Array.from({length: 2}, (_, i) => ({
  start: 3, end: 25, entryX: 1940, width: 2000, speed: 100 + i * 10
}));
assert.equal(reserveNicoAssLane(full, 3, 120, 1940, 200, 400, 30, 1.2), null,
  "安全に使える行がない場合は重ならないよう省略");

const auto = new VodChatAssComposer(120, true, { autoFlow: true, rowLimit: 1 });
const autoFirst = auto.createDialogue({ timeInSeconds: 10, content: "短い" });
const autoSecond = auto.createDialogue({ timeInSeconds: 10, content: "あとから" });
assert.ok(autoFirst && autoSecond, "混雑時でも短い入場待ちでコメントを保持する");
assert.ok(autoFirst !== autoSecond, "入場時間と速度が変化する");
console.log("ニコ生風ASSの自動速度・入場・行の衝突回避・手動切替テスト成功");
