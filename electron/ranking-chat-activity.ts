/** Received message counts only. No extra subscriptions, identities or message bodies. */
export class RankingChatActivity {
  private readonly channels=new Map<string,Map<number,number>>();
  private readonly events=new Map<string,number>();
  constructor(private readonly maxChannels=400){}
  add(slug:string,now=Date.now(),eventId?:string):void{
    if(!/^[a-z0-9_-]{1,40}$/.test(slug)||!Number.isFinite(now))return;
    const minute=Math.floor(now/60000);
    this.prune(minute);
    if(eventId){const id=slug+"|"+eventId;if(this.events.has(id))return;this.events.set(id,minute);if(this.events.size>30000){const first=this.events.keys().next().value;if(first!==undefined)this.events.delete(first);}}
    let buckets=this.channels.get(slug);
    if(!buckets){if(this.channels.size>=this.maxChannels)return;buckets=new Map();this.channels.set(slug,buckets);}
    buckets.set(minute,(buckets.get(minute)??0)+1);
  }
  list(now=Date.now()):Array<{slug:string;messages:number}>{
    const minute=Math.floor(now/60000);this.prune(minute);
    return [...this.channels].map(([slug,buckets])=>({slug,messages:[...buckets.values()].reduce((a,b)=>a+b,0)})).filter(row=>row.messages>0).sort((a,b)=>b.messages-a.messages||a.slug.localeCompare(b.slug));
  }
  observed(connected:readonly string[],desired:readonly string[],now=Date.now()):Array<{slug:string;messages:number;state:"connected"|"connecting"|"recent"}>{
    const counts=new Map(this.list(now).map(r=>[r.slug,r.messages]));const online=new Set(connected),wanted=new Set(desired);
    return [...new Set([...online,...wanted,...counts.keys()])].map(slug=>({slug,messages:counts.get(slug)??0,state:online.has(slug)?"connected" as const:wanted.has(slug)?"connecting" as const:"recent" as const}));
  }
  private prune(minute:number):void{
    for(const [id,at] of this.events)if(at<minute-4||at>minute)this.events.delete(id);
    for(const [slug,buckets] of this.channels){for(const key of buckets.keys())if(key<minute-4||key>minute)buckets.delete(key);if(!buckets.size)this.channels.delete(slug);}
  }
}
