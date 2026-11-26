import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const ui=readFileSync(new URL("../src/ui/KickRanking.tsx",import.meta.url),"utf8");
assert.ok(ui.includes('keep:"→ KEEP"'));assert.ok(!ui.includes("＝ KEEP"));assert.ok(ui.includes("SmoothRankingThumbnail"));assert.ok(ui.includes("onLoad={()=>setShown(candidate)}"));assert.ok(ui.includes("ranking-thumb-pending"));assert.ok(ui.includes("const RANKING_REFRESH_MS=10000"));assert.ok(!ui.includes('setBusy(true);setError("")'));console.log("10秒更新の画像差し替え・KEEP表示");
