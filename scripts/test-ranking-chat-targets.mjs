import assert from "node:assert/strict";
import {rankingChatTargets} from "../electron/ranking-chat-targets.ts";
const snapshot={entries:Array.from({length:50},(_,i)=>({slug:"c"+i})),trackedEntries:[{slug:"registered"},{slug:"c0"}]};
const targets=rankingChatTargets(snapshot,"c49",["c0"]);
assert.equal(targets.length,30);assert.ok(targets.includes("registered"));assert.ok(targets.includes("c49"));assert.ok(!targets.includes("c0"));assert.ok(!targets.includes("c48"));
assert.ok(!rankingChatTargets(snapshot,"unknown",[]).includes("unknown"));
assert.equal(rankingChatTargets(snapshot,null,[],99).length,30);
console.log("ランキングコメント：優先対象、既存接続除外、上限、未知配信拒否");

const many={entries:Array.from({length:50},(_,i)=>({slug:"c"+i,rank:i+1,viewers:100-i,viewerChange:i===49?999:0})),trackedEntries:Array.from({length:40},(_,i)=>({slug:"r"+i}))};
const protectedTargets=rankingChatTargets(many,"c48",[]);for(let i=0;i<10;i++)assert.ok(protectedTargets.includes("c"+i));assert.ok(protectedTargets.includes("c48"));assert.ok(protectedTargets.includes("c49"));assert.equal(protectedTargets.length,30);
