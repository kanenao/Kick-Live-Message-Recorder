import type {RankingEntry} from "./kick-ranking";
export type MomentumChat={slug:string;messages:number;state:string;observedSeconds?:number;ratePerMinute?:number|null};
export type MomentumScore={slug:string;score:number;complete:boolean;growthKnown:boolean;chatKnown:boolean;rank:number|null};
/** Scope-wide log normalization, not dependent on search, category, page, or sort.
 * Missing observations are not interpreted as zero. Partial scores are explicitly
 * labelled and never ranked against three-metric scores. */
export function momentumScores(rows:readonly RankingEntry[],chat:readonly MomentumChat[]):MomentumScore[]{
  const observed=new Map(chat.filter(c=>c.state==="connected"&&(c.observedSeconds??0)>=60&&typeof c.ratePerMinute==="number"&&Number.isFinite(c.ratePerMinute)&&c.ratePerMinute>=0).map(c=>[c.slug,c.ratePerMinute!]));
  const positive=(n:number)=>Number.isFinite(n)?Math.max(0,n):0;
  const maxView=Math.max(0,...rows.map(r=>positive(r.viewers)));
  const maxGrowth=Math.max(0,...rows.map(r=>positive(r.viewerChange??0)));
  const maxChat=Math.max(0,...rows.map(r=>observed.get(r.slug)??0));
  const norm=(value:number,max:number)=>max>0?Math.min(1,Math.log1p(positive(value))/Math.log1p(max)):0;
  const result=rows.map(r=>{
    const growthKnown=r.viewerChange!==null&&Number.isFinite(r.viewerChange);
    const chatKnown=observed.has(r.slug);
    const weight=50+(growthKnown?30:0)+(chatKnown?20:0);
    const sum=50*norm(r.viewers,maxView)+(growthKnown?30*norm(r.viewerChange!,maxGrowth):0)+(chatKnown?20*norm(observed.get(r.slug)!,maxChat):0);
    return {slug:r.slug,score:Math.round(1000*sum/weight)/10,complete:growthKnown&&chatKnown,growthKnown,chatKnown,rank:null as number|null};
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
