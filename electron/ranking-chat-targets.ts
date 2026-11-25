import type {RankingSnapshot} from "./kick-ranking";
import {momentumScores,type MomentumChat} from "./ranking-momentum";
export const MAX_RANKING_CHAT_CHANNELS=30;
/** Guarantee top ten coverage first, then selected/registered LIVE and growth/
 * measured momentum candidates. Keep within the existing extra connection cap. */
export function rankingChatTargets(snapshot:RankingSnapshot,selected:string|null,normal:readonly string[],limit=MAX_RANKING_CHAT_CHANNELS,chat:readonly MomentumChat[]=[]):string[]{
 const rows=[...snapshot.entries,...(snapshot.trackedEntries??[])];
 const known=new Set(rows.map(r=>r.slug));
 const excluded=new Set(normal.map(s=>s.toLowerCase()));
 const cap=Math.min(MAX_RANKING_CHAT_CHANNELS,Math.max(0,limit));
 const result=new Set<string>();
 const add=(s:string)=>{if(result.size<cap&&known.has(s)&&/^[a-z0-9_]{1,25}$/.test(s)&&!excluded.has(s))result.add(s);};
 snapshot.entries.slice(0,10).forEach(r=>add(r.slug));
 if(selected)add(selected);
 // Reserve capacity for growth and momentum discoveries even with many registrations.
 const tracked=(snapshot.trackedEntries??[]).map(r=>r.slug);
 tracked.slice(0,Math.max(0,cap-result.size-8)).forEach(add);
 const growth=[...snapshot.entries].filter(r=>typeof r.viewerChange==="number"&&r.viewerChange>0).sort((a,b)=>b.viewerChange!-a.viewerChange!||a.rank-b.rank);
 growth.filter(r=>!result.has(r.slug)&&!excluded.has(r.slug)).slice(0,5).forEach(r=>add(r.slug));
 const combined=momentumScores(snapshot.entries,chat).filter(r=>r.complete);
 combined.filter(r=>!result.has(r.slug)&&!excluded.has(r.slug)).slice(0,3).forEach(r=>add(r.slug));
 tracked.forEach(add);
 snapshot.entries.forEach(r=>add(r.slug));
 return [...result].sort();
}
