import assert from "node:assert/strict";
import { getAvailableArticleChannels, selectAssociatedArticleLogs } from "../src/shared/article-sources.ts";
const uuid = "11223344-5566-7788-99aa-bbccddeeff00";
const vod = "花子__hanako__2026-11-18_20-00-00__VOD_" + uuid + ".mp4";
const live = "花子__hanako__2026-11-18_21-00-00__LIVE.mp4";
const logs = [
  { name: "花子__hanako__2026-11-18_20-00-00__VOD_" + uuid + ".jsonl", path: "vod", channelSlug: "hanako", kind: "VOD" },
  { name: "花子__hanako__2026-11-18_21-00-00__LIVE.jsonl", path: "live", channelSlug: "hanako", kind: "LIVE" },
  { name: "花子__hanako__2026-11-18_22-00-00__LIVE.jsonl", path: "otherLive", channelSlug: "hanako", kind: "LIVE" },
  { name: "花子__hanako__2026-11-18_23-00-00__VOD_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl", path: "otherVod", channelSlug: "hanako", kind: "VOD" },
  { name: "花子__other__2026-11-18_21-00-00__LIVE.jsonl", path: "other", channelSlug: "other", kind: "LIVE" },
  { name: "花子__hanako__2026-11-18_21-00-00__LIVE_retry2.jsonl", path: "liveRetry", channelSlug: "hanako", kind: "LIVE" }
];
assert.deepEqual(selectAssociatedArticleLogs(vod, "hanako", logs), ["vod"], "別のVODやLIVEのコメントは混ぜない");
assert.deepEqual(selectAssociatedArticleLogs(live, "hanako", logs), ["live", "liveRetry"], "同じ録画の再試行分を選ぶ");
assert.deepEqual(selectAssociatedArticleLogs(vod, "other", logs), [], "配信者の不一致を拒否");
assert.deepEqual(getAvailableArticleChannels(["registered"], [vod, live]), ["hanako", "registered"], "未登録配信者も録画から発見");
console.log("配信AI新聞：配信単位のコメントログ・未登録配信者・再試行ファイル分類テスト成功");
