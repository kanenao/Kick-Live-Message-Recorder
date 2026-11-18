import assert from "node:assert/strict";
import { articleDurationForSave } from "../electron/article-timeline.ts";
const started = "2026-11-15T00:00:00.000Z";
const now = Date.parse("2026-11-19T00:00:00.000Z");
assert.equal(articleDurationForSave(started, 960, "completed", now), 960);
assert.equal(articleDurationForSave(started, 960, undefined, now), 960);
assert.equal(articleDurationForSave(started, 0, "live", now), 345600);
assert.equal(articleDurationForSave("bad date", 960, "live", now), 0);
console.log("配信AI新聞：アーカイブ再解析後の配信時間保持テスト成功");
