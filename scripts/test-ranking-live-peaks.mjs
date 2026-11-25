import assert from "node:assert/strict";
import {LiveRankingPeaks} from "../electron/ranking-live-peaks.ts";
import {registeredRankPeakLabel,registeredRankPeak,registeredRankChangeLabel} from "../electron/kick-ranking.ts";
const peaks=new LiveRankingPeaks(),start="2026-11-25T00:00:00Z",next="2026-11-25T01:00:00Z";
function snapshot(at,rank,viewers,complete=true,startedAt=start,scope="ja"){const row={slug:"sample",startedAt,rank,viewers,rankChange:1};return {scope,fetchedAt:at,complete,entries:[row],trackedEntries:[row],pages:1,total:1,excluded:0};}
function observe(s){s.livePeaks=peaks.observe(s);return s;}
let s=observe(snapshot("2026-11-25T00:10:00Z",5,20));
assert.equal(registeredRankPeakLabel(s,"sample",start),"5位");
s=observe(snapshot("2026-11-25T00:11:00Z",2,30,false));
assert.equal(registeredRankPeakLabel(s,"sample",start),"5位 / 暫定 2位");
assert.equal(registeredRankPeak(s,"sample",start).peakViewers,30);
assert.equal(registeredRankChangeLabel(s,"sample",start,Date.parse(s.fetchedAt)),"—");
s=observe(snapshot("2026-11-25T00:12:00Z",3,15));
assert.equal(registeredRankPeak(s,"sample",start).bestRank,3);
assert.equal(registeredRankPeak(s,"sample",start).samples,3);
assert.equal(registeredRankChangeLabel(s,"sample",start,Date.parse(s.fetchedAt)),"↑ 1");
const world=observe(snapshot("2026-11-25T00:12:00Z",10,25,true,start,"all"));
assert.equal(registeredRankPeakLabel(world,"sample",start),"10位");
s=observe(snapshot("2026-11-25T01:05:00Z",8,10,true,next));
assert.equal(registeredRankPeak(s,"sample",start),null);
assert.equal(registeredRankPeakLabel(s,"sample",next),"8位");
assert.equal(registeredRankPeak(s,"sample",next).peakViewers,10);
assert.equal(registeredRankPeak(observe(s),"sample",next).samples,1);
console.log("LIVE順位：番組別・範囲別最高記録、暫定分離、重複観測防止");
