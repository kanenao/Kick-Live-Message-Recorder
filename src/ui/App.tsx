import { useEffect, useMemo, useState } from "react";

type Channel = {
  id: number;
  name: string;
  url: string;
  mode: "auto" | "manual";
  status: "監視中" | "待機中";
  recording: boolean;
};

type AppSettings = {
  autoRecordOnStreamStart: boolean;
  saveChat: boolean;
  outputDirectory: string;
};

type PersistedState = {
  channels: Channel[];
  settings: AppSettings;
};

const APP_VERSION = "0.1.0-beta.1";
const STORAGE_KEY = "kick-recorder-state-v1";

const DEFAULT_SETTINGS: AppSettings = {
  autoRecordOnStreamStart: true,
  saveChat: true,
  outputDirectory: ""
};

function normalizeState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") {
    return { channels: [], settings: DEFAULT_SETTINGS };
  }

  const source = value as Partial<PersistedState>;
  const channels = Array.isArray(source.channels)
    ? source.channels.filter((channel): channel is Channel =>
        Boolean(channel) &&
        typeof channel === "object" &&
        typeof channel.id === "number" &&
        typeof channel.name === "string" &&
        /^[a-zA-Z0-9_]+$/.test(channel.name) &&
        (channel.mode === "auto" || channel.mode === "manual")
      ).map(channel => ({
        id: channel.id,
        name: channel.name,
        url: `https://kick.com/${channel.name}`,
        mode: channel.mode,
        status: "待機中" as const,
        recording: false
      }))
    : [];

  const settings = source.settings ?? DEFAULT_SETTINGS;
  return {
    channels,
    settings: {
      autoRecordOnStreamStart: settings.autoRecordOnStreamStart !== false,
      saveChat: settings.saveChat !== false,
      outputDirectory: typeof settings.outputDirectory === "string" ? settings.outputDirectory : ""
    }
  };
}

