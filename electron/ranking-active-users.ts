import {createHmac,randomBytes} from "node:crypto";
const WINDOW=300000;
type Channel={users:Map<string,number>;incompleteAt:number};
export type ActiveObservation={activeUsers:number|null;activeSeconds:number;activeComplete:boolean};
/** Counts unique identifiable chat authors, never silent viewers. Ephemeral hashed IDs only. */
export class RankingActiveUsers{
 private readonly salt=randomBytes(32);
 private readonly channels=new Map<string,Channel>();
 private size=0;
 private lastPrune=-Infinity;
 constructor(private readonly maxTotal=100000,private readonly maxPerChannel=10000,private readonly maxChannels=400){}
 add(slug:string,userId:number|null|undefined,now=Date.now()):void{
   if(!/^[a-z0-9_-]{1,40}$/.test(slug)||!Number.isFinite(now))return;
   this.prune(now);
   let channel=this.channels.get(slug);
   if(!channel){if(this.channels.size>=this.maxChannels)return;channel={users:new Map(),incompleteAt:-Infinity};this.channels.set(slug,channel);}
   if(typeof userId!=="number"||!Number.isSafeInteger(userId)||userId<=0){channel.incompleteAt=Math.max(channel.incompleteAt,now);return;}
   const key=createHmac("sha256",this.salt).update(String(userId)).digest("base64url");
   const old=channel.users.get(key);
   if(old!==undefined){channel.users.set(key,Math.max(old,now));return;}
   if(this.size>=this.maxTotal||channel.users.size>=this.maxPerChannel){channel.incompleteAt=Math.max(channel.incompleteAt,now);return;}
   channel.users.set(key,now);this.size++;
 }
 measure(slug:string,connectedSince:number|null,startedAt:string|null,now=Date.now(),windowMs=WINDOW):ActiveObservation{
   const start=Date.parse(startedAt??"");
   if(connectedSince===null||!Number.isFinite(connectedSince)||!Number.isFinite(start)||!Number.isFinite(now))return {activeUsers:null,activeSeconds:0,activeComplete:false};
   this.prune(now);
   const duration=windowMs===60000?60000:WINDOW;
   const from=Math.max(now-duration,connectedSince,start);
   const activeSeconds=Math.max(0,Math.floor((now-from)/1000));
   if(from>now)return {activeUsers:null,activeSeconds:0,activeComplete:false};
   const channel=this.channels.get(slug);
   // A missing channel while at capacity may have been dropped.
   if(!channel&&this.channels.size>=this.maxChannels)return {activeUsers:null,activeSeconds,activeComplete:false};
   let count=0;for(const at of channel?.users.values()??[])if(at>=from&&at<=now)count++;
   return {activeUsers:count,activeSeconds,activeComplete:activeSeconds>=duration/1000&&!(channel&&channel.incompleteAt>=from)};
 }
 private prune(now:number){
   if(now>=this.lastPrune&&now-this.lastPrune<5000)return;this.lastPrune=now;
   for(const [slug,channel] of this.channels){
     for(const [id,at] of channel.users)if(at<now-WINDOW||at>now){channel.users.delete(id);this.size--;}
     if(channel.incompleteAt<now-WINDOW)channel.incompleteAt=-Infinity;
     if(!channel.users.size&&channel.incompleteAt===-Infinity)this.channels.delete(slug);
   }
 }
}
