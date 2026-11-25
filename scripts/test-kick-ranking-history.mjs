import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {KickRankingHistory} from "../electron/kick-ranking-history.ts";
const root=mkdtempSync(join(tmpdir(),"kick-ranking-history-"));
try{
 const now=Date.parse("2026-11-25T12:00:00Z");
 const snap=(at,viewers,complete=true,scope="ja")=>({scope,fetchedAt:new Date(at).toISOString(),complete,entries:[{slug:"sample",name:"Sample",viewers,rank:1}]});
 const db=new KickRankingHistory(root);
 db.save(snap(now-600000,10),now);db.save(snap(now-599000,999),now);db.save(snap(now-300000,20,false),now);db.save(snap(now,100,true,"all"),now);
 db.save(snap(now-2*86400000,30),now);
 const restored=new KickRankingHistory(root);
 const day=restored.query("ja",24,"sample",now);
 assert.equal(day.samples,2);assert.equal(day.leaders[0].peakViewers,20);assert.equal(day.leaders[0].bestRank,1);
 assert.deepEqual(day.points.map(p=>p.rank),[1,null]);
 assert.equal(restored.query("ja",168,"sample",now).leaders[0].peakViewers,30);
 assert.equal(restored.query("all",24,null,now).leaders[0].peakViewers,100);
 assert.equal(restored.query("ja",24,"unknown",now).points.length,0);
}finally{rmSync(root,{recursive:true,force:true});}
console.log("ランキング履歴：永続化・重複除外・期間集計・暫定順位除外・範囲分離テスト成功");
