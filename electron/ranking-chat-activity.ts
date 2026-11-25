/** Received message counts only. No extra subscriptions, identities or message bodies. */
export class RankingChatActivity {
  private readonly channels=new Map<string,Map<number,number>>();
  constructor(private readonly maxChannels=400){}
  add(slug:string,now=Date.now()):void{
    if(!/^[a-z0-9_-]{1,40}$/.test(slug)||!Number.isFinite(now))return;
    const minute=Math.floor(now/60000);
    this.prune(minute);
    let buckets=this.channels.get(slug);
    if(!buckets){if(this.channels.size>=this.maxChannels)return;buckets=new Map();this.channels.set(slug,buckets);}
    buckets.set(minute,(buckets.get(minute)??0)+1);
  }
  list(now=Date.now()):Array<{slug:string;messages:number}>{
    const minute=Math.floor(now/60000);this.prune(minute);
    return [...this.channels].map(([slug,buckets])=>({slug,messages:[...buckets.values()].reduce((a,b)=>a+b,0)})).filter(row=>row.messages>0).sort((a,b)=>b.messages-a.messages||a.slug.localeCompare(b.slug));
  }
  private prune(minute:number):void{
    for(const [slug,buckets] of this.channels){for(const key of buckets.keys())if(key<minute-4||key>minute)buckets.delete(key);if(!buckets.size)this.channels.delete(slug);}
  }
}
