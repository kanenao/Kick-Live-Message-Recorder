/** Match only the same known broadcast, never just the latest video. */
function record(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? x as Record<string,unknown> : {};
}
function time(x: unknown): number {
  if (typeof x !== "string") return NaN;
  const text = x.trim().replace(" ", "T");
  return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? text+"Z" : text);
}
export function sameBroadcastStart(a: unknown,b: unknown): boolean {
  const x=time(a), y=time(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.floor(x/1000)===Math.floor(y/1000);
}
export function findMatchingChaseVod(payload: unknown, slug: string, startedAt: string): string | null {
  if (!/^[a-z0-9_-]{1,40}$/.test(slug) || !Number.isFinite(time(startedAt))) return null;
  const rows = Array.isArray(payload) ? payload : record(payload).data;
  if (!Array.isArray(rows)) return null;
  const ids = new Set<string>();
  for (const row of rows.slice(0,100)) {
    const item=record(row), video=record(item.video), channel=record(item.channel);
    const owner=channel.slug ?? item.channel_slug;
    if (typeof owner==="string" && owner.toLowerCase()!==slug) continue;
    if (item.is_live===true || video.is_live===true || (typeof video.status==="string" && video.status!=="public")) continue;
    if (!sameBroadcastStart(item.start_time ?? item.started_at,startedAt)) continue;
    const id=video.uuid ?? item.uuid;
    if (typeof id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
    ids.add(id.toLowerCase());
  }
  if (ids.size!==1) return null;
  return "https://kick.com/"+slug+"/videos/"+[...ids][0];
}

export type ChaseRecoveryRequest = {slug:string;startedAt:string|null;outputDirectory:string;recoverVodChat?:boolean};
export type ChaseRecoveryStatus = {id:string;slug:string;startedAt:string|null;state:"waiting"|"checking"|"queued"|"unavailable"|"cancelled";attempt:number;message:string};
export type PendingChaseRecovery = {request:ChaseRecoveryRequest;attempt:number;createdAt:number};
type Task = {status:ChaseRecoveryStatus;request:ChaseRecoveryRequest;createdAt:number;controller:AbortController;timer:ReturnType<typeof setTimeout>|null};
export class ChaseVodRecovery {
  private readonly tasks=new Map<string,Task>();
  private closed=false;
  constructor(private readonly find:(request:ChaseRecoveryRequest,signal:AbortSignal)=>Promise<string|null>,
    private readonly enqueue:(url:string,request:ChaseRecoveryRequest)=>void,
    private readonly notify:(status:ChaseRecoveryStatus)=>void=()=>{},
    private readonly delayMs=60_000, private readonly maxAttempts=6) {}
  list():ChaseRecoveryStatus[] {return [...this.tasks.values()].map(x=>({...x.status})).reverse();}
  pending():PendingChaseRecovery[] {return [...this.tasks.values()].filter(x=>["waiting","checking"].includes(x.status.state)).map(x=>({request:{...x.request},attempt:x.status.attempt,createdAt:x.createdAt}));}
  restore(entries:PendingChaseRecovery[]):void {for(const entry of entries.slice(0,5))this.schedule(entry.request,entry.attempt,entry.createdAt);}
  schedule(request:ChaseRecoveryRequest,attempt=0,createdAt=Date.now()):void {
    if(this.closed) return;
    const id=request.slug+"|"+(request.startedAt??"unknown");
    if(this.tasks.has(id)) return;
    for(const [key,task] of this.tasks) if(this.tasks.size>=50 && !["waiting","checking"].includes(task.status.state)) this.tasks.delete(key);
    if(this.tasks.size>=50) return;
    const task:Task={status:{id,slug:request.slug,startedAt:request.startedAt,state:"waiting",attempt,message:"VOD公開を待っています。"},request,createdAt,controller:new AbortController(),timer:null};
    this.tasks.set(id,task);
    if(!request.startedAt || !Number.isFinite(time(request.startedAt))) {this.set(task,"unavailable","配信開始時刻が不明のため自動補完しません。VOD URLから手動で取得できます。");return;}
    if([...this.tasks.values()].filter(x=>["waiting","checking"].includes(x.status.state)).length>5) {this.set(task,"unavailable","自動補完待ちが上限です。VOD URLから手動で取得してください。");return;}
    if(attempt>=this.maxAttempts || Date.now()-createdAt>86400000){this.set(task,"unavailable","VOD公開待ちの期限または確認回数を超えました。手動取得をご利用ください。");return;}
    this.set(task,"waiting",attempt>0?"VOD公開待ちを再開しました。":"VOD公開を待っています（最大6回確認）。");
    this.wait(task);
  }
  cancel(id:unknown):void {
    if(typeof id!=="string") return;
    const task=this.tasks.get(id);
    if(!task || !["waiting","checking"].includes(task.status.state)) return;
    if(task.timer) clearTimeout(task.timer);
    task.timer=null; task.controller.abort();
    this.set(task,"cancelled","VODの自動検索を取り消しました。元の録画は保持します。");
  }
  stopAll():void {this.closed=true;for(const id of this.tasks.keys()) this.cancel(id);}
  /** Shutdown without changing pending states into user cancellations. */
  suspend():void {this.closed=true;for(const task of this.tasks.values()){if(task.timer)clearTimeout(task.timer);task.timer=null;task.controller.abort();}}
  private set(task:Task,state:ChaseRecoveryStatus["state"],message:string):void {
    task.status={...task.status,state,message};this.notify({...task.status});
  }
  private wait(task:Task):void {
    task.timer=setTimeout(()=>{task.timer=null;void this.check(task);},this.delayMs);
  }
  private async check(task:Task):Promise<void> {
    if(this.closed||task.controller.signal.aborted) return;
    if(Date.now()-task.createdAt>86400000||task.status.attempt>=this.maxAttempts){this.set(task,"unavailable","VOD公開待ちの期限または確認回数を超えました。");return;}
    task.status.attempt++;this.set(task,"checking","同じ配信の公開VODを確認中です。");
    try {
      const url=await this.find(task.request,task.controller.signal);
      if(this.closed||task.controller.signal.aborted) return;
      if(url) {
        // Remove from the persistent search journal before dispatch: a crash
        // during handoff must not silently enqueue a second download on restart.
        this.set(task,"queued","同じ配信のVODを取得一覧に渡しています。");
        try{this.enqueue(url,task.request);}catch{this.set(task,"unavailable","VOD取得一覧への登録に失敗しました。録画専用の一覧を確認し、必要なら手動取得してください。");return;}
        this.set(task,"queued","同じ配信のVODを取得一覧に登録しました。録画専用のVOD一覧で結果を確認してください。");
        return;
      }
    } catch {
      if(this.closed||task.controller.signal.aborted) return;
      // Access restrictions and transient API failures do not trigger faster polling.
    }
    if(task.status.attempt>=this.maxAttempts) {this.set(task,"unavailable","同じ配信の公開VODを確認できませんでした。元の録画を保持します。");return;}
    this.set(task,"waiting","まだ確認できないため、次の確認を待っています。");
    this.wait(task);
  }
}