async function loadState(): Promise<PersistedState> {
  if (window.kickRecorder) {
    return normalizeState(await window.kickRecorder.loadState());
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw) as unknown) : { channels: [], settings: DEFAULT_SETTINGS };
  } catch {
    return { channels: [], settings: DEFAULT_SETTINGS };
  }
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [newChannel, setNewChannel] = useState("");
  const [tab, setTab] = useState<"dashboard" | "library" | "settings">("dashboard");
  const [isReady, setIsReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [appDataDirectory, setAppDataDirectory] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const activeCount = useMemo(() => channels.filter(c => c.recording).length, [channels]);

  useEffect(() => {
    let active = true;
    void loadState().then(state => {
      if (!active) return;
      setChannels(state.channels);
      setSettings(state.settings);
    }).catch(() => {
      if (active) setStorageError("保存データを読み込めませんでした。");
    }).finally(() => {
      if (active) setIsReady(true);
    });

    if (window.kickRecorder) {
      setIsDesktop(true);
      void window.kickRecorder.getAppInfo().then(info => {
        if (active) setAppDataDirectory(info.dataDirectory);
      }).catch(() => undefined);
    }

    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const state: PersistedState = { channels, settings };
    if (window.kickRecorder) {
      void window.kickRecorder.saveState(state).then(() => {
        setStorageError("");
      }).catch(() => {
        setStorageError("設定を保存できませんでした。アプリを再起動する前に確認してください。");
      });
      return;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setStorageError("");
    } catch {
      setStorageError("ブラウザー内に設定を保存できませんでした。");
    }
  }, [channels, settings, isReady]);

  function addChannel() {
    const raw = newChannel.trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
      .split(/[/?#]/)[0]
      .replace(/\/$/, "");
    if (!raw || !/^[a-zA-Z0-9_]+$/.test(raw) || channels.some(c => c.name.toLowerCase() === raw.toLowerCase())) return;

    setChannels(prev => [...prev, {
      id: Date.now(),
      name: raw,
      url: `https://kick.com/${raw}`,
      mode: "auto",
      status: "待機中",
      recording: false
    }]);
    setNewChannel("");
  }

  async function chooseOutputDirectory() {
    if (!window.kickRecorder) return;
    try {
      const directory = await window.kickRecorder.selectOutputDirectory();
      if (directory) setSettings(prev => ({ ...prev, outputDirectory: directory }));
    } catch {
      setStorageError("保存先フォルダーを選択できませんでした。");
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>Kick Recorder</strong><small>LIVE ARCHIVER</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> β版・開発テスト中<small>Version {APP_VERSION}</small></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="eyebrow">KICK STREAM MANAGER</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "library" ? "録画ライブラリ" : "設定"}</h1></div>
        <div className="top-actions"><span className="connection"><i /> {isDesktop ? "デスクトップ版" : "ブラウザープレビュー"}</span><span className="beta-tag">BETA</span><div className="avatar">KR</div></div>
      </header>

      {storageError && <div className="storage-error" role="alert">{storageError}</div>}

      {tab === "dashboard" && <>
        <section className="stats">
          <div className="stat-card"><span>登録チャンネル</span><strong>{channels.length.toString().padStart(2,"0")}</strong><small>監視対象</small></div>
          <div className="stat-card"><span>録画中</span><strong>{activeCount.toString().padStart(2,"0")}</strong><small>現在のセッション</small></div>
          <div className="stat-card"><span>保存済み録画</span><strong>00</strong><small>このPC内</small></div>
          <div className="stat-card accent"><span>バージョン</span><strong>β 1</strong><small>{isReady ? "設定の読み込み完了" : "設定を読み込み中"}</small></div>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><h2>チャンネル管理</h2><p>録画・監視したいKickチャンネルを登録</p></div><span className="count-pill">{channels.length} CHANNELS</span></div>
          <div className="add-channel">
            <input value={newChannel} onChange={e => setNewChannel(e.target.value)} onKeyDown={e => e.key === "Enter" && addChannel()} placeholder="チャンネル名 または kick.com のURL" aria-label="Kickチャンネル名またはURL" />
            <button onClick={addChannel}>＋ 追加する</button>
          </div>
          <div className="channel-list">
            {channels.length === 0 && <div className="empty-inline">まだチャンネルが登録されていません。</div>}
            {channels.map(c => <div className="channel-row" key={c.id}>
              <div className="channel-icon">{c.name.slice(0,1).toUpperCase()}</div>
              <div className="channel-info"><strong>{c.name}</strong><small>{c.url}</small></div>
              <span className="mode-tag">{c.mode === "auto" ? "自動録画" : "手動録画"}</span>
              <span className="waiting"><i /> {c.status}</span>
              <button className="small-action" onClick={() => setChannels(prev => prev.map(x => x.id === c.id ? {...x, mode: x.mode === "auto" ? "manual" : "auto"} : x))}>方式変更</button>
              <button className="remove" aria-label={`${c.name}を削除`} onClick={() => setChannels(prev => prev.filter(x => x.id !== c.id))}>×</button>
            </div>)}
          </div>
          <div className="notice">β版の準備段階です。チャンネル登録と設定の保存が利用できます。Kick接続・実際の録画・チャット取得は次の更新で実装します。</div>
        </section>

        <section className="panel lower-panel">
          <div className="panel-heading"><div><h2>最近の録画</h2><p>保存された配信がここに表示されます</p></div><button className="text-button" onClick={() => setTab("library")}>すべて見る →</button></div>
          <div className="empty-state"><div className="empty-icon">▣</div><strong>録画はまだありません</strong><span>録画機能は今後のアップデートで追加します。</span></div>
        </section>
      </>}

      {tab === "library" && <section className="panel">
        <div className="panel-heading"><div><h2>録画ライブラリ</h2><p>配信映像とチャットの保存履歴</p></div></div>
        <div className="empty-state"><div className="empty-icon">▤</div><strong>保存された録画はありません</strong><span>録画機能を実装すると、ここで検索・再生できます。</span></div>
      </section>}

      {tab === "settings" && <section className="panel">
        <div className="panel-heading"><div><h2>基本設定</h2><p>β版の録画動作・保存先の設定</p></div></div>
        <div className="setting-row">
          <div><strong>配信開始時に自動録画</strong><small>自動録画モードのチャンネルで使用します（録画機能は開発中）</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "ON" : "OFF"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>チャットを保存</strong><small>配信映像とチャットを一緒に保存する機能の設定</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.saveChat} onChange={e => setSettings(prev => ({ ...prev, saveChat: e.target.checked }))} /><span>{settings.saveChat ? "ON" : "OFF"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>録画・データの保存先</strong><small>{settings.outputDirectory || "未指定（初期設定の保存場所を使用）"}</small></div>
          <div className="folder-picker">
            <button className="small-action" onClick={() => void chooseOutputDirectory()} disabled={!isDesktop}>フォルダーを選択</button>
          </div>
        </div>
        {appDataDirectory && <div className="data-path-note">アプリ設定データ: {appDataDirectory}</div>}
        {!isDesktop && <div className="notice">保存先フォルダーの選択はWindowsデスクトップ版で利用できます。ブラウザープレビューでは設定をブラウザー内に保存します。</div>}
      </section>}

      <footer>Kick Recorder <span>•</span> β版 {APP_VERSION} <span>•</span> Made for stream archiving</footer>
    </main>
  </div>;
}
