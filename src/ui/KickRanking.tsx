import {useEffect,useRef,useState} from "react";
import type {RankingScope,RankingSnapshot} from "../../electron/kick-ranking";
export function KickRanking({configured,desktop,onSettings}:{configured:boolean;desktop:boolean;onSettings:()=>void}){
  const [scope,setScope]=useState<RankingScope>("ja");
  const [snapshots,setSnapshots]=useState<Partial<Record<RankingScope,RankingSnapshot>>>({});
  const [search,setSearch]=useState("");
  const [sort,setSort]=useState<"viewers"|"growth">("viewers");
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
  async function record(slug:string){
    const api=window.kickRecorder;if(!api||locks.current.has(slug))return;
    locks.current.add(slug);setPending([...locks.current]);setMessage("");
    try{
      const actual=await api.listActiveLiveRecordings();
      if(actual.includes(slug))await api.stopRecording(slug);
      else {await api.startRecording(slug);setMessage(slug+"：録画開始を要求しました。");}
      setActive(await api.listActiveLiveRecordings());
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}
    finally{locks.current.delete(slug);setPending([...locks.current]);}
  }
  const snapshot=snapshots[scope];
  const q=search.trim().toLowerCase();
  const entries=(snapshot?.entries??[]).filter(row=>!q||[row.slug,row.name,row.title,row.category].some(value=>value.toLowerCase().includes(q)));
  if(sort==="growth")entries.sort((a,b)=>(b.viewerChange??-Infinity)-(a.viewerChange??-Infinity)||a.rank-b.rank);
  const visible=entries.slice(0,200);
  const elapsed=(date:string|null)=>{if(!date)return "不明";const m=Math.max(0,Math.floor((Date.now()-Date.parse(date))/60000));return Math.floor(m/60)+"時間"+(m%60)+"分";};
  const action=(slug:string)=><button className={active.includes(slug)?"small-action":"primary-small"} disabled={!desktop||pending.includes(slug)} onClick={()=>void record(slug)}>{pending.includes(slug)?"処理中…":active.includes(slug)?"■ 録画停止":"● 録画"}</button>;
  return <section className="panel kick-ranking">
    <div className="panel-heading"><div><h2>リアルタイム同接ランキング</h2><p>Kick公式APIから独自集計。登録していない配信者も直接録画できます。</p></div><span className="count-pill">{snapshot? snapshot.total.toLocaleString()+" 配信取得":"未取得"}</span></div>
    {!configured&&<div className="notice">ランキングにはKick APIの設定が必要です。<button className="small-action" onClick={onSettings}>設定を開く</button></div>}
    <div className="ranking-toolbar"><select aria-label="ランキング範囲" value={scope} onChange={e=>setScope(e.target.value as RankingScope)}><option value="ja">日本語配信</option><option value="all">全世界</option></select><select aria-label="並び順" value={sort} onChange={e=>setSort(e.target.value as "viewers"|"growth")}><option value="viewers">同時視聴者数順</option><option value="growth">視聴者増加数順</option></select><input aria-label="配信検索" placeholder="配信者・タイトル・カテゴリ検索" value={search} onChange={e=>setSearch(e.target.value)}/><label><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> 自動更新（60秒）</label><button className="small-action" disabled={busy||!configured||!desktop} onClick={()=>refreshRef.current()}>{busy?"取得中…":"更新"}</button></div>
    {snapshot&&<div className="ranking-caption">最終取得：{new Date(snapshot.fetchedAt).toLocaleString("ja-JP")} ／ {snapshot.complete?"取得完了":"取得範囲内の暫定ランキング"} ／ 最大500件を保持・200件表示 ／ 順位変動は前回取得との比較{snapshot.excluded>0?" ／ 不明データ "+snapshot.excluded+"件":""}</div>}
    {error&&<div className="notice" role="alert">{error}{snapshot?"（前回取得結果を表示中）":""}</div>}
    {message&&<p className="api-message" role="status">{message}</p>}
    {!!active.length&&<div className="ranking-active"><strong>現在録画中（ランキング圏外も表示）</strong>{active.map(slug=><div key={slug}><span>{slug}</span>{action(slug)}</div>)}</div>}
    {busy&&!snapshot&&<div className="empty-state">ランキングを取得しています…</div>}
    {!busy&&snapshot&&visible.length===0&&<div className="empty-state">条件に一致する配信がありません。</div>}
    <div className="ranking-scroll"><table className="ranking-table"><thead><tr><th>順位</th><th>配信画面</th><th>配信者・番組情報</th><th>同時視聴者</th><th>配信時間</th><th>録画操作</th></tr></thead><tbody>{visible.map(row=><tr key={row.slug}><td><strong className="ranking-rank">{row.rank}</strong><small>{row.rankChange===null?"—":row.rankChange>0?"↑"+row.rankChange:row.rankChange<0?"↓"+Math.abs(row.rankChange):"→"}</small></td><td><button className="ranking-thumb" onClick={()=>void window.kickRecorder?.openKickProfile(row.slug).catch(e=>setMessage(String(e)))} aria-label={row.name+"の配信ページ"}>{row.thumbnail?<img src={row.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer"/>:<span>LIVE</span>}</button></td><td><button className="ranking-name" onClick={()=>void window.kickRecorder?.openKickProfile(row.slug).catch(e=>setMessage(String(e)))}>{row.avatar&&<img src={row.avatar} alt="" loading="lazy" referrerPolicy="no-referrer"/>}{row.name}</button><div className="ranking-title">{row.title}</div><small>{row.category} ・ {row.language||"言語不明"}</small></td><td><strong className="ranking-viewers">{row.viewers.toLocaleString("ja-JP")}</strong><small>{row.viewerChange===null?"比較なし":(row.viewerChange>0?"+":"")+row.viewerChange.toLocaleString("ja-JP")}</small></td><td>{elapsed(row.startedAt)}</td><td>{action(row.slug)}</td></tr>)}</tbody></table></div>
    <p className="ranking-caption">視聴者増加数は前回取得からの増減です。チャット投稿数や全期間の記録ではありません。録画は通常LIVE録画で、コメント取得は既存の設定に従います。</p>
  </section>;
}
