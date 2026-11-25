import type {RankingSnapshot,RankingScope} from "./kick-ranking";
export type LiveRankPeak={slug:string;startedAt:string;firstObservedAt:string;lastObservedAt:string;bestRank:number|null;bestPartialRank:number|null;peakViewers:number;samples:number};
const sameStart=(a:string,b:string)=>Math.floor(Date.parse(a)/1000)===Math.floor(Date.parse(b)/1000);
export class LiveRankingPeaks{
 private readonly scopes=new Map<RankingScope,Map<string,LiveRankPeak>>();
 observe(snapshot:RankingSnapshot):LiveRankPeak[]{
   const at=Date.parse(snapshot.fetchedAt);
   if(!Number.isFinite(at))return [];
   let rows=this.scopes.get(snapshot.scope);
   if(!rows){rows=new Map();this.scopes.set(snapshot.scope,rows);}
   for(const [slug,row] of rows)if(at-Date.parse(row.lastObservedAt)>48*3600000)rows.delete(slug);
   for(const row of snapshot.trackedEntries??[]){
     if(!row.startedAt||!Number.isFinite(Date.parse(row.startedAt)))continue;
     const old=rows.get(row.slug);
     if(old&&Date.parse(old.lastObservedAt)>=at)continue;
     const current=old&&sameStart(old.startedAt,row.startedAt)?old:{slug:row.slug,startedAt:row.startedAt,firstObservedAt:snapshot.fetchedAt,lastObservedAt:snapshot.fetchedAt,bestRank:null,bestPartialRank:null,peakViewers:0,samples:0};
     current.lastObservedAt=snapshot.fetchedAt;
     current.samples++;
     current.peakViewers=Math.max(current.peakViewers,row.viewers);
     if(snapshot.complete)current.bestRank=Math.min(current.bestRank??Infinity,row.rank);
     else current.bestPartialRank=Math.min(current.bestPartialRank??Infinity,row.rank);
     rows.set(row.slug,current);
   }
   while(rows.size>400){const oldest=[...rows.values()].sort((a,b)=>Date.parse(a.lastObservedAt)-Date.parse(b.lastObservedAt))[0];rows.delete(oldest.slug);}
   return [...rows.values()].map(row=>({...row}));
 }
}
