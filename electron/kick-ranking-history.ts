import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,statSync,unlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {RankingScope,RankingSnapshot} from "./kick-ranking";
const DAY=86400000,BUCKET=300000,KEEP=7*DAY,MAX_ROWS=100;
type Point={slug:string;name:string;viewers:number;rank:number|null};
type Sample={at:number;complete:boolean;rows:Point[]};
export type RankingHistory={scope:RankingScope;hours:24|168;samples:number;firstAt:number|null;lastAt:number|null;leaders:Array<{slug:string;name:string;peakViewers:number;bestRank:number|null;samples:number}>;points:Array<{at:number;viewers:number;rank:number|null}>};
function validPoint(x:unknown):x is Point{
  if(!x||typeof x!=="object")return false;
  const p=x as Point;
  return typeof p.slug==="string"&&/^[a-z0-9_-]{1,40}$/.test(p.slug)&&typeof p.name==="string"&&p.name.length<=100&&Number.isSafeInteger(p.viewers)&&p.viewers>=0&&(p.rank===null||(Number.isSafeInteger(p.rank)&&p.rank>0));
}
function dayKey(ms:number):string{return new Date(ms).toISOString().slice(0,10);}
export class KickRankingHistory {
  constructor(private readonly root:string){}
  private file(scope:RankingScope,day:string):string{return join(this.root,scope+"-"+day+".json");}
  private read(scope:RankingScope,day:string):Sample[]{
    try{
      const path=this.file(scope,day);if(!existsSync(path)||statSync(path).size>5000000)return [];
      const data:unknown=JSON.parse(readFileSync(path,"utf8"));if(!Array.isArray(data))return [];
      return data.slice(0,288).filter(s=>s&&Number.isSafeInteger(s.at)&&s.at>=0&&dayKey(s.at)===day&&typeof s.complete==="boolean"&&Array.isArray(s.rows)).map(s=>({at:s.at,complete:s.complete,rows:s.rows.slice(0,MAX_ROWS).filter(validPoint).map((row:Point)=>({...row,rank:s.complete?row.rank:null}))}));
    }catch{return [];}
  }
  save(snapshot:RankingSnapshot,now=Date.now()):void{
    const at=Date.parse(snapshot.fetchedAt);if(!Number.isFinite(at)||at>now+60000||at<now-KEEP)return;
    mkdirSync(this.root,{recursive:true});
    const day=dayKey(at),path=this.file(snapshot.scope,day),old=this.read(snapshot.scope,day);
    if(old.some(s=>Math.floor(s.at/BUCKET)===Math.floor(at/BUCKET)))return;
    const rows=snapshot.entries.slice(0,MAX_ROWS).map(row=>({slug:row.slug,name:row.name,viewers:row.viewers,rank:snapshot.complete?row.rank:null})).filter(validPoint);
    const next=[...old,{at,complete:snapshot.complete,rows}].sort((a,b)=>a.at-b.at).slice(-288);
    const temp=path+".tmp";try{writeFileSync(temp,JSON.stringify(next),{encoding:"utf8",mode:0o600});renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
    for(const name of readdirSync(this.root)){const m=/^(ja|all)-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);if(m&&m[2]<dayKey(now-KEEP))try{unlinkSync(join(this.root,name));}catch{/* retain if locked */}}
  }
  query(scope:RankingScope,hours:24|168,slug:string|null,now=Date.now()):RankingHistory{
    const start=now-hours*3600000, samples:Sample[]=[];
    for(let d=Date.parse(dayKey(start));d<=now;d+=DAY) samples.push(...this.read(scope,dayKey(d)).filter(s=>s.at>=start&&s.at<=now));
    samples.sort((a,b)=>a.at-b.at);
    const stats=new Map<string,RankingHistory["leaders"][number]>(),points:RankingHistory["points"]=[];
    for(const s of samples)for(const p of s.rows){
      let row=stats.get(p.slug);
      if(!row){row={slug:p.slug,name:p.name,peakViewers:p.viewers,bestRank:p.rank,samples:0};stats.set(p.slug,row);}
      row.name=p.name;row.peakViewers=Math.max(row.peakViewers,p.viewers);row.samples++;
      if(p.rank!==null)row.bestRank=row.bestRank===null?p.rank:Math.min(row.bestRank,p.rank);
      if(p.slug===slug)points.push({at:s.at,viewers:p.viewers,rank:p.rank});
    }
    return {scope,hours,samples:samples.length,firstAt:samples[0]?.at??null,lastAt:samples.at(-1)?.at??null,leaders:[...stats.values()].sort((a,b)=>b.peakViewers-a.peakViewers||a.slug.localeCompare(b.slug)).slice(0,100),points};
  }
}
