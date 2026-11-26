import assert from "node:assert/strict";
import {momentumScores,refreshedRankingThumbnail,MOMENTUM_WEIGHTS} from "../electron/ranking-momentum.ts";
const rows=[{slug:"a",rank:1,viewers:100,viewerChange:10},{slug:"b",rank:2,viewers:90,viewerChange:100},{slug:"c",rank:3,viewers:80,viewerChange:null},{slug:"d",rank:4,viewers:50,viewerChange:-10}];
const chat=[{slug:"a",messages:0,state:"connected",observedSeconds:300,ratePerMinute:0,activeUsers:0,activeSeconds:300,activeComplete:true},{slug:"b",messages:100,state:"connected",observedSeconds:300,ratePerMinute:50,activeUsers:30,activeSeconds:300,activeComplete:true},{slug:"c",messages:99,state:"recent",observedSeconds:60,ratePerMinute:99,activeUsers:99,activeSeconds:300,activeComplete:true}];
const scores=momentumScores(rows,chat);
assert.equal(scores[0].slug,"b");assert.equal(scores[0].rank,1);
assert.equal(scores[1].slug,"a");assert.equal(scores[1].chatKnown,true);
assert.equal(scores.find(r=>r.slug==="c").rank,null);assert.equal(scores.find(r=>r.slug==="d").chatKnown,false);
assert.ok(scores.every(r=>r.score>=0&&r.score<=100));
assert.equal(momentumScores(rows,[]).every(r=>r.rank===null),true);
const time="2026-11-25T00:00:00Z",url="https://images.kick.com/frame.jpg?width=320";
const next=refreshedRankingThumbnail(url,time);assert.equal(new URL(next).searchParams.get("width"),"320");assert.equal(new URL(next).searchParams.get("_klmr_frame"),String(Date.parse(time)));
assert.equal(refreshedRankingThumbnail("https://images.kick.com/frame.jpg?X-Amz-Signature=abc",time),"https://images.kick.com/frame.jpg?X-Amz-Signature=abc");
assert.equal(refreshedRankingThumbnail("https://evil.example/frame.jpg",time),null);
console.log("総合勢い：重み・観測不足・0件の区別・サムネイル再取得・署名保護");

assert.deepEqual(MOMENTUM_WEIGHTS,{viewers:40,growth:25,chat:20,active:15});
assert.equal(Object.values(MOMENTUM_WEIGHTS).reduce((a,b)=>a+b,0),100);
assert.equal(scores[1].activeKnown,true);
assert.equal(scores.find(r=>r.slug==="c").activeKnown,false);
const equalRows=[{slug:"x",rank:1,viewers:100,viewerChange:10},{slug:"y",rank:2,viewers:100,viewerChange:10}];
const equalChat=[{slug:"x",messages:20,state:"connected",observedSeconds:300,ratePerMinute:4,activeUsers:0,activeSeconds:300,activeComplete:true},{slug:"y",messages:20,state:"connected",observedSeconds:300,ratePerMinute:4,activeUsers:20,activeSeconds:300,activeComplete:true}];
const ranked=momentumScores(equalRows,equalChat);
assert.equal(ranked[0].slug,"y");assert.equal(ranked[0].score,100);assert.equal(ranked[1].score,85);
for(const patch of [{activeComplete:false},{activeSeconds:299},{activeUsers:null},{activeUsers:-1},{activeUsers:NaN},{state:"recent"}]){
 const result=momentumScores(equalRows,[{...equalChat[0],...patch},equalChat[1]]);
 assert.equal(result.find(r=>r.slug==="x").rank,null);assert.equal(result.find(r=>r.slug==="x").activeKnown,false);
}
assert.equal(momentumScores(equalRows,equalChat.map(({activeUsers,activeSeconds,activeComplete,...c})=>c)).every(r=>r.rank===null),true);
console.log("4指標：配点、アクティブ人数の加点、0人、未観測・暫定の区別");

const adaptive=momentumScores(equalRows,equalChat,{viewers:20,growth:20,chat:20,active:40});
assert.equal(adaptive[0].score,100);assert.equal(adaptive[1].score,60);
assert.equal(adaptive[0].rank,1);
