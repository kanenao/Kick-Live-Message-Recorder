import {useEffect,useRef,useState} from "react";
import type {RankingScope,RankingSnapshot} from "../../electron/kick-ranking";
import type {RankingHistory} from "../../electron/kick-ranking-history";
import type {RankingBackgroundStatus} from "../../electron/ranking-background";
export function KickRanking({configured,desktop,onSettings,registered,canRegister,onRegister,chaseRecording,recoverVod,recoverChat}:{configured:boolean;desktop:boolean;onSettings:()=>void;registered:string[];canRegister:boolean;onRegister:(slug:string)=>boolean;chaseRecording:boolean;recoverVod:boolean;recoverChat:boolean}){
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
  const [sort,setSort]=useState<"viewers"|"growth"|"chat">("viewers");
  const [background,setBackground]=useState<RankingBackgroundStatus|null>(null);
  const [backgroundBusy,setBackgroundBusy]=useState(false);
  const [chatActivity,setChatActivity]=useState<Array<{slug:string;messages:number}>>([]);
  useEffect(()=>{
    if(!desktop||!window.kickRecorder)return;
    let mounted=true;const api=window.kickRecorder;
    const refresh=()=>{
      void api.getRankingBackground().then(value=>{if(mounted)setBackground(value);}).catch(()=>undefined);
      void api.getRankingChatActivity().then(value=>{if(mounted)setChatActivity(value);}).catch(()=>undefined);
    };
    refresh();const timer=window.setInterval(refresh,10000);
    return()=>{mounted=false;window.clearInterval(timer);};
  },[desktop]);
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
    let mounted=true;
    const refresh=()=>{
      const seq=++requestSeq.current;setBusy(true);setError("");
      void window.kickRecorder?.getKickRanking(scope).then(snapshot=>{if(mounted&&seq===requestSeq.current)setSnapshots(prev=>({...prev,[scope]:snapshot}));}).catch(e=>{if(mounted&&seq===requestSeq.current)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(mounted&&seq===requestSeq.current)setBusy(false);});
    };
    refreshRef.current=refresh;refresh();
    const timer=auto?window.setInterval(refresh,60000):undefined;
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
  async function record(slug:string,stop:boolean){
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
    let live=true;setHistory(null);setHistoryError("");
    void window.kickRecorder.getKickRankingHistory(scope,historyHours,historySlug).then(value=>{if(live)setHistory(value);}).catch(e=>{if(live)setHistoryError(e instanceof Error?e.message:String(e));});
    return()=>{live=false;};
  },[scope,historyHours,historySlug,desktop,showHistory,snapshot?.fetchedAt]);
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
  if(sort==="growth")entries.sort((a,b)=>(b.viewerChange??-Infinity)-(a.viewerChange??-Infinity)||a.rank-b.rank);
  const counts=new Map(chatActivity.map(row=>[row.slug,row.messages]));
  const sorted=sort==="chat"?entries.filter(row=>counts.has(row.slug)).sort((a,b)=>(counts.get(b.slug)??0)-(counts.get(a.slug)??0)||a.rank-b.rank):entries;
  const pageCount=Math.max(1,Math.ceil(sorted.length/50)),currentPage=Math.min(page,pageCount-1);
  const visible=sorted.slice(currentPage*50,(currentPage+1)*50);
  const stale=!snapshot||now-Date.parse(snapshot.fetchedAt)>180000;
  useEffect(()=>{setPage(0);},[search,category,sort]);
  const elapsed=(date:string|null)=>{if(!date)return "不明";const m=Math.max(0,Math.floor((now-Date.parse(date))/60000));return Math.floor(m/60)+"時間"+(m%60)+"分";};
  const action=(slug:string)=><button className={active.includes(slug)?"small-action":"primary-small"} disabled={!desktop||pending.includes(slug)||(!active.includes(slug)&&stale)} onClick={()=>void record(slug,active.includes(slug))}>{pending.includes(slug)?"処理中…":active.includes(slug)?"■ 録画停止":chaseRecording?"● 追っかけ録画":"● 録画"}</button>;
  return <section className="panel kick-ranking">
    <div className="panel-heading"><div><h2>リアルタイム同接ランキング</h2><p>Kick公式APIから独自集計。登録していない配信者も直接録画できます。</p></div><span className="count-pill">{snapshot? snapshot.total.toLocaleString()+" 配信取得":"未取得"}</span></div>
    {!configured&&<div className="notice">ランキングにはKick APIの設定が必要です。<button className="small-action" onClick={onSettings}>設定を開く</button></div>}
    <div className="ranking-toolbar"><select aria-label="ランキング範囲" value={scope} onChange={e=>setScope(e.target.value as RankingScope)}><option value="ja">日本語配信</option><option value="all">全世界</option></select><select aria-label="並び順" value={sort} onChange={e=>setSort(e.target.value as "viewers"|"growth"|"chat")}><option value="viewers">同時視聴者数順</option><option value="growth">視聴者増加数順</option><option value="chat">受信コメント勢い順</option></select><select aria-label="カテゴリ絞り込み" value={category} onChange={e=>setCategory(e.target.value)}><option value="">全カテゴリ</option>{categories.map(c=><option key={c} value={c}>{c}</option>)}</select><input aria-label="配信検索" placeholder="配信者・タイトル・カテゴリ検索" value={search} onChange={e=>setSearch(e.target.value)}/><label><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> 自動更新（60秒）</label><button className="small-action" disabled={busy||!configured||!desktop} onClick={()=>refreshRef.current()}>{busy?"取得中…":"更新"}</button></div>
    {background&&<div className="notice"><label><input type="checkbox" checked={background.enabled} disabled={backgroundBusy||(!configured&&!background.enabled)} onChange={e=>void configureBackground(e.target.checked,background.scope)}/> 画面を閉じてもランキングを収集（5分間隔）</label> <select aria-label="常時収集範囲" value={background.scope} disabled={backgroundBusy} onChange={e=>void configureBackground(background.enabled,e.target.value as RankingScope)}><option value="ja">日本語配信</option><option value="all">全世界</option></select><div>{background.running?"取得中":background.enabled?"収集有効":"停止中"} ／ 前回成功：{background.lastAt?new Date(background.lastAt).toLocaleString("ja-JP"):"未取得"} ／ 次回：{background.nextAt?new Date(background.nextAt).toLocaleString("ja-JP"):"—"}</div>{background.error&&<div role="alert">{background.error}</div>}<div>アプリ動作中のみ収集。追加のAPI通信があります。設定は次回起動にも引き継がれます。</div></div>}
    {sort==="chat"&&<p className="ranking-caption">既存のチャット受信で観測した直近5分枠（最大5分）のコメント数順。未受信の配信者は対象外で、Kick全体のコメント順位ではありません。順位欄は同接順位です。</p>}
    {snapshot&&<div className="ranking-caption">最終取得：{new Date(snapshot.fetchedAt).toLocaleString("ja-JP")} ／ {snapshot.complete?"取得完了":"取得範囲内の暫定ランキング"} ／ 最大500件を保持・50件ずつ表示 ／ 順位変動は前回取得との比較{snapshot.excluded>0?" ／ 不明データ "+snapshot.excluded+"件":""}</div>}
    {snapshot&&stale&&<div className="notice" role="alert">取得から3分を超えています。誤った配信の録画を避けるため、新規録画は更新後に操作してください。録画停止は利用できます。</div>}
    {error&&<div className="notice" role="alert">{error}{snapshot?"（前回取得結果を表示中）":""}</div>}
    {message&&<p className="api-message" role="status">{message}</p>}
    {!!active.length&&<div className="ranking-active"><strong>現在録画中（ランキング圏外も表示）</strong>{active.map(slug=><div key={slug}><span>{slug}</span>{action(slug)}</div>)}</div>}
    {busy&&!snapshot&&<div className="empty-state">ランキングを取得しています…</div>}
    {!busy&&snapshot&&visible.length===0&&<div className="empty-state">条件に一致する配信がありません。</div>}
    <div className="ranking-scroll"><table className="ranking-table"><thead><tr><th>順位</th><th>配信画面</th><th>配信者・番組情報</th><th>同時視聴者</th><th>受信コメント</th><th>配信時間</th><th>録画操作</th></tr></thead><tbody>{visible.map(row=><tr key={row.slug}><td><strong className="ranking-rank">{row.rank}</strong><small>{row.rankChange===null?"—":row.rankChange>0?"↑"+row.rankChange:row.rankChange<0?"↓"+Math.abs(row.rankChange):"→"}</small></td><td><button className="ranking-thumb" onClick={()=>void window.kickRecorder?.openKickProfile(row.slug).catch(e=>setMessage(String(e)))} aria-label={row.name+"の配信ページ"}>{row.thumbnail?<img src={row.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer"/>:<span>LIVE</span>}</button></td><td><button className="ranking-name" onClick={()=>void window.kickRecorder?.openKickProfile(row.slug).catch(e=>setMessage(String(e)))}>{row.avatar&&<img src={row.avatar} alt="" loading="lazy" referrerPolicy="no-referrer"/>}{row.name}</button><div className="ranking-title">{row.title}</div><small>{row.category} ・ {row.language||"言語不明"}</small></td><td><strong className="ranking-viewers">{row.viewers.toLocaleString("ja-JP")}</strong><small>{row.viewerChange===null?"比較なし":(row.viewerChange>0?"+":"")+row.viewerChange.toLocaleString("ja-JP")}</small></td><td>{counts.has(row.slug)?counts.get(row.slug)?.toLocaleString("ja-JP"):"未観測"}</td><td>{elapsed(row.startedAt)}</td><td>{action(row.slug)}<div className="ranking-row-actions"><button className="small-action" onClick={()=>{setShowHistory(true);setHistorySlug(row.slug);}}>推移</button><button className="small-action" disabled={!canRegister||registered.includes(row.slug)||!/^[a-z0-9_]{1,25}$/.test(row.slug)} onClick={()=>register(row.slug)}>{registered.includes(row.slug)?"登録済":"監視・録画登録"}</button></div></td></tr>)}</tbody></table></div>
    {sorted.length>0&&<div className="ranking-pages"><span>{currentPage*50+1}〜{Math.min(sorted.length,(currentPage+1)*50)} / {sorted.length}件</span><button className="small-action" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>前へ</button><span>{currentPage+1} / {pageCount}</span><button className="small-action" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>次へ</button></div>}
    <div className="ranking-history-panel">
      <div className="panel-heading"><div><h2>ランキング履歴・視聴者数推移</h2><p>PC内で観測した上位100件を5分単位で保存。未取得時間の数値は補完しません。</p></div><button className="small-action" onClick={()=>setShowHistory(v=>!v)}>{showHistory?"閉じる":"履歴を見る"}</button></div>
      {showHistory&&<><div className="ranking-toolbar"><select aria-label="集計期間" value={historyHours} onChange={e=>setHistoryHours(e.target.value==="720"?720:e.target.value==="168"?168:24)}><option value={24}>過去24時間</option><option value={168}>過去7日間</option><option value={720}>過去30日間</option></select><span>最高同接順（観測値）</span></div>
      {historyError&&<p role="alert">{historyError}</p>}
      {history&&<><p className="ranking-caption">取得回数：{history.samples}回 ／ {history.firstAt?new Date(history.firstAt).toLocaleString("ja-JP"):"記録なし"} 〜 {history.lastAt?new Date(history.lastAt).toLocaleString("ja-JP"):"記録なし"}</p>
      {historySlug&&<div className="ranking-graph"><strong>{historySlug} の視聴者数推移</strong>{points.length?<><svg viewBox="0 0 600 152" role="img" aria-label={historySlug+"の観測視聴者数"}><path d="M20 20V130H580" stroke="#63756a" fill="none"/>{points.map(p=><circle key={p.at} cx={x(p.at)} cy={y(p.viewers)} r="2.5" fill="#75e2a1"><title>{new Date(p.at).toLocaleString("ja-JP")+"："+p.viewers+"人"}</title></circle>)}</svg><p className="ranking-caption">観測最高 {max.toLocaleString("ja-JP")} 人 ／ {points.length}点（点のない時間は不明）</p></>:<p>この期間の観測記録がありません。</p>}</div>}
      <div className="ranking-scroll"><table className="ranking-table"><thead><tr><th>順</th><th>配信者</th><th>観測最高同接</th><th>最高順位</th><th>観測回数</th></tr></thead><tbody>{history.leaders.map((r,i)=><tr key={r.slug}><td>{i+1}</td><td><button className="ranking-name" onClick={()=>setHistorySlug(r.slug)}>{r.name}　推移</button></td><td>{r.peakViewers.toLocaleString("ja-JP")}</td><td>{r.bestRank??"不明"}</td><td>{r.samples}</td></tr>)}</tbody></table></div></>}
      </>}
    </div>
    <p className="ranking-caption">視聴者増加数は前回取得からの増減です。チャット投稿数や全期間の記録ではありません。通常・追っかけ録画を選択可能です。追っかけ録画はサーバーに残る映像のみ取得を試行します。</p>
  </section>;
}
