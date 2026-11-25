import type {RankingEntry} from "./kick-ranking";
export type MomentumChat={slug:string;messages:number;state:string;observedSeconds?:number;ratePerMinute?:number|null;activeUsers?:number|null;activeSeconds?:number;activeComplete?:boolean};
export type MomentumScore={slug:string;score:number;complete:boolean;growthKnown:boolean;chatKnown:boolean;activeKnown:boolean;rank:number|null};
/** Scope-wide log normalization, not dependent on search, category, page, or sort.
 * Missing observations are not interpreted as zero. Partial scores are explicitly
 * labelled and never ranked against four-metric scores. */
export const MOMENTUM_WEIGHTS={viewers:40,growth:25,chat:20,active:15} as const;
export function momentumScores(rows:readonly RankingEntry[],chat:readonly MomentumChat[]):MomentumScore[]{
  const observed=new Map(chat.filter(c=>c.state==="connected"&&(c.observedSeconds??0)>=60&&typeof c.ratePerMinute==="number"&&Number.isFinite(c.ratePerMinute)&&c.ratePerMinute>=0).map(c=>[c.slug,c.ratePerMinute!]));
  const active=new Map(chat.filter(c=>c.state==="connected"&&c.activeComplete===true&&(c.activeSeconds??0)>=300&&typeof c.activeUsers==="number"&&Number.isSafeInteger(c.activeUsers)&&c.activeUsers>=0).map(c=>[c.slug,c.activeUsers!]));
  const positive=(n:number)=>Number.isFinite(n)?Math.max(0,n):0;
  const maxView=Math.max(0,...rows.map(r=>positive(r.viewers)));
  const maxGrowth=Math.max(0,...rows.map(r=>positive(r.viewerChange??0)));
  const maxChat=Math.max(0,...rows.map(r=>observed.get(r.slug)??0));
  const maxActive=Math.max(0,...rows.map(r=>active.get(r.slug)??0));
  const w=MOMENTUM_WEIGHTS;
  const norm=(value:number,max:number)=>max>0?Math.min(1,Math.log1p(positive(value))/Math.log1p(max)):0;
  const result=rows.map(r=>{
    const growthKnown=r.viewerChange!==null&&Number.isFinite(r.viewerChange);
    const chatKnown=observed.has(r.slug);
    const activeKnown=active.has(r.slug);
    const weight=w.viewers+(growthKnown?w.growth:0)+(chatKnown?w.chat:0)+(activeKnown?w.active:0);
    const sum=w.viewers*norm(r.viewers,maxView)+(growthKnown?w.growth*norm(r.viewerChange!,maxGrowth):0)+(chatKnown?w.chat*norm(observed.get(r.slug)!,maxChat):0)+(activeKnown?w.active*norm(active.get(r.slug)!,maxActive):0);
    return {slug:r.slug,score:Math.round(1000*sum/weight)/10,complete:growthKnown&&chatKnown&&activeKnown,growthKnown,chatKnown,activeKnown,rank:null as number|null};
  });
  const original=new Map(rows.map(r=>[r.slug,r.rank]));
  result.sort((a,b)=>Number(b.complete)-Number(a.complete)||b.score-a.score||(original.get(a.slug)??0)-(original.get(b.slug)??0)||a.slug.localeCompare(b.slug));
  let rank=0;for(const r of result)if(r.complete)r.rank=++rank;
  return result;
}
/** Revalidate only known unsigned Kick image URLs once per actual snapshot.
 * Preserve signed/tokenized URLs, query params, and original image on CDN failure. */
export function refreshedRankingThumbnail(url:string|null,at:string|undefined):string|null{
  if(!url)return null;
  try{
    const u=new URL(url);
    if(u.protocol!=="https:"||u.username||u.password||u.port||!(u.hostname==="kick.com"||u.hostname.endsWith(".kick.com")))return null;
    const stamp=Date.parse(at??"");
    if(!Number.isFinite(stamp))return u.href;
    if([...u.searchParams.keys()].some(k=>/signature|token|auth|policy|expires|credential|^sig$|^key-pair-id$|^x-amz-|^x-goog-/i.test(k)))return u.href;
    u.searchParams.set("_klmr_frame",String(stamp));
    return u.href;
  }catch{return null;}
}
