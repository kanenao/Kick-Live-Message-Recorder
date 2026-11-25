import type {RankingScope} from "./kick-ranking";
export type RankingBackgroundStatus={enabled:boolean;scope:RankingScope;running:boolean;lastAt:string|null;nextAt:string|null;error:string};
export class RankingBackground {
  private timer:ReturnType<typeof setTimeout>|null=null;
  private inFlight=false;
  private closed=false;
  private revision=0;
  private status:RankingBackgroundStatus={enabled:false,scope:"ja",running:false,lastAt:null,nextAt:null,error:""};
  constructor(private readonly collect:(scope:RankingScope)=>Promise<unknown>,private readonly interval=300000){}
  getStatus():RankingBackgroundStatus{return {...this.status};}
  configure(enabled:boolean,scope:RankingScope):void{
    if(this.closed)return;
    if(enabled===this.status.enabled&&scope===this.status.scope)return;
    this.revision++;this.clear();
    this.status={enabled,scope,running:this.inFlight,lastAt:null,nextAt:null,error:""};
    if(enabled&&!this.inFlight)this.schedule(0);
  }
  stop():void{this.closed=true;this.revision++;this.clear();this.status={...this.status,enabled:false,nextAt:null};}
  private clear():void{if(this.timer)clearTimeout(this.timer);this.timer=null;}
  private schedule(delay:number):void{
    if(this.closed||!this.status.enabled)return;
    this.clear();this.status.nextAt=new Date(Date.now()+delay).toISOString();
    this.timer=setTimeout(()=>{this.timer=null;void this.tick();},delay);
    this.timer.unref?.();
  }
  private async tick():Promise<void>{
    if(this.closed||!this.status.enabled||this.inFlight)return;
    const revision=this.revision,scope=this.status.scope;
    this.inFlight=true;this.status.running=true;this.status.nextAt=null;
    try{await this.collect(scope);if(revision===this.revision){this.status.lastAt=new Date().toISOString();this.status.error="";}}
    catch(e){if(revision===this.revision)this.status.error=e instanceof Error?e.message:String(e);}
    finally{this.inFlight=false;this.status.running=false;if(!this.closed&&this.status.enabled)this.schedule(revision===this.revision?this.interval:0);}
  }
}
