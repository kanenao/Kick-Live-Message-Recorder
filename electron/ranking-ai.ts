import type {RankingSnapshot,RankingScope} from "./kick-ranking";
import type {MomentumChat,MomentumWeights} from "./ranking-momentum";
export type RankingAiStatus={weights:MomentumWeights|null;at:string|null;state:"waiting"|"running"|"ready"|"unavailable";message:string};
export function parseAiWeights(value:unknown):MomentumWeights|null{
 if(!value||typeof value!=="object")return null;
 const v=value as Record<string,unknown>,keys=["viewers","growth","chat","active"] as const;
 if(!keys.every(k=>typeof v[k]==="number"&&Number.isInteger(v[k])&&(v[k] as number)>=10&&(v[k] as number)<=50))return null;
 const w={viewers:v.viewers as number,growth:v.growth as number,chat:v.chat as number,active:v.active as number};
 return Object.values(w).reduce((a,b)=>a+b,0)===100?w:null;
}
export function aiRankingInput(snapshot:RankingSnapshot,chat:readonly MomentumChat[]){
 const bySlug=new Map(chat.map(c=>[c.slug,c]));
 return snapshot.entries.flatMap(r=>{
  const c=bySlug.get(r.slug);
  if(!c||c.state!=="connected"||(c.observedSeconds??0)<60||(c.activeMinuteSeconds??0)<60||
   !Number.isFinite(r.viewerChange)||!Number.isFinite(c.ratePerMinute)||!Number.isSafeInteger(c.activeMinuteUsers)||
   (c.ratePerMinute??-1)<0||(c.activeMinuteUsers??-1)<0)return [];
  return [[r.viewers,r.viewerChange,c.ratePerMinute,c.activeMinuteUsers]];
 }).slice(0,30);
}
const empty=(message:string):RankingAiStatus=>({weights:null,at:null,state:"waiting",message});
/** Local-only Ollama requests, bounded and non-blocking for the ten-second ranking. */
export class RankingAiWeights{
 private readonly states=new Map<RankingScope,{key:string;status:RankingAiStatus;last:number}>();
 private busy=false;
 private lastRequest=-Infinity;
 poll(scope:RankingScope,snapshot:RankingSnapshot|null,chat:readonly MomentumChat[],model:string,now=Date.now()):RankingAiStatus{
  const key=model;
  let entry=this.states.get(scope);
  if(!entry||entry.key!==key){entry={key,status:empty("AI採点準備中"),last:-Infinity};this.states.set(scope,entry);}
  if(entry.status.at&&now-Date.parse(entry.status.at)>300000)entry.status=empty("AI配点の有効期限切れ");
  if(!snapshot||now-Date.parse(snapshot.fetchedAt)>90000)return {...entry.status,weights:null,state:"waiting",message:"ランキング観測待ち・通常採点"};
  const input=aiRankingInput(snapshot,chat);
  if(input.length<3)return {...entry.status,weights:null,state:"waiting",message:"4指標の観測済み配信が3件未満・通常採点"};
  if(!/^[a-zA-Z0-9._:-]{1,100}$/.test(model))return {weights:null,at:null,state:"unavailable",message:"Ollamaモデル設定を確認"};
  if(!this.busy&&now-this.lastRequest>=120000&&now-entry.last>=120000){
   this.busy=true;this.lastRequest=now;entry.last=now;
   const target=entry;
   target.status={...target.status,state:"running",message:"Ollamaで配点を分析中"};
   void this.generate(model,input).then(weights=>{
    if(this.states.get(scope)!==target)return;
    target.status=weights?{weights,at:new Date().toISOString(),state:"ready",message:"OllamaによるAI配点"}:{weights:null,at:null,state:"unavailable",message:"AI配点を検証できません・通常採点"};
   }).catch(()=>{if(this.states.get(scope)===target)target.status={weights:null,at:null,state:"unavailable",message:"Ollama未接続・通常採点"};}).finally(()=>{this.busy=false;});
  }
  return entry.status;
 }
 private async generate(model:string,input:ReturnType<typeof aiRankingInput>):Promise<MomentumWeights|null>{
  const response=await fetch("http://127.0.0.1:11434/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(25000),body:JSON.stringify({model,stream:false,format:"json",options:{temperature:0,num_predict:120},prompt:"You are evaluating a livestream momentum ranking. Each anonymous row contains [concurrent viewers, viewer change since last snapshot, received chat per minute, unique active chat users in the last 60 seconds]. Choose fair relative integer weights for all four metrics based on the current distribution. Balance popularity, growth, chat intensity and participation; avoid overvaluing one noisy metric. Each weight must be 10 to 50, sum exactly 100. Return only JSON with keys viewers, growth, chat, active. Rows: "+JSON.stringify(input)})});
  if(!response.ok)return null;
  const data=await response.json() as {response?:unknown};
  if(typeof data.response!=="string"||data.response.length>2000)return null;
  try{return parseAiWeights(JSON.parse(data.response));}catch{return null;}
 }
}
