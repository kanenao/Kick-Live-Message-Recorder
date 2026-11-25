import assert from "node:assert/strict";
import {collectRanking,parseRankingPage,registeredRank} from "../electron/kick-ranking.ts";
const make=(slug,viewers,extra={})=>({channel:{slug},broadcaster_user:{username:slug},viewer_count:viewers,title:"test",language_code:"ja",started_at:"2026-11-25T00:00:00Z",...extra});
let requests=[];
const snapshot=await collectRanking("ja",async url=>{requests.push(url);return requests.length===1?{data:[make("sample",5),make("top",20)],pagination:{next_cursor:"page2"}}:{data:[make("sample",8),make("other",10)],pagination:{next_cursor:null}}});
assert.equal(requests.length,2);assert.equal(requests[0].searchParams.get("language_code"),"ja");assert.equal(requests[1].searchParams.get("cursor"),"page2");
assert.deepEqual(snapshot.entries.map(r=>r.slug),["top","other","sample"]);assert.equal(snapshot.complete,true);
const next=await collectRanking("ja",async()=>({data:[make("sample",30),make("top",20)],pagination:{}}),snapshot);
assert.equal(next.entries[0].rankChange,2);assert.equal(next.entries[0].viewerChange,22);
const capped=await collectRanking("all",async()=>({data:[make("sample",1)],pagination:{next_cursor:"same"}}),undefined,2);assert.equal(capped.complete,false);
assert.equal(parseRankingPage({data:[make("bad",-1),make("valid",0,{thumbnail:"https://example.com/track"})]}).entries[0].thumbnail,null);
assert.throws(()=>parseRankingPage({unexpected:[]}));
assert.equal(parseRankingPage({data:[make("a".repeat(41),100)]}).excluded,1);
const missingLang=await collectRanking("ja",async()=>({data:[make("sample",1,{language_code:""})],pagination:{}}));assert.equal(missingLang.complete,false);assert.equal(missingLang.excluded,1);
console.log("Kickランキング：ページ取得、順位・増減、重複除外、暫定表示、安全なサムネイル検証成功");

const tracked=await collectRanking("ja",async()=>({data:Array.from({length:550},(_,i)=>make("c"+i,1000-i)),pagination:{}}),undefined,20,["c549"]);
assert.equal(tracked.entries.length,500);assert.equal(tracked.trackedEntries[0].rank,550);assert.equal(registeredRank(tracked,"c549","2026-11-25T00:00:00Z",Date.parse(tracked.fetchedAt)),"550位");assert.equal(registeredRank(tracked,"c549","2026-11-25T01:00:00Z",Date.parse(tracked.fetchedAt)),"新しい配信を確認中");
