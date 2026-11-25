import type {RankingSnapshot} from "./kick-ranking";
export const MAX_RANKING_CHAT_CHANNELS=30;
/** Selected preview, registered LIVE entries and top-ranked entries, in that order. */
export function rankingChatTargets(snapshot:RankingSnapshot,selected:string|null,normal:readonly string[],limit=MAX_RANKING_CHAT_CHANNELS):string[]{
 const rows=[...snapshot.entries,...(snapshot.trackedEntries??[])];
 const known=new Set(rows.map(r=>r.slug));
 const excluded=new Set(normal.map(s=>s.toLowerCase()));
 const priority=[...(selected&&known.has(selected)?[selected]:[]),...(snapshot.trackedEntries??[]).map(r=>r.slug),...snapshot.entries.map(r=>r.slug)];
 return [...new Set(priority)].filter(s=>/^[a-z0-9_]{1,25}$/.test(s)&&!excluded.has(s)).slice(0,Math.min(MAX_RANKING_CHAT_CHANNELS,Math.max(0,limit))).sort();
}
