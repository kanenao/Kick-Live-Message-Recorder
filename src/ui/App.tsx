import { useMemo, useState } from "react";

type Channel = { id: number; name: string; url: string; mode: "auto" | "manual"; status: "監視中" | "待機中"; recording: boolean };
type Recording = { id: number; channel: string; title: string; started: string; duration: string; status: string };

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([
    { id: 1, name: "sample_channel", url: "https://kick.com/sample_channel", mode: "auto", status: "待機中", recording: false }
  ]);
  const [recordings] = useState<Recording[]>([]);
  const [newChannel, setNewChannel] = useState("");
  const [tab, setTab] = useState<"dashboard" | "library" | "settings">("dashboard");
  const activeCount = useMemo(() => channels.filter(c => c.recording).length, [channels]);

  function addChannel() {
    const raw = newChannel.trim().replace(/^https?:\/\/(www\.)?kick\.com\//i, "").replace(/\/$/, "");
    if (!raw || !/^[a-zA-Z0-9_]+$/.test(raw) || channels.some(c => c.name.toLowerCase() === raw.toLowerCase())) return;
    setChannels(prev => [...prev, { id: Date.now(), name: raw, url: `https://kick.com/${raw}`, mode: "auto", status: "待機中", recording: false }]);
    setNewChannel("");
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>Kick Recorder</strong><small>LIVE ARCHIVER</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> 初期セットアップ中<small>Version 0.1.0-alpha</small></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">KICK STREAM MANAGER</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "library" ? "録画ライブラリ" : "設定"}</h1></div><div className="top-actions"><span className="connection"><i /> 接続機能準備中</span><div className="avatar">KR</div></div></header>
      {tab === "dashboard" && <>
        <section className="stats">
          <div className="stat-card"><span>登録チャンネル</span><strong>{channels.length.toString().padStart(2,"0")}</strong><small>監視対象</small></div>
          <div className="stat-card"><span>録画中</span><strong>{activeCount.toString().padStart(2,"0")}</strong><small>現在のセッション</small></div>
          <div className="stat-card"><span>保存済み録画</span><strong>{recordings.length.toString().padStart(2,"0")}</strong><small>このPC内</small></div>
          <div className="stat-card accent"><span>保存データ</span><strong>--</strong><small>容量集計は今後実装</small></div>
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>チャンネル管理</h2><p>録画・監視したいKickチャンネルを登録</p></div><span className="count-pill">{channels.length} CHANNELS</span></div>
          <div className="add-channel"><input value={newChannel} onChange={e => setNewChannel(e.target.value)} onKeyDown={e => e.key === "Enter" && addChannel()} placeholder="チャンネル名 または kick.com のURL" /><button onClick={addChannel}>＋ 追加する</button></div>
          <div className="channel-list">{channels.map(c => <div className="channel-row" key={c.id}><div className="channel-icon">{c.name.slice(0,1).toUpperCase()}</div><div className="channel-info"><strong>{c.name}</strong><small>{c.url}</small></div><span className="mode-tag">{c.mode === "auto" ? "自動録画" : "手動録画"}</span><span className="waiting"><i /> {c.status}</span><button className="small-action" onClick={() => setChannels(prev => prev.map(x => x.id === c.id ? {...x, mode: x.mode === "auto" ? "manual" : "auto"} : x))}>方式変更</button><button className="remove" aria-label="削除" onClick={() => setChannels(prev => prev.filter(x => x.id !== c.id))}>×</button></div>)}</div>
          <div className="notice">現在は画面・登録データの操作確認用です。Kick接続、実際の録画、チャット取得は次の開発段階で実装します。</div>
        </section>
        <section className="panel lower-panel"><div className="panel-heading"><div><h2>最近の録画</h2><p>保存された配信がここに表示されます</p></div><button className="text-button" onClick={() => setTab("library")}>すべて見る →</button></div><div className="empty-state"><div className="empty-icon">▣</div><strong>録画はまだありません</strong><span>チャンネルを登録して、配信の録画を始めましょう。</span></div></section>
      </>}
      {tab === "library" && <section className="panel"><div className="panel-heading"><div><h2>録画ライブラリ</h2><p>配信映像とチャットの保存履歴</p></div></div><div className="empty-state"><div className="empty-icon">▤</div><strong>保存された録画はありません</strong><span>録画機能を実装すると、ここで検索・再生できます。</span></div></section>}
      {tab === "settings" && <section className="panel"><div className="panel-heading"><div><h2>基本設定</h2><p>保存先や録画動作の設定</p></div></div><div className="setting-row"><div><strong>自動録画</strong><small>配信開始を検知したら自動で録画する機能</small></div><span className="mode-tag">実装予定</span></div><div className="setting-row"><div><strong>チャット保存</strong><small>配信中のチャットを時刻付きで記録</small></div><span className="mode-tag">実装予定</span></div><div className="setting-row"><div><strong>保存先</strong><small>録画ファイルとデータベースの保存フォルダ</small></div><span className="mode-tag">実装予定</span></div></section>}
      <footer>Kick Recorder <span>•</span> 開発版 0.1.0-alpha <span>•</span> Made for stream archiving</footer>
    </main>
  </div>;
}