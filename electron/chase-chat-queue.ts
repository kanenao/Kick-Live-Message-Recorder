export type ChaseChatJob = {url:string;slug:string;videoId:string;directory:string;state:"waiting"|"downloading"|"completed"|"error"|"cancelled";message:string};
export class ChaseChatQueue {
  private jobs=new Map<string,ChaseChatJob>();
  private active:string|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private stopped=false;
  constructor(private readonly busy:()=>boolean,private readonly start:(job:ChaseChatJob)=>void,private readonly delayMs=10000){}
  list():ChaseChatJob[]{return [...this.jobs.values()].map(x=>({...x})).reverse();}
  enqueue(url:string,directory:string):void{
    if(this.stopped)return;
    const match=/^https:\/\/kick\.com\/([a-z0-9_-]{1,40})\/videos\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(url);
    if(!match||!directory||this.jobs.has(url))return;
    if(this.jobs.size>=50){for(const [key,job] of this.jobs){if(["completed","error","cancelled"].includes(job.state)){this.jobs.delete(key);break;}}}
    if(this.jobs.size>=50)throw Error("過去コメント自動取得の上限です。");
    this.jobs.set(url,{url,slug:match[1],videoId:match[2],directory,state:"waiting",message:"過去コメントの取得待ち"});
    this.pump();
  }
  onEvent(event:{slug:string;videoId:string;status:string;message:string}):void{
    const job=this.active?this.jobs.get(this.active):undefined;
    if(!job||job.slug!==event.slug||job.videoId!==event.videoId)return;
    job.message=event.message;
    if(["completed","error","stopped"].includes(event.status)){
      job.state=event.status==="completed"?"completed":event.status==="error"?"error":"cancelled";
      this.active=null;this.wait();
    }
  }
  cancel(url:unknown):void{if(typeof url!=="string")return;const job=this.jobs.get(url);if(job?.state==="waiting"){job.state="cancelled";job.message="取得待ちを取り消しました。";}}
  stopAll():void{this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;for(const job of this.jobs.values())if(job.state==="waiting")job.state="cancelled";}
  private wait():void{if(!this.stopped&&!this.timer&&[...this.jobs.values()].some(j=>j.state==="waiting"))this.timer=setTimeout(()=>{this.timer=null;this.pump();},this.delayMs);}
  private pump():void{
    if(this.stopped||this.active)return;
    const job=[...this.jobs.values()].find(j=>j.state==="waiting");if(!job)return;
    if(this.busy()){this.wait();return;}
    this.active=job.url;job.state="downloading";
    try{this.start({...job});}catch(e){job.state="error";job.message=e instanceof Error?e.message:String(e);this.active=null;this.wait();}
  }
}
