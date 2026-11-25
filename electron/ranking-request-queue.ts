/** Serialize scopes and share concurrent requests. Delay from the prior start. */
export class RankingRequestQueue<K,V>{
  private tail:Promise<unknown>=Promise.resolve();
  private pending=new Map<K,Promise<V>>();
  private lastStart:number|null=null;
  constructor(private readonly interval=15000,private readonly now=()=>Date.now(),private readonly delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){}
  get size():number{return this.pending.size;}
  request(key:K,load:()=>Promise<V>):Promise<V>{
    const existing=this.pending.get(key);if(existing)return existing;
    const work=this.tail.then(async()=>{
      if(this.lastStart!==null){const wait=Math.max(0,this.interval-(this.now()-this.lastStart));if(wait)await this.delay(wait);}
      this.lastStart=this.now();return load();
    });
    this.pending.set(key,work);
    this.tail=work.then(()=>undefined,()=>undefined);
    void work.then(()=>this.pending.delete(key),()=>this.pending.delete(key));
    return work;
  }
}
