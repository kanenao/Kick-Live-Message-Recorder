import assert from "node:assert/strict";
import {advanceRankFrame,rankingFrame,rankMovement} from "../electron/ranking-movement.ts";
const start="2026-11-25T00:00:00Z";
const row=(slug,rank,viewerChange,startedAt=start)=>({slug,rank,viewers:100-rank,viewerChange,rankChange:null,startedAt});
const chat=(slug,n)=>({slug,state:"connected",messages:n,observedSeconds:300,ratePerMinute:n,activeUsers:n,activeSeconds:300,activeComplete:true});
const snap=(entries,at,complete=true,total=entries.length,scope="ja")=>({scope,entries,fetchedAt:at,complete,total});
const previous=rankingFrame(snap([row("a",1,10),row("b",2,20)],"2026-11-25T00:05:00Z"),[chat("a",10),chat("b",20)]);
const nextRows=[row("b",1,5),row("a",2,30),row("c",3,0)];
const current=rankingFrame(snap(nextRows,"2026-11-25T00:06:00Z"),[chat("a",30),chat("b",10)]);
assert.deepEqual(rankMovement(current,previous,"viewers",nextRows[0]),{kind:"up",delta:1,previous:2});
assert.equal(rankMovement(current,previous,"growth",nextRows[0]).kind,"down");
assert.equal(rankMovement(current,previous,"chat",nextRows[1]).kind,"up");
assert.equal(rankMovement(current,previous,"active",nextRows[1]).kind,"up");
assert.equal(rankMovement(current,previous,"viewers",nextRows[2]).kind,"new");
assert.equal(rankMovement(current,previous,"chat",nextRows[2]).kind,"unknown");
assert.equal(rankMovement(current,null,"viewers",nextRows[2]).kind,"unknown");
const partial=rankingFrame(snap([row("a",1,10)],"2026-11-25T00:05:00Z",false,500));
assert.equal(rankMovement(current,partial,"viewers",nextRows[2]).kind,"unknown");
assert.equal(rankMovement(current,previous,"viewers",{...nextRows[0],rankChange:3}).previous,4);
assert.equal(rankMovement(current,previous,"growth",{...nextRows[0],startedAt:"2026-11-25T00:01:00Z"}).kind,"new");
console.log("順位変動：指標別UP/DOWN、NEW、観測不足、前回順位、範囲制限");

assert.equal(partial.ranks.chat.size,0);
assert.equal(partial.ranks.active.size,0);
assert.equal(rankMovement(current,previous,"active",nextRows[2]).kind,"unknown");
const equal=rankingFrame(snap(nextRows,"2026-11-25T00:07:00Z"),[chat("a",30),chat("b",10)]);
assert.deepEqual(rankMovement(equal,current,"growth",nextRows[1]),{kind:"keep",delta:0,previous:1});
const otherScope=rankingFrame(snap(nextRows,"2026-11-25T00:07:00Z",true,3,"all"));
assert.equal(rankMovement(otherScope,current,"viewers",nextRows[0]).kind,"unknown");

// Chat-only ticks must update rank movement even if Kick API data is unchanged.
const shared=snap([row("a",1,10),row("b",2,20)],"2026-11-25T00:08:00Z");
const chatBefore=rankingFrame(shared,[chat("a",10),chat("b",20)],"2026-11-25T00:08:00Z");
const chatAfter=rankingFrame(shared,[chat("a",30),chat("b",10)],"2026-11-25T00:08:10Z");
assert.equal(rankMovement(chatAfter,chatBefore,"chat",shared.entries[0]).kind,"up");
assert.equal(rankMovement(chatAfter,chatBefore,"active",shared.entries[1]).kind,"down");
assert.equal(rankMovement(chatAfter,chatBefore,"chat",shared.entries[0]).previous,2);
assert.equal(rankMovement(chatAfter,chatAfter,"chat",shared.entries[0]).kind,"unknown");
console.log("10秒チャット順位：API更新なしでも順位変動を独立比較");

const history1=advanceRankFrame(undefined,chatBefore);
const history2=advanceRankFrame(history1,chatAfter);
assert.equal(history2.previous,chatBefore);
assert.equal(advanceRankFrame(history2,chatAfter),history2);
assert.equal(advanceRankFrame(history2,chatBefore),history2);
const afterGap=rankingFrame(shared,[chat("a",1),chat("b",9)],"2026-11-25T00:09:00Z");
assert.equal(advanceRankFrame(history2,afterGap).previous,null);
assert.equal(advanceRankFrame(history2,otherScope).previous,null);
console.log("10秒観測：重複・逆順を無視し、長い欠測・範囲変更では比較しない");
