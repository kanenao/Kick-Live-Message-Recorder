import type {SupportObservation} from "./ranking-support";
import type {RankingEntry,RankingSnapshot,RankingScope} from "./kick-ranking";
import {momentumScores,type MomentumChat,type MomentumWeights} from "./ranking-momentum";
export type RankingMode="viewers"|"growth"|"chat"|"active"|"momentum"|"kicks"|"giftSubs";
export type RankFrame={scope:RankingScope;at:string;full:boolean;complete:boolean;starts:Map<string,string|null>;orders:Record<RankingMode,string[]>;ranks:Record<RankingMode,Map<string,number>>};
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
export function rankingFrame(snapshot:RankingSnapshot,chat:readonly MomentumChat[]=[],observedAt=snapshot.fetchedAt,weights?:MomentumWeights,support:readonly SupportObservation[]=[]):RankFrame{
 const rows=snapshot.entries,byChat=new Map(chat.map(c=>[c.slug,c])),bySupport=new Map(support.map(c=>[c.slug,c]));
 const measures=(mode:RankingMode,row:RankingEntry):number|null=>{
  const c=byChat.get(row.slug);
  if(mode==="kicks"||mode==="giftSubs"){const m=bySupport.get(row.slug);if(!m||!row.startedAt||m.startedAt!==row.startedAt)return null;const v=m[mode],seconds=mode==="kicks"?m.kicksSeconds:m.giftSubsSeconds;return seconds>=60&&finite(v)&&v>0?v:null;}
  if(mode==="growth")return finite(row.viewerChange)?row.viewerChange:null;
  if(mode==="chat")return c?.state==="connected"&&(c.observedSeconds??0)>=60&&finite(c.ratePerMinute)&&c.ratePerMinute>=0?c.ratePerMinute:null;
  if(mode==="active")return c?.state==="connected"&&c.activeComplete===true&&(c.activeSeconds??0)>=300&&finite(c.activeUsers)&&c.activeUsers>=0?c.activeUsers:null;
  return null;
 };
 const orders={} as RankFrame["orders"],ranks={} as RankFrame["ranks"];
 const assign=(mode:RankingMode,sorted:RankingEntry[],eligible:(row:RankingEntry)=>boolean)=>{
  orders[mode]=sorted.map(r=>r.slug);ranks[mode]=new Map();let index=0;
  for(const r of sorted)if(eligible(r))ranks[mode].set(r.slug,mode==="viewers"?r.rank:++index);
 };
 assign("viewers",[...rows].sort((a,b)=>a.rank-b.rank),()=>true);
 for(const mode of ["growth","chat","active","kicks","giftSubs"] as const){
  const sorted=[...rows].sort((a,b)=>{
   const x=measures(mode,a),y=measures(mode,b);
   if(x!==null&&y!==null)return y-x||a.rank-b.rank;
   if(x!==null)return -1;if(y!==null)return 1;
   // Keep observed provisional users ahead of wholly unobserved rows.
   if(mode==="active"){const ax=byChat.get(a.slug)?.activeUsers,ay=byChat.get(b.slug)?.activeUsers;return (ay??-1)-(ax??-1)||a.rank-b.rank;}
   return a.rank-b.rank;
  });
  assign(mode,sorted,r=>measures(mode,r)!==null);
 }
 const scores=momentumScores(rows,chat,weights),byRow=new Map(rows.map(r=>[r.slug,r]));
 orders.momentum=scores.map(s=>s.slug);
 ranks.momentum=new Map(scores.filter(s=>s.rank!==null&&byRow.has(s.slug)).map(s=>[s.slug,s.rank!]));
 return {scope:snapshot.scope,at:observedAt,complete:snapshot.complete,full:snapshot.complete&&snapshot.total<=rows.length,starts:new Map(rows.map(r=>[r.slug,r.startedAt])),orders,ranks};
}
export type RankMovement={kind:"up"|"down"|"keep"|"new"|"unknown";delta:number;previous:number|null};
const unknown:RankMovement={kind:"unknown",delta:0,previous:null};
const second=(s:string|null|undefined)=>s?Math.floor(Date.parse(s)/1000):NaN;
export function rankMovement(current:RankFrame,previous:RankFrame|null|undefined,mode:RankingMode,row:RankingEntry):RankMovement{
 const rank=current.ranks[mode].get(row.slug),start=second(row.startedAt);
 if(rank===undefined||!Number.isFinite(start))return unknown;
 // Viewer-rank changes are supplied by the backend, including ranks outside the display limit.
 if(mode==="viewers"&&current.complete&&finite(row.rankChange)&&Number.isSafeInteger(row.rankChange)&&rank+row.rankChange>0){
  const d=row.rankChange;return {kind:d>0?"up":d<0?"down":"keep",delta:Math.abs(d),previous:rank+d};
 }
 if(!previous||previous.scope!==current.scope||!Number.isFinite(Date.parse(previous.at))||!Number.isFinite(Date.parse(current.at))||Date.parse(previous.at)>=Date.parse(current.at))return unknown;
 if(mode==="viewers"&&(!current.complete||!previous.complete))return unknown;
 const before=previous.starts.get(row.slug),old=previous.ranks[mode].get(row.slug);
 if(!previous.starts.has(row.slug))return previous.full?{kind:"new",delta:0,previous:null}:unknown;
 if(!Number.isFinite(second(before)))return unknown;
 if(second(before)!==start)return {kind:"new",delta:0,previous:null};
 if(old===undefined)return unknown;
 const d=old-rank;return {kind:d>0?"up":d<0?"down":"keep",delta:Math.abs(d),previous:old};
}

/** A chat poll is an independent observation. Never promote a duplicate tick,
 * and never compare ranks across an extended observation gap or scope change. */
export type RankFrameHistory={current:RankFrame;previous:RankFrame|null};
export function advanceRankFrame(history:RankFrameHistory|undefined,next:RankFrame,maxGapMs=30000):RankFrameHistory{
 const at=Date.parse(next.at),before=Date.parse(history?.current.at??"");
 if(!history||history.current.scope!==next.scope||!Number.isFinite(at)||!Number.isFinite(before))return {current:next,previous:null};
 if(at<=before)return history;
 return {current:next,previous:at-before<=maxGapMs?history.current:null};
}
