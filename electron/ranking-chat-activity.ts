import {recentChatCount} from "./ranking-chat-recent";
import {RankingActiveUsers} from "./ranking-active-users";
/** Received message counts only. No extra subscriptions, identities or message bodies. */
export class RankingChatActivity {
  private readonly channels=new Map<string,Map<number,number>>();
  private readonly events=new Map<string,number>();
  private readonly activeUsers=new RankingActiveUsers();
  private lastPruneMinute:number|null=null;
  constructor(private readonly maxChannels=400){}
  add(slug:string,now=Date.now(),eventId?:string,senderUserId?:number|null):void{
    if(!/^[a-z0-9_-]{1,40}$/.test(slug)||!Number.isFinite(now))return;
    const minute=Math.floor(now/5000);
    this.prune(minute);
    if(eventId){const id=slug+"|"+eventId;if(this.events.has(id))return;this.events.set(id,minute);if(this.events.size>30000){const first=this.events.keys().next().value;if(first!==undefined)this.events.delete(first);}}
    this.activeUsers.add(slug,senderUserId,now);
    let buckets=this.channels.get(slug);
    if(!buckets){if(this.channels.size>=this.maxChannels)return;buckets=new Map();this.channels.set(slug,buckets);}
    buckets.set(minute,(buckets.get(minute)??0)+1);
  }
  list(now=Date.now()):Array<{slug:string;messages:number}>{
    const minute=Math.floor(now/5000);this.prune(minute);
    return [...this.channels].map(([slug,buckets])=>({slug,messages:[...buckets].filter(([key])=>key>=minute-59).reduce((sum,[,n])=>sum+n,0)})).filter(row=>row.messages>0).sort((a,b)=>b.messages-a.messages||a.slug.localeCompare(b.slug));
  }
  observed(connected:readonly string[],desired:readonly string[],now=Date.now()):Array<{slug:string;messages:number;state:"connected"|"connecting"|"recent"}>{
    const counts=new Map(this.list(now).map(r=>[r.slug,r.messages]));const online=new Set(connected),wanted=new Set(desired);
    return [...new Set([...online,...wanted,...counts.keys()])].map(slug=>({slug,messages:counts.get(slug)??0,state:online.has(slug)?"connected" as const:wanted.has(slug)?"connecting" as const:"recent" as const}));
  }
  measured(slug:string,connectedSince:number|null,startedAt:string|null,now=Date.now()):{observedSeconds:number;ratePerMinute:number|null}{
    const started=Date.parse(startedAt??"");
    if(connectedSince===null||!Number.isFinite(connectedSince)||!Number.isFinite(started)||!Number.isFinite(now))return {observedSeconds:0,ratePerMinute:null};
    const end=Math.floor(now/5000),begin=Math.max(end-60,Math.ceil(Math.max(connectedSince,started)/5000));
    const observedSeconds=Math.max(0,(end-begin)*5);
    if(observedSeconds<60)return {observedSeconds,ratePerMinute:null};
    let count=0;for(const [bucket,n] of this.channels.get(slug)??[])if(bucket>=begin&&bucket<end)count+=n;
    return {observedSeconds,ratePerMinute:Math.round(count*600/observedSeconds)/10};
  }
  recent(slug:string,connectedSince:number|null,startedAt:string|null,now=Date.now()):number|null{
    if(!Number.isFinite(now))return null;
    this.prune(Math.floor(now/5000));
    return recentChatCount(this.channels.get(slug),connectedSince,startedAt,now,this.channels.size>=this.maxChannels);
  }
  active(slug:string,connectedSince:number|null,startedAt:string|null,now=Date.now()){return this.activeUsers.measure(slug,connectedSince,startedAt,now);}
  private prune(minute:number):void{
    if(this.lastPruneMinute===minute)return;this.lastPruneMinute=minute;
    for(const [id,at] of this.events)if(at<minute-60||at>minute)this.events.delete(id);
    for(const [slug,buckets] of this.channels){for(const key of buckets.keys())if(key<minute-60||key>minute)buckets.delete(key);if(!buckets.size)this.channels.delete(slug);}
  }
}
