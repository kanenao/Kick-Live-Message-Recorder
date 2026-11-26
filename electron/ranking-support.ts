import {SUPPORT_WINDOW_SECONDS} from "./ranking-support-policy";
import {createHash} from "node:crypto";
export type SupportKind="kicks"|"giftSubs";
export type SupportEvent={kind:SupportKind;amount:number;id:string|null};
export type SupportObservation={slug:string;startedAt:string|null;kicks:number|null;giftSubs:number|null;kicksSeconds:number;giftSubsSeconds:number};
const rec=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const positive=(v:unknown):number|null=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0&&v<=100000000?v:null;
const id=(v:unknown)=>typeof v==="string"&&v.length>0&&v.length<=200?v:typeof v==="number"&&Number.isSafeInteger(v)?String(v):null;
export function parseSupportEvent(event:unknown,payload:unknown,kind:SupportKind):SupportEvent|null{
 if(typeof event!=="string")return null;
 const name=event.replace(/^App\\Events\\/,""),p=rec(payload);
 if(kind==="kicks"&&name==="KicksGifted"){
  const amount=positive(rec(p.gift).amount),key=id(p.gift_transaction_id);
  return amount&&key?{kind,amount,id:key}:null;
 }
 if(kind==="giftSubs"&&name==="GiftedSubscriptionsEvent"){
  // Count recipients in this delivery, not cumulative leaderboard or batch totals.
  const recipients=p.gifted_usernames;
  if(!Array.isArray(recipients)||!recipients.length||recipients.length>10000||!recipients.every(v=>typeof v==="string"&&v.length>0&&v.length<=200))return null;
  const amount=new Set(recipients).size;
  const key=id(p.correlation_id)??id(p.id);
  // Some chunk deliveries have no event ID. Do not merge different purchases by name/time.
  return {kind,amount,id:key?key+":"+createHash("sha256").update(JSON.stringify([...new Set(recipients)].sort())).digest("hex"):null};
 }
 return null;
}
const WINDOW=SUPPORT_WINDOW_SECONDS*1000;
export class RankingSupportActivity{
 private readonly events=new Map<string,{slug:string;kind:SupportKind;at:number;amount:number}[]>();
 private readonly seen=new Map<string,number>();
 private lastPrune=-Infinity;
 add(slug:string,event:SupportEvent,now=Date.now()){
  if(!Number.isFinite(now)||!positive(event.amount)||!/^[a-z0-9_-]{1,40}$/.test(slug))return;
  this.prune(now);
  if(event.id){const key=slug+"|"+event.kind+"|"+event.id;if(this.seen.has(key))return;this.seen.set(key,now);if(this.seen.size>20000)this.seen.delete(this.seen.keys().next().value!);}
  const key=slug+"|"+event.kind,rows=this.events.get(key)??[];
  if(rows.length>=20000||(!this.events.has(key)&&this.events.size>=200))return;
  rows.push({slug,kind:event.kind,at:now,amount:event.amount});this.events.set(key,rows);
 }
 measure(slug:string,kind:SupportKind,since:number|null,startedAt:string|null,now=Date.now()):{amount:number|null;seconds:number}{
  const start=Date.parse(startedAt??"");
  if(since===null||!Number.isFinite(since)||!Number.isFinite(start)||!Number.isFinite(now))return {amount:null,seconds:0};
  this.prune(now);
  const from=Math.max(now-WINDOW,since,start),seconds=Math.max(0,Math.floor((now-from)/1000));
  if(from>now)return {amount:null,seconds:0};
  const rows=this.events.get(slug+"|"+kind)??[];
  return {amount:rows.filter(r=>r.at>=from&&r.at<=now).reduce((sum,r)=>sum+r.amount,0),seconds};
 }
 private prune(now:number){
  if(now-this.lastPrune<5000)return;this.lastPrune=now;
  for(const [key,rows] of this.events){const keep=rows.filter(r=>r.at>=now-WINDOW&&r.at<=now);if(keep.length)this.events.set(key,keep);else this.events.delete(key);}
  for(const [key,at] of this.seen)if(at<now-300000)this.seen.delete(key);
 }
}
