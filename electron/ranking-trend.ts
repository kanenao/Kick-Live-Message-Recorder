import type {RankFrame,RankingMode} from "./ranking-movement";
export type RankTrendPoint={at:number;rank:number|null;start:string};
export type RankTrendFrames=Partial<Record<RankingMode,RankFrame[]>>;
const LIMIT=60;
export function appendTrendFrame(old:RankTrendFrames,frame:RankFrame,modes:readonly RankingMode[]):RankTrendFrames{
 let next=old;
 for(const mode of modes){
  const list=old[mode]??[],at=Date.parse(frame.at),last=list.at(-1);
  if(!Number.isFinite(at)||last&&Date.parse(last.at)>=at)continue;
  if(next===old)next={...old};
  next[mode]=[...list,frame].slice(-LIMIT);
 }
 return next;
}
export function rankTrendPoints(frames:readonly RankFrame[],mode:RankingMode,slug:string,start:string|null):RankTrendPoint[]{
 if(!start||!Number.isFinite(Date.parse(start)))return [];
 const session=Math.floor(Date.parse(start)/1000);
 return frames.filter(f=>Math.floor(Date.parse(f.starts.get(slug)??"")/1000)===session)
  .map(f=>({at:Date.parse(f.at),rank:mode==="viewers"&&!f.complete?null:f.ranks[mode].get(slug)??null,start}))
  .filter(p=>Number.isFinite(p.at));
}
/** Higher positions are drawn higher; break lines for missing or widely separated observations. */
export function rankTrendSegments(points:readonly RankTrendPoint[],width=72,height=26,maxGap=30000):string[]{
 const valid=points.filter(p=>p.rank!==null&&Number.isInteger(p.rank)&&p.rank>0);
 if(valid.length<2)return [];
 const first=valid[0].at,last=valid.at(-1)!.at;
 if(last<=first)return [];
 const min=Math.min(...valid.map(p=>p.rank!)),max=Math.max(...valid.map(p=>p.rank!));
 const result:string[]=[];let segment:string[]=[],previous:number|null=null;
 const flush=()=>{if(segment.length>=2)result.push(segment.join(" "));segment=[];};
 for(const p of points){
  if(p.rank===null||!Number.isInteger(p.rank)||p.rank<=0){flush();previous=null;continue;}
  if(previous!==null&&(p.at<=previous||p.at-previous>maxGap))flush();
  const x=3+(p.at-first)/(last-first)*(width-6),y=3+(max===min?(height-6)/2:(p.rank-min)/(max-min)*(height-6));
  segment.push(x.toFixed(2)+","+y.toFixed(2));previous=p.at;
 }
 flush();return result;
}
