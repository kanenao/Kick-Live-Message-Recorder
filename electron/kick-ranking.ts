export type RankingScope = "ja" | "all";
export type RankingEntry = {slug:string;name:string;title:string;category:string;language:string;viewers:number;startedAt:string|null;thumbnail:string|null;avatar:string|null;rank:number;rankChange:number|null;viewerChange:number|null};
export type RankingSnapshot = {scope:RankingScope;entries:RankingEntry[];fetchedAt:string;complete:boolean;pages:number;total:number;excluded:number;trackedEntries?:RankingEntry[]};
type RawEntry = Omit<RankingEntry,"rank"|"rankChange"|"viewerChange">;
const rec=(x:unknown):Record<string,unknown>=>x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
const str=(x:unknown,max=500):string=>typeof x==="string"?x.trim().slice(0,max):"";
function image(x:unknown):string|null{
  try{const u=new URL(str(x,2000));return u.protocol==="https:" && !u.username && !u.password && !u.port && (u.hostname==="kick.com"||u.hostname.endsWith(".kick.com"))?u.href:null;}catch{return null;}
}
export function parseRankingPage(payload:unknown):{entries:RawEntry[];cursor:string|null;excluded:number}{
  const p=rec(payload);
  if(!Array.isArray(p.data))throw Error("Kickランキングの応答形式が不正です。");
  const entries:RawEntry[]=[];let excluded=0;
  for(const raw of p.data){
    const row=rec(raw),channel=rec(row.channel),user=rec(row.broadcaster_user);
    const slug=str(channel.slug,1000).toLowerCase(),viewers=row.viewer_count;
    if(!/^[a-z0-9_-]{1,40}$/.test(slug)||typeof viewers!=="number"||!Number.isSafeInteger(viewers)||viewers<0){excluded++;continue;}
    const started=str(row.started_at,80);
    entries.push({slug,name:str(user.username,100)||slug,title:str(row.title,300)||"タイトルなし",category:str(rec(row.category).name,100)||"未分類",language:str(row.language_code,35),viewers,startedAt:Number.isFinite(Date.parse(started))?new Date(started).toISOString():null,thumbnail:image(row.thumbnail),avatar:image(user.profile_picture)});
  }
  const rawCursor=rec(p.pagination).next_cursor;
  if(rawCursor!==undefined&&rawCursor!==null&&(typeof rawCursor!=="string"||rawCursor.length>2048))throw Error("ランキングのページ情報が不正です。");
  return {entries,cursor:typeof rawCursor==="string"&&rawCursor?rawCursor:null,excluded};
}
export function rankEntries(rows:RawEntry[],previous?:RankingSnapshot):RankingEntry[]{
  const unique=new Map<string,RawEntry>();
  for(const row of rows){const existing=unique.get(row.slug);if(!existing||row.viewers>existing.viewers)unique.set(row.slug,row);}
  const old=new Map([...(previous?.entries??[]),...(previous?.trackedEntries??[])].map(row=>[row.slug,row]));
  return [...unique.values()].sort((a,b)=>b.viewers-a.viewers||a.slug.localeCompare(b.slug)).map((row,index)=>{
    const before=old.get(row.slug),same=before&&row.startedAt!==null&&before.startedAt===row.startedAt;
    return {...row,rank:index+1,rankChange:same&&previous?.complete?before.rank-(index+1):null,viewerChange:same?row.viewers-before.viewers:null};
  });
}
export async function collectRanking(scope:RankingScope,fetchPage:(url:URL)=>Promise<unknown>,previous?:RankingSnapshot,maxPages=20,trackedSlugs:readonly string[]=[]):Promise<RankingSnapshot>{
  const entries:RawEntry[]=[];const seen=new Set<string>();let cursor:string|null=null,pages=0,complete=false,excluded=0;
  do{
    const url=new URL("https://api.kick.com/public/v2/livestreams");url.searchParams.set("limit","1000");
    if(scope==="ja")url.searchParams.set("language_code","ja");
    if(cursor)url.searchParams.set("cursor",cursor);
    const page=parseRankingPage(await fetchPage(url));pages++;excluded+=page.excluded;
    if(scope==="ja")excluded+=page.entries.filter(row=>!row.language).length;
    entries.push(...page.entries.filter(row=>scope==="all"||/^ja(?:-|$)/i.test(row.language)));
    cursor=page.cursor;
    if(!cursor){complete=true;break;}
    if(seen.has(cursor))break;seen.add(cursor);
  }while(pages<maxPages);
  const ranked=rankEntries(entries,previous?.scope===scope?previous:undefined);
  if(!complete||excluded)for(const row of ranked)row.rankChange=null;
  const tracked=new Set(trackedSlugs.map(s=>s.toLowerCase()));
  return {scope,entries:ranked.slice(0,500),trackedEntries:ranked.filter(row=>tracked.has(row.slug)),fetchedAt:new Date().toISOString(),complete:complete&&excluded===0,pages,total:ranked.length,excluded};
}

export function registeredRank(snapshot:RankingSnapshot|null,slug:string,startedAt:string|null,now=Date.now()):string{
  if(!snapshot||now-Date.parse(snapshot.fetchedAt)>90000)return "更新待ち";
  const row=[...(snapshot.trackedEntries??[]),...snapshot.entries].find(x=>x.slug===slug.toLowerCase());
  if(!row)return snapshot.complete?"対象外・未掲載":"取得範囲外";
  if(!startedAt||!row.startedAt||Math.abs(Date.parse(startedAt)-Date.parse(row.startedAt))>=1000)return "新しい配信を確認中";
  return (snapshot.complete?"":"暫定 ")+row.rank.toLocaleString("ja-JP")+"位";
}
