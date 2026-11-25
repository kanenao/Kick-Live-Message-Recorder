import {advanceRankFrame,rankingFrame,rankMovement,type RankFrame,type RankFrameHistory,type RankingMode} from "../../electron/ranking-movement";
import {appendTrendFrame,rankTrendPoints,rankTrendSegments,type RankTrendFrames} from "../../electron/ranking-trend";
import { MOMENTUM_WEIGHTS, momentumScores, refreshedRankingThumbnail } from "../../electron/ranking-momentum";
import {useEffect,useMemo,useRef,useState} from "react";
import type {RankingScope,RankingSnapshot} from "../../electron/kick-ranking";
import type {RankingHistory} from "../../electron/kick-ranking-history";
import type {RankingBackgroundStatus} from "../../electron/ranking-background";
const RANKING_REFRESH_MS=10000;
export function KickRanking({configured,desktop,onSettings,registered,canRegister,onRegister,recoverVod,recoverChat}:{configured:boolean;desktop:boolean;onSettings:()=>void;registered:string[];canRegister:boolean;onRegister:(slug:string)=>boolean;recoverVod:boolean;recoverChat:boolean}){
  const [scope,setScope]=useState<RankingScope>("ja");
  const [snapshots,setSnapshots]=useState<Partial<Record<RankingScope,RankingSnapshot>>>({});
  const [search,setSearch]=useState("");
  const [category,setCategory]=useState("");
  const [page,setPage]=useState(0);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),10000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{setCategory("");setPage(0);},[scope]);
  const [historyHours,setHistoryHours]=useState<24|168|720>(24);
  const [historySlug,setHistorySlug]=useState<string|null>(null);
  const [history,setHistory]=useState<RankingHistory|null>(null);
  const [historyError,setHistoryError]=useState("");
  const [showHistory,setShowHistory]=useState(false);
  const historyPanelRef=useRef<HTMLDivElement|null>(null);
  const [historyJump,setHistoryJump]=useState(0);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [trends,setTrends]=useState<Partial<Record<RankingScope,RankTrendFrames>>>({});
  function openHistory(slug:string){setShowHistory(true);setHistorySlug(slug);setHistoryJump(v=>v+1);}
  useEffect(()=>{if(historyJump>0&&showHistory)historyPanelRef.current?.scrollIntoView({block:"start",behavior:"smooth"});},[historyJump,showHistory]);
  const [sort,setSort]=useState<RankingMode>("viewers");
  const [background,setBackground]=useState<RankingBackgroundStatus|null>(null);
  const [backgroundBusy,setBackgroundBusy]=useState(false);
  const [observeChat,setObserveChat]=useState(true);
  const [preview,setPreview]=useState<{slug:string;name:string}|null>(null);
  const [previewPinned,setPreviewPinned]=useState(false);
  const hoverTimer=useRef<number|null>(null);
  const previewRef=useRef<string|null>(null);
  const [chatCoverage,setChatCoverage]=useState({targets:0,connected:0});
  useEffect(()=>{previewRef.current=preview?.slug??null;},[preview]);
  function cancelHover(){if(hoverTimer.current!==null){window.clearTimeout(hoverTimer.current);hoverTimer.current=null;}}
  function closePreview(){cancelHover();setPreview(null);setPreviewPinned(false);}
  function hoverPreview(slug:string,name:string){if(previewPinned)return;cancelHover();hoverTimer.current=window.setTimeout(()=>{hoverTimer.current=null;setPreview({slug,name});},450);}
  function leavePreview(slug:string){cancelHover();if(!previewPinned)setPreview(current=>current?.slug===slug?null:current);}
  function togglePreview(slug:string,name:string){cancelHover();if(previewPinned&&preview?.slug===slug){closePreview();return;}setPreview({slug,name});setPreviewPinned(true);}
  useEffect(()=>{closePreview();return cancelHover;},[scope]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==="Escape")closePreview();};window.addEventListener("keydown",key);return()=>{cancelHover();window.removeEventListener("keydown",key);};},[]);
  const [chatActivity,setChatActivity]=useState<Array<{slug:string;messages:number;state:"connected"|"connecting"|"recent"|"unavailable";observedSeconds:number;ratePerMinute:number|null;activeUsers:number|null;activeSeconds:number;activeComplete:boolean}>>([]);
  const [rankingChatMessage,setRankingChatMessage]=useState("");
  const [chatScope,setChatScope]=useState<RankingScope|null>(null);
  const [chatAt,setChatAt]=useState<string|null>(null);
  const [chatFrames,setChatFrames]=useState<Partial<Record<RankingScope,RankFrameHistory>>>({});
  const lastRankFrames=useRef<Partial<Record<RankingScope,RankFrame>>>({});
  const [previousRankFrames,setPreviousRankFrames]=useState<Partial<Record<RankingScope,RankFrame>>>({});
  useEffect(()=>{
    if(!desktop||!window.kickRecorder)return;
    let mounted=true,waiting=false;const api=window.kickRecorder;
    const refresh=()=>{
      if(waiting)return;waiting=true;
      void api.getRankingBackground().then(value=>{if(mounted)setBackground(value);}).catch(()=>undefined);
      void api.getRankingChatActivity(scope,observeChat,previewRef.current).then(value=>{if(mounted){setChatActivity(value.rows);setChatScope(scope);setChatAt(new Date().toISOString());setRankingChatMessage(value.message);setChatCoverage({targets:value.targets,connected:value.connected});}}).catch(e=>{if(mounted){setRankingChatMessage(String(e));setChatActivity([]);setChatCoverage({targets:0,connected:0});setChatScope(null);setChatAt(null);}}).finally(()=>{waiting=false;});
    };
    refresh();const timer=window.setInterval(refresh,RANKING_REFRESH_MS);
    return()=>{mounted=false;window.clearInterval(timer);};
  },[desktop,scope,observeChat]);
  useEffect(()=>()=>{void window.kickRecorder?.getRankingChatActivity("ja",false).catch(()=>undefined);},[]);
  async function configureBackground(enabled:boolean,nextScope:RankingScope){
    if(!window.kickRecorder||backgroundBusy)return;
    setBackgroundBusy(true);
    try{setBackground(await window.kickRecorder.setRankingBackground(enabled,nextScope));}
    catch(e){setMessage(e instanceof Error?e.message:String(e));}
    finally{setBackgroundBusy(false);}
  }
  const [auto,setAuto]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [active,setActive]=useState<string[]>([]);
  const [pending,setPending]=useState<string[]>([]);
  const locks=useRef(new Set<string>());
  const refreshRef=useRef<()=>void>(()=>{});
  const requestSeq=useRef(0);
  useEffect(()=>{
    if(!desktop||!configured)return;
    let mounted=true,waiting=false;
    const refresh=()=>{
      if(waiting)return;waiting=true;
      const seq=++requestSeq.current;setBusy(true);setError("");
      void window.kickRecorder?.getKickRanking(scope).then(snapshot=>{if(mounted&&seq===requestSeq.current)setSnapshots(prev=>({...prev,[scope]:snapshot}));}).catch(e=>{if(mounted&&seq===requestSeq.current)setError(e instanceof Error?e.message:String(e));}).finally(()=>{waiting=false;if(mounted&&seq===requestSeq.current)setBusy(false);});
    };
    refreshRef.current=refresh;refresh();
    const timer=auto?window.setInterval(refresh,RANKING_REFRESH_MS):undefined;
    return()=>{mounted=false;refreshRef.current=()=>{};if(timer!==undefined)window.clearInterval(timer);};
  },[scope,configured,desktop,auto]);
  useEffect(()=>{
    if(!desktop||!window.kickRecorder)return;
    let mounted=true;let revision=0;
    const reload=()=>{const seq=++revision;void window.kickRecorder?.listActiveLiveRecordings().then(slugs=>{if(mounted&&seq===revision)setActive(slugs);}).catch(()=>undefined);};
    reload();
    const unsubscribe=window.kickRecorder.onRecordingStatus(event=>{
      if(!mounted||event.isVod)return;
      reload();
      if(event.message)setMessage(event.slug+"："+event.message);
    });
    const timer=window.setInterval(reload,5000);
    return()=>{mounted=false;window.clearInterval(timer);unsubscribe();};
  },[desktop]);
  async function record(slug:string,stop:boolean,chaseRecording=false){
    const api=window.kickRecorder;if(!api||locks.current.has(slug))return;
    locks.current.add(slug);setPending([...locks.current]);setMessage("");
    try{
      const actual=await api.listActiveLiveRecordings();
      if(stop){if(!actual.includes(slug))throw Error("録画は既に終了しています。");await api.stopRecording(slug);}
      else {if(actual.includes(slug))throw Error("既に録画中です。録画を停止するには停止ボタンを押してください。");if(!snapshot||Date.now()-Date.parse(snapshot.fetchedAt)>180000)throw Error("ランキングが古いため、更新してから録画してください。");await api.startRecording(slug,undefined,chaseRecording,chaseRecording&&recoverVod,chaseRecording&&recoverVod&&recoverChat);setMessage(slug+"："+(chaseRecording?"追っかけ録画を試行します。":"録画開始を要求しました。"));}
      setActive(await api.listActiveLiveRecordings());
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}
    finally{locks.current.delete(slug);setPending([...locks.current]);}
  }
  const snapshot=snapshots[scope];
  useEffect(()=>{
    if(!desktop||!showHistory||!window.kickRecorder)return;
    let live=true,waiting=false;setHistory(null);setHistoryError("");setHistoryLoading(true);
    const api=window.kickRecorder;
    const refresh=()=>{if(waiting)return;waiting=true;void api.getKickRankingHistory(scope,historyHours,historySlug).then(value=>{if(live){setHistory(value);setHistoryError("");}}).catch(e=>{if(live)setHistoryError(e instanceof Error?e.message:String(e));}).finally(()=>{waiting=false;if(live)setHistoryLoading(false);});};
    refresh();const timer=window.setInterval(refresh,30000);
    return()=>{live=false;window.clearInterval(timer);};
  },[scope,historyHours,historySlug,desktop,showHistory]);
  function register(slug:string){
    if(!canRegister||registered.includes(slug))return;
    if(!window.confirm(slug+" を自動録画対象として登録しますか？ アプリの監視・自動録画設定が有効な場合、配信中や今後の配信を自動録画します。"))return;
    setMessage(onRegister(slug)?slug+"：自動監視・録画対象に追加しました。設定に従って動作します。": "登録できません。チャンネル名・登録上限を確認してください。");
  }
  const points=history?.points??[];
  const max=Math.max(1,...points.map(p=>p.viewers));
  const x=(at:number)=>20+560*(at-(history?.firstAt??at))/Math.max(1,(history?.lastAt??at)-(history?.firstAt??at));
  const y=(viewers:number)=>130-110*viewers/max;
  const q=search.trim().toLowerCase();
  const categories=[...new Set((snapshot?.entries??[]).map(row=>row.category))].sort((a,b)=>a.localeCompare(b,"ja"));
  const entries=(snapshot?.entries??[]).filter(row=>(!category||row.category===category)&&(!q||[row.slug,row.name,row.title,row.category].some(value=>value.toLowerCase().includes(q))));
  const scopedChat=useMemo(()=>chatScope===scope?chatActivity:[],[chatScope,scope,chatActivity]);
  const counts=new Map(scopedChat.map(row=>[row.slug,row.messages]));
  const chatStates=new Map(scopedChat.map(row=>[row.slug,row.state]));
  const chatMeasurements=new Map(scopedChat.map(row=>[row.slug,row]));
  const momentum=momentumScores(snapshot?.entries??[],scopedChat);
  const momentumBySlug=new Map(momentum.map((r,i)=>[r.slug,{...r,order:i}]));
  const frame=useMemo(()=>snapshot?rankingFrame(snapshot,scopedChat):null,[snapshot,scopedChat]);
  const chatFrame=useMemo(()=>snapshot&&chatScope===scope&&chatAt?rankingFrame(snapshot,scopedChat,chatAt):null,[snapshot,chatScope,scope,chatAt,scopedChat]);
  useEffect(()=>{
    setChatFrames(prev=>{
      if(!chatFrame)return prev[scope]?{...prev,[scope]:undefined}:prev;
      const next=advanceRankFrame(prev[scope],chatFrame);
      return next===prev[scope]?prev:{...prev,[scope]:next};
    });
  },[scope,chatFrame]);
  const previousChatFrame=chatFrames[scope]?.current.at===chatFrame?.at?chatFrames[scope]?.previous:null;
  const chatSort=sort==="chat"||sort==="active"||sort==="momentum";
  useEffect(()=>{
    if(!frame&&!chatFrame)return;
    setTrends(prev=>{const old=prev[scope]??{};let next=old;if(frame)next=appendTrendFrame(next,frame,["viewers","growth"]);if(chatFrame)next=appendTrendFrame(next,chatFrame,["chat","active","momentum"]);return next===old?prev:{...prev,[scope]:next};});
  },[scope,frame,chatFrame]);
  const trendFor=(slug:string,start:string|null)=>rankTrendPoints(trends[scope]?.[sort]??[],sort,slug,start);
  const selectedRow=snapshot?.entries.find(r=>r.slug===historySlug);
  const selectedTrend=selectedRow?trendFor(selectedRow.slug,selectedRow.startedAt):[];
  useEffect(()=>{
    if(!frame)return;
    const old=lastRankFrames.current[scope];
    if(old&&Date.parse(old.at)>=Date.parse(frame.at))return;
    if(old)setPreviousRankFrames(prev=>({...prev,[scope]:old}));
    lastRankFrames.current[scope]=frame;
  },[scope,frame]);
  const order=new Map((frame?.orders[sort]??[]).map((slug,index)=>[slug,index]));
  const sorted=[...entries].sort((a,b)=>(order.get(a.slug)??Infinity)-(order.get(b.slug)??Infinity)||a.rank-b.rank);
  const rankLabels:Record<RankingMode,string>={viewers:"同接順位",growth:"増加順位",chat:"コメント順位",active:"アクティブ順位",momentum:"総合順位"};
  const movementLabels={up:"▲ UP",down:"▼ DOWN",keep:"＝ KEEP",new:"★ NEW",unknown:"—"};
  const pageCount=Math.max(1,Math.ceil(sorted.length/50)),currentPage=Math.min(page,pageCount-1);
  const visible=sorted.slice(currentPage*50,(currentPage+1)*50);
  const previewVisible=preview===null||visible.some(row=>row.slug===preview.slug);
  useEffect(()=>{if(!previewVisible)closePreview();},[previewVisible]);
  const stale=!snapshot||now-Date.parse(snapshot.fetchedAt)>180000;
  useEffect(()=>{setPage(0);},[search,category,sort]);
  const elapsed=(date:string|null)=>{if(!date)return "不明";const m=Math.max(0,Math.floor((now-Date.parse(date))/60000));return Math.floor(m/60)+"時間"+(m%60)+"分";};
  const action=(slug:string)=>{const recording=active.includes(slug),working=pending.includes(slug),disabled=!desktop||working||(!recording&&stale);return <div className="ranking-record-buttons">{recording?<button className="small-action" disabled={disabled} onClick={()=>void record(slug,true)}>■ 録画停止</button>:<><button className="primary-small" disabled={disabled} onClick={()=>void record(slug,false,false)}>{working?"処理中…":"● 通常録画"}</button><button className="small-action chase-recording-button" disabled={disabled} onClick={()=>void record(slug,false,true)} title="取得可能な最古の映像から録画を試行">↶ 追っかけ録画</button></>}</div>;};
  return <section className="panel kick-ranking">
    <div className="panel-heading"><div><h2>リアルタイム同接ランキング</h2><p>Kick公式APIから独自集計。登録していない配信者も直接録画できます。</p></div><span className="count-pill">{snapshot? snapshot.total.toLocaleString()+" 配信取得":"未取得"}</span></div>
    {!configured&&<div className="notice">ランキングにはKick APIの設定が必要です。<button className="small-action" onClick={onSettings}>設定を開く</button></div>}
    <div className="ranking-toolbar"><select aria-label="ランキング範囲" value={scope} onChange={e=>setScope(e.target.value as RankingScope)}><option value="ja">日本語配信</option><option value="all">全世界</option></select><select aria-label="並び順" value={sort} onChange={e=>setSort(e.target.value as "viewers"|"growth"|"chat"|"momentum"|"active")}><option value="viewers">同時視聴者数順</option><option value="growth">視聴者増加数順</option><option value="chat">受信コメント勢い順</option><option value="momentum">総合勢い順</option><option value="active">アクティブ人数順</option></select><select aria-label="カテゴリ絞り込み" value={category} onChange={e=>setCategory(e.target.value)}><option value="">全カテゴリ</option>{categories.map(c=><option key={c} value={c}>{c}</option>)}</select><input aria-label="配信検索" placeholder="配信者・タイトル・カテゴリ検索" value={search} onChange={e=>setSearch(e.target.value)}/><label><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> 自動更新（{RANKING_REFRESH_MS/1000}秒）</label><button className="small-action" disabled={busy||!configured||!desktop} onClick={()=>refreshRef.current()}>{busy?"取得中…":"更新"}</button></div>
    {background&&<div className="notice"><label><input type="checkbox" checked={background.enabled} disabled={backgroundBusy||(!configured&&!background.enabled)} onChange={e=>void configureBackground(e.target.checked,background.scope)}/> 画面を閉じてもランキングを収集（5分間隔）</label> <select aria-label="常時収集範囲" value={background.scope} disabled={backgroundBusy} onChange={e=>void configureBackground(background.enabled,e.target.value as RankingScope)}><option value="ja">日本語配信</option><option value="all">全世界</option></select><div>{background.running?"取得中":background.enabled?"収集有効":"停止中"} ／ 前回成功：{background.lastAt?new Date(background.lastAt).toLocaleString("ja-JP"):"未取得"} ／ 次回：{background.nextAt?new Date(background.nextAt).toLocaleString("ja-JP"):"—"}</div>{background.error&&<div role="alert">{background.error}</div>}<div>アプリ動作中のみ収集。追加のAPI通信があります。設定は次回起動にも引き継がれます。</div></div>}
    <div className="ranking-caption"><label><input type="checkbox" checked={observeChat} onChange={e=>setObserveChat(e.target.checked)}/> 最大30配信のコメント勢いを受信（追加接続・ログ保存なし）</label> ／ 追加観測 {chatCoverage.connected}/{chatCoverage.targets}件接続 ／ {rankingChatMessage||"受信準備中"}。同接上位10を優先確保し、登録配信者・プレビュー・視聴者増加・総合勢いも優先枠へ。上位10の変更時は60秒以上、通常は360秒以上の間隔で接続先を切り替えます。チャットは接続中リアルタイム受信し、直近約5分の受信件数・毎分コメント数・アクティブ人数・総合順位を10秒ごとに反映します。</div>
    <p className="ranking-caption">順位変動：▲ UP（上昇）／▼ DOWN（下降）／＝ KEEP（変動なし）／★ NEW（新規・新しい放送）／—（比較なし）。同じ範囲の前回取得結果（コメント・アクティブ・総合は前回チャット観測）と比較。絞り込みやページ変更で順位を振り直しません。同接以外は観測範囲内の順位です。</p>
    {sort==="chat"&&<p className="ranking-caption">連続観測60秒以上の毎分コメント数順。観測不足は後ろに表示します。Kick全体のコメント順位ではありません。</p>}
    <p className="ranking-caption">アクティブ人数：直近5分に実際にコメントした識別可能なユーザーの重複なし人数。連続観測不足・識別不可・上限到達は暫定扱い、未接続は未観測。アクティブ人数順は5分観測済みを優先します。閲覧のみの人数は含みません。</p>
    <p className="ranking-caption">総合勢い＝同接{MOMENTUM_WEIGHTS.viewers}%・前回比の視聴者増加{MOMENTUM_WEIGHTS.growth}%・観測コメント毎分{MOMENTUM_WEIGHTS.chat}%・アクティブ人数{MOMENTUM_WEIGHTS.active}%（各指標を取得範囲内で対数補正）。コメントは連続観測60秒以上、人数は5分の観測完了が必要。4項目取得済みのみ総合順位を付け、未観測・比較なしは暫定点として後に表示。Kick全体の確定順位ではありません。</p>
    {snapshot&&<div className="ranking-caption">最終取得：{new Date(snapshot.fetchedAt).toLocaleString("ja-JP")} ／ {snapshot.complete?"取得完了":"取得範囲内の暫定ランキング"} ／ 最大500件を保持・50件ずつ表示 ／ 順位変動は前回取得との比較{snapshot.excluded>0?" ／ 不明データ "+snapshot.excluded+"件":""}</div>}
    {snapshot&&stale&&<div className="notice" role="alert">取得から3分を超えています。誤った配信の録画を避けるため、新規録画は更新後に操作してください。録画停止は利用できます。</div>}
    {error&&<div className="notice" role="alert">{error}{snapshot?"（前回取得結果を表示中）":""}</div>}
    {message&&<p className="api-message" role="status">{message}</p>}
    {!!active.length&&<div className="ranking-active"><strong>現在録画中（ランキング圏外も表示）</strong>{active.map(slug=><div key={slug}><span>{slug}</span>{action(slug)}</div>)}</div>}
    {busy&&!snapshot&&<div className="empty-state">ランキングを取得しています…</div>}
    {!busy&&snapshot&&visible.length===0&&<div className="empty-state">条件に一致する配信がありません。</div>}
    <div className="ranking-scroll"><table className="ranking-table"><thead><tr><th>{rankLabels[sort]}<small>前回比</small></th><th>配信画面</th><th>配信者・番組情報</th><th>同時視聴者</th><th>視聴者増加</th><th>受信コメント</th><th title="直近5分に実際にコメントした識別可能な人数">アクティブ人数</th><th>総合勢い</th><th>配信時間</th><th>録画操作</th></tr></thead><tbody>{visible.map(row=><tr key={row.slug}><td>{(()=>{const rank=frame?.ranks[sort].get(row.slug),change=chatSort?(chatFrame?rankMovement(chatFrame,previousChatFrame,sort,row):null):frame?rankMovement(frame,previousRankFrames[scope],sort,row):null;return <div className="ranking-position"><strong className="ranking-rank">{rank!=null?rank+"位":"—"}</strong><span className={"ranking-move ranking-move-"+(change?.kind??"unknown")} title={change?.previous!=null?"前回 "+change.previous+"位":change?.kind==="new"?"新しい配信・新規登場":"比較可能な前回順位なし"}>{movementLabels[change?.kind??"unknown"]}{change&&change.delta>0?" "+change.delta:""}</span>{change?.previous!=null&&<small>前回 {change.previous}位</small>}{sort!=="viewers"&&<small>同接 {row.rank}位</small>}{(()=>{const p=trendFor(row.slug,row.startedAt),segments=rankTrendSegments(p);return segments.length?<button type="button" className="ranking-trend-button" onClick={()=>openHistory(row.slug)} title="順位推移を詳しく見る"><svg className="ranking-trend" viewBox="0 0 72 26" role="img" aria-label={"順位推移："+p.map(v=>v.rank==null?"欠測":v.rank+"位").join(" → ")}>{segments.map((v,i)=><polyline key={i} points={v} fill="none" stroke="currentColor" strokeWidth="2"/>)}</svg></button>:<small>推移観測中</small>;})()}</div>;})()}</td><td><div className="ranking-thumb" onMouseEnter={()=>hoverPreview(row.slug,row.name)} onMouseLeave={()=>leavePreview(row.slug)}>{row.thumbnail?<img key={row.slug+"|"+snapshot?.fetchedAt} src={refreshedRankingThumbnail(row.thumbnail,snapshot?.fetchedAt)??row.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{const original=row.thumbnail;if(original&&e.currentTarget.src!==original&&!e.currentTarget.dataset.fallback){e.currentTarget.dataset.fallback="1";e.currentTarget.src=original;}else e.currentTarget.style.visibility="hidden";}}/>:<span>LIVE</span>}{preview?.slug===row.slug&&/^[a-z0-9_-]{1,40}$/.test(row.slug)&&<iframe key={row.slug} className="ranking-thumb-player" src={"https://player.kick.com/"+encodeURIComponent(row.slug)+"?autoplay=true&muted=true"} title={row.name+"のライブ映像"} allow="autoplay" tabIndex={-1} aria-hidden="true"/>}<button type="button" className="ranking-thumb-toggle" onClick={()=>togglePreview(row.slug,row.name)} aria-label={row.name+(previewPinned&&preview?.slug===row.slug?"の固定プレビューを解除":"のライブ映像を同じ枠内に固定")} aria-pressed={previewPinned&&preview?.slug===row.slug} title="マウスを合わせると枠内再生・クリックで固定/解除">{preview?.slug===row.slug&&<span className="ranking-thumb-live">{previewPinned?"● 固定":"● LIVE"}</span>}</button></div></td><td><button className="ranking-name" onClick={()=>void window.kickRecorder?.openKickProfile(row.slug).catch(e=>setMessage(String(e)))}>{row.avatar&&<img src={row.avatar} alt="" loading="lazy" referrerPolicy="no-referrer"/>}{row.name}</button><div className="ranking-title">{row.title}</div><small>{row.category} ・ {row.language||"言語不明"}</small></td><td><strong className="ranking-viewers">{row.viewers.toLocaleString("ja-JP")}</strong></td><td><strong>{row.viewerChange===null?"比較なし":(row.viewerChange>0?"+":"")+row.viewerChange.toLocaleString("ja-JP")}</strong></td><td>{chatStates.get(row.slug)==="connected"?<>{(counts.get(row.slug)??0).toLocaleString("ja-JP")}件<small>{chatMeasurements.get(row.slug)?.ratePerMinute!=null?chatMeasurements.get(row.slug)!.ratePerMinute!.toFixed(1)+"件/分":"観測中 "+(chatMeasurements.get(row.slug)?.observedSeconds??0)+"/60秒"}</small></>:chatStates.get(row.slug)==="connecting"?"接続中":chatStates.get(row.slug)==="recent"?(counts.get(row.slug)??0)+"件（切断）":chatStates.get(row.slug)==="unavailable"?((counts.get(row.slug)??0)>0?(counts.get(row.slug)+"件／"):"")+"受信不可・再試行待ち":"対象外"}</td><td>{(()=>{const m=chatMeasurements.get(row.slug);return m?.activeUsers!=null?<><strong>{m.activeUsers.toLocaleString("ja-JP")}人</strong><small>{m.activeComplete?"5分観測":"暫定・"+m.activeSeconds+"秒観測"}</small></>:<small>未観測</small>;})()}</td><td><strong className="ranking-momentum">{momentumBySlug.get(row.slug)?.score.toFixed(1)??"—"}</strong><small>{momentumBySlug.get(row.slug)?.complete?"4項目観測":"暫定・データ不足"}</small></td><td>{elapsed(row.startedAt)}</td><td>{action(row.slug)}<div className="ranking-row-actions"><button className="small-action" type="button" onClick={()=>openHistory(row.slug)}>推移</button><button className="small-action" disabled={!canRegister||registered.includes(row.slug)||!/^[a-z0-9_]{1,25}$/.test(row.slug)} onClick={()=>register(row.slug)}>{registered.includes(row.slug)?"登録済":"監視・録画登録"}</button></div></td></tr>)}</tbody></table></div>
    {sorted.length>0&&<div className="ranking-pages"><span>{currentPage*50+1}〜{Math.min(sorted.length,(currentPage+1)*50)} / {sorted.length}件</span><button className="small-action" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>前へ</button><span>{currentPage+1} / {pageCount}</span><button className="small-action" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>次へ</button></div>}

    <div className="ranking-history-panel" ref={historyPanelRef}>
      <div className="panel-heading"><div><h2>ランキング履歴・視聴者数推移</h2><p>PC内で観測した上位100件を5分単位で保存。未取得時間の数値は補完しません。</p></div><button className="small-action" onClick={()=>setShowHistory(v=>!v)}>{showHistory?"閉じる":"履歴を見る"}</button></div>
      {showHistory&&<><div className="ranking-toolbar"><select aria-label="集計期間" value={historyHours} onChange={e=>setHistoryHours(e.target.value==="720"?720:e.target.value==="168"?168:24)}><option value={24}>過去24時間</option><option value={168}>過去7日間</option><option value={720}>過去30日間</option></select><span>最高同接順（観測値）</span></div>
      {historyLoading&&<p role="status">推移データを取得しています…</p>}
      {historyError&&<p role="alert">{historyError}</p>}
      {historySlug&&<div className="ranking-graph"><strong>{historySlug} の{rankLabels[sort]}推移（直近の実測・最大60点）</strong>{rankTrendSegments(selectedTrend,600,152).length?<svg viewBox="0 0 600 152" role="img" aria-label="直近の順位推移">{rankTrendSegments(selectedTrend,600,152).map((v,i)=><polyline key={i} points={v} fill="none" stroke="#59b6ff" strokeWidth="2"/>)}</svg>:<p>連続した順位観測がまだ2点ありません。</p>}{selectedTrend.length>0&&<p className="ranking-caption">最新観測：{selectedTrend.at(-1)?.rank??"未取得"}{selectedTrend.at(-1)?.rank!=null?"位":""} ／ 上ほど上位。欠測は線で結びません。</p>}</div>}
      {history&&<><p className="ranking-caption">取得回数：{history.samples}回 ／ {history.firstAt?new Date(history.firstAt).toLocaleString("ja-JP"):"記録なし"} 〜 {history.lastAt?new Date(history.lastAt).toLocaleString("ja-JP"):"記録なし"}</p>
      {historySlug&&<div className="ranking-graph"><strong>{historySlug} の視聴者数推移（保存履歴）</strong>{points.length?<><svg viewBox="0 0 600 152" role="img" aria-label={historySlug+"の観測視聴者数"}><path d="M20 20V130H580" stroke="#63756a" fill="none"/>{points.map(p=><circle key={p.at} cx={x(p.at)} cy={y(p.viewers)} r="2.5" fill="#75e2a1"><title>{new Date(p.at).toLocaleString("ja-JP")+"："+p.viewers+"人"}</title></circle>)}</svg><p className="ranking-caption">観測最高 {max.toLocaleString("ja-JP")} 人 ／ {points.length}点（点のない時間は不明）</p></>:<p>この期間の観測記録がありません。</p>}</div>}
      <div className="ranking-scroll"><table className="ranking-table"><thead><tr><th>順</th><th>配信者</th><th>観測最高同接</th><th>最高順位</th><th>観測回数</th></tr></thead><tbody>{history.leaders.map((r,i)=><tr key={r.slug}><td>{i+1}</td><td><button className="ranking-name" type="button" onClick={()=>openHistory(r.slug)}>{r.name}　推移</button></td><td>{r.peakViewers.toLocaleString("ja-JP")}</td><td>{r.bestRank??"不明"}</td><td>{r.samples}</td></tr>)}</tbody></table></div></>}
      </>}
    </div>
    <p className="ranking-caption">視聴者増加数は前回取得からの増減です。チャット投稿数や全期間の記録ではありません。通常・追っかけ録画を選択可能です。追っかけ録画はサーバーに残る映像のみ取得を試行します。</p>
  </section>;
}
