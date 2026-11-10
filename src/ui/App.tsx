import { useEffect, useMemo, useRef, useState } from "react";

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
  ytDlpPath: string;
  ffmpegPath: string;
  autoMonitorEnabled: boolean;
  monitorIntervalSeconds: number;
  notifyOnLive: boolean;
};

type PersistedState = {
  channels: Channel[];
  settings: AppSettings;
};

type ChannelCheck = {
  slug: string;
  found: boolean;
  isLive: boolean;
  streamTitle: string;
  viewerCount: number;
  startedAt: string | null;
};

type RecordingStatus = {
  slug: string;
  status: "starting" | "recording" | "reconnecting" | "stopping" | "stopped" | "error";
  startedAt: string;
  filePath: string;
  progress: string;
  message: string;
  reconnectCount: number;
  exitCode?: number | null;
};

type CommentVideoStatus = {
  status: "idle" | "preparing" | "rendering" | "completed" | "cancelled" | "error";
  message: string;
  progressPercent: number;
  commentCount: number;
  videoPath: string;
  outputPath: string;
  error?: string;
};

type CommentFilePreview = {
  count: number;
  format: string;
  usesExistingAss: boolean;
};

type UpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message: string;
};

const APP_VERSION = "0.1.0-beta.8";
const STORAGE_KEY = "kick-recorder-state-v1";

const DEFAULT_SETTINGS: AppSettings = {
  autoRecordOnStreamStart: true,
  saveChat: true,
  outputDirectory: "",
  ytDlpPath: "",
  ffmpegPath: "",
  autoMonitorEnabled: true,
  monitorIntervalSeconds: 60,
  notifyOnLive: true
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
        /^[a-zA-Z0-9_]{1,25}$/.test(channel.name) &&
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
      outputDirectory: typeof settings.outputDirectory === "string" ? settings.outputDirectory : "",
      ytDlpPath: typeof settings.ytDlpPath === "string" ? settings.ytDlpPath : "",
      ffmpegPath: typeof settings.ffmpegPath === "string" ? settings.ffmpegPath : "",
      autoMonitorEnabled: settings.autoMonitorEnabled !== false,
      monitorIntervalSeconds: typeof settings.monitorIntervalSeconds === "number"
        ? Math.max(30, Math.min(3600, Math.round(settings.monitorIntervalSeconds)))
        : 60,
      notifyOnLive: settings.notifyOnLive !== false
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
  const [tab, setTab] = useState<"dashboard" | "library" | "comments" | "settings">("dashboard");
  const [isReady, setIsReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [appDataDirectory, setAppDataDirectory] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [kickClientId, setKickClientId] = useState("");
  const [kickClientSecret, setKickClientSecret] = useState("");
  const [kickCredentialsConfigured, setKickCredentialsConfigured] = useState(false);
  const [kickEncryptionAvailable, setKickEncryptionAvailable] = useState(false);
  const [kickMessage, setKickMessage] = useState("");
  const [channelChecks, setChannelChecks] = useState<Record<string, ChannelCheck>>({});
  const [isCheckingChannels, setIsCheckingChannels] = useState(false);
  const [lastChannelCheck, setLastChannelCheck] = useState("");
  const [monitorError, setMonitorError] = useState("");
  const [recordingStates, setRecordingStates] = useState<Record<string, RecordingStatus>>({});
  const [recordingError, setRecordingError] = useState("");
  const [commentVideoPath, setCommentVideoPath] = useState("");
  const [commentFilePath, setCommentFilePath] = useState("");
  const [commentOutputPath, setCommentOutputPath] = useState("");
  const [commentFilePreview, setCommentFilePreview] = useState<CommentFilePreview | null>(null);
  const [commentFileError, setCommentFileError] = useState("");
  const [renderStatus, setRenderStatus] = useState<CommentVideoStatus>({
    status: "idle", message: "動画とコメントファイルを選択してください。", progressPercent: 0,
    commentCount: 0, videoPath: "", outputPath: ""
  });
  const [renderOptions, setRenderOptions] = useState({ fontSize: 36, scrollDurationSeconds: 12, includeUsername: true, respectPosition: true });
  const [isStartingRender, setIsStartingRender] = useState(false);
  const previousChecksRef = useRef<Record<string, ChannelCheck>>({});
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    status: "idle",
    currentVersion: APP_VERSION,
    message: "起動時に自動で更新を確認します。"
  });
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const activeCount = useMemo(() => Object.values(recordingStates).filter(s => ["starting", "recording", "reconnecting", "stopping"].includes(s.status)).length, [recordingStates]);

  useEffect(() => {
    let active = true;
    let unsubscribeUpdate: (() => void) | undefined;
    let unsubscribeRecording: (() => void) | undefined;
    let unsubscribeCommentVideo: (() => void) | undefined;
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
      unsubscribeUpdate = window.kickRecorder.onUpdateStatus(status => {
        if (active) setUpdateStatus(status);
      });
      unsubscribeRecording = window.kickRecorder.onRecordingStatus(status => {
        if (active) setRecordingStates(prev => ({ ...prev, [status.slug.toLowerCase()]: status }));
      });
      unsubscribeCommentVideo = window.kickRecorder.onCommentVideoStatus(status => {
        if (active) setRenderStatus(status);
      });
      void window.kickRecorder.getCommentVideoStatus().then(status => {
        if (active && status) setRenderStatus(status);
      }).catch(() => undefined);
      void window.kickRecorder.getRecordingStatuses().then(statuses => {
        if (!active) return;
        setRecordingStates(Object.fromEntries(statuses.map(status => [status.slug.toLowerCase(), status])));
      }).catch(() => undefined);
      void window.kickRecorder.getAppInfo().then(info => {
        if (!active) return;
        setAppDataDirectory(info.dataDirectory);
        setAppVersion(info.version);
      }).catch(() => undefined);
      void window.kickRecorder.getUpdateStatus().then(status => {
        if (active) setUpdateStatus(status);
      }).catch(() => undefined);
      void window.kickRecorder.getKickCredentialsStatus().then(status => {
        if (!active) return;
        setKickCredentialsConfigured(status.configured);
        setKickEncryptionAvailable(status.encryptionAvailable);
        setKickClientId(status.clientId);
      }).catch(() => undefined);
    }

    return () => {
      active = false;
      unsubscribeUpdate?.();
      unsubscribeRecording?.();
      unsubscribeCommentVideo?.();
    };
  }, []);

  const monitorSlugs = useMemo(
    () => channels.map(channel => channel.name),
    [channels]
  );

  useEffect(() => {
    if (
      !isReady ||
      !isDesktop ||
      !kickCredentialsConfigured ||
      !settings.autoMonitorEnabled ||
      monitorSlugs.length === 0 ||
      !window.kickRecorder
    ) return;

    let stopped = false;
    let running = false;

    const runAutomaticCheck = async () => {
      if (running || stopped || !window.kickRecorder) return;
      running = true;
      try {
        const results = await window.kickRecorder.checkKickChannels(monitorSlugs);
        if (stopped) return;

        const nextChecks = Object.fromEntries(
          results.map(result => [result.slug.toLowerCase(), result])
        );
        const previousChecks = previousChecksRef.current;

        for (const result of results) {
          const previous = previousChecks[result.slug.toLowerCase()];
          if (
            settings.notifyOnLive &&
            result.found &&
            result.isLive &&
            previous?.found &&
            !previous.isLive
          ) {
            void window.kickRecorder.notifyLive(result.slug).catch(() => undefined);
          }
          const registeredChannel = channels.find(channel => channel.name.toLowerCase() === result.slug.toLowerCase());
          if (
            settings.autoRecordOnStreamStart &&
            settings.ytDlpPath.trim() &&
            registeredChannel?.mode === "auto" &&
            result.found &&
            result.isLive &&
            previous?.found &&
            !previous.isLive
          ) {
            void window.kickRecorder.startRecording(result.slug).then(status => {
              setRecordingStates(prev => ({ ...prev, [result.slug.toLowerCase()]: status }));
            }).catch(error => {
              setRecordingError(error instanceof Error ? error.message : `${result.slug} の自動録画を開始できませんでした。`);
            });
          }
        }

        previousChecksRef.current = nextChecks;
        setChannelChecks(nextChecks);
        setLastChannelCheck(new Date().toLocaleString("ja-JP"));
        setMonitorError("");
      } catch (error) {
        if (!stopped) {
          setMonitorError(error instanceof Error ? error.message : "自動監視でエラーが発生しました。次回の確認時に再試行します。");
        }
      } finally {
        running = false;
      }
    };

    void runAutomaticCheck();
    const interval = Math.max(30, Math.min(3600, settings.monitorIntervalSeconds)) * 1000;
    const timer = window.setInterval(() => void runAutomaticCheck(), interval);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    isReady,
    isDesktop,
    kickCredentialsConfigured,
    settings.autoMonitorEnabled,
    settings.monitorIntervalSeconds,
    settings.notifyOnLive,
    monitorSlugs
  ]);

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
    if (!raw || !/^[a-zA-Z0-9_]{1,25}$/.test(raw) || channels.some(c => c.name.toLowerCase() === raw.toLowerCase())) return;

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

  async function saveKickApiCredentials() {
    if (!window.kickRecorder) return;
    if (!kickClientId.trim() || !kickClientSecret) {
      setKickMessage("クライアントIDとクライアントシークレットを入力してください。");
      return;
    }
    try {
      const result = await window.kickRecorder.saveKickCredentials({
        clientId: kickClientId.trim(),
        clientSecret: kickClientSecret
      });
      setKickClientId(result.clientId);
      setKickClientSecret("");
      setKickCredentialsConfigured(true);
      setKickMessage("Kick APIの認証情報を暗号化して保存しました。");
    } catch (error) {
      setKickMessage(error instanceof Error ? error.message : "認証情報を保存できませんでした。");
    }
  }

  async function clearKickApiCredentials() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.clearKickCredentials();
      setKickClientId("");
      setKickClientSecret("");
      setKickCredentialsConfigured(false);
      setChannelChecks({});
      previousChecksRef.current = {};
      setKickMessage("Kick APIの認証情報を削除しました。");
    } catch {
      setKickMessage("認証情報を削除できませんでした。");
    }
  }

  async function refreshChannelStatuses() {
    if (!window.kickRecorder) {
      setKickMessage("Kick APIの確認にはWindowsデスクトップ版が必要です。");
      return;
    }
    if (channels.length === 0) {
      setKickMessage("先にチャンネルを登録してください。");
      return;
    }
    if (!kickCredentialsConfigured) {
      setKickMessage("設定画面でKick APIのClient IDとClient Secretを登録してください。");
      setTab("settings");
      return;
    }

    setIsCheckingChannels(true);
    setKickMessage("");
    try {
      const results = await window.kickRecorder.checkKickChannels(channels.map(channel => channel.name));
      const nextChecks = Object.fromEntries(results.map(result => [result.slug.toLowerCase(), result]));
      previousChecksRef.current = nextChecks;
      setChannelChecks(nextChecks);
      setLastChannelCheck(new Date().toLocaleString("ja-JP"));
      setMonitorError("");
      setKickMessage("Kick公式APIから配信状態を更新しました。");
    } catch (error) {
      setKickMessage(error instanceof Error ? error.message : "配信状態を取得できませんでした。");
      setMonitorError(error instanceof Error ? error.message : "配信状態を取得できませんでした。");
    } finally {
      setIsCheckingChannels(false);
    }
  }


  async function checkForAppUpdates() {
    if (!window.kickRecorder) {
      setUpdateStatus(prev => ({ ...prev, status: "error", message: "更新確認はWindowsデスクトップ版で利用できます。" }));
      return;
    }
    setIsCheckingUpdates(true);
    try {
      const status = await window.kickRecorder.checkForUpdates();
      setUpdateStatus(status);
    } catch (error) {
      setUpdateStatus(prev => ({
        ...prev,
        status: "error",
        message: error instanceof Error ? error.message : "更新を確認できませんでした。"
      }));
    } finally {
      setIsCheckingUpdates(false);
    }
  }

  async function installAppUpdate() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.installUpdate();
    } catch (error) {
      setUpdateStatus(prev => ({
        ...prev,
        status: "error",
        message: error instanceof Error ? error.message : "更新を適用できませんでした。"
      }));
    }
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

  async function chooseYtDlp() {
    if (!window.kickRecorder) return;
    try {
      const filePath = await window.kickRecorder.selectYtDlp();
      if (filePath) setSettings(prev => ({ ...prev, ytDlpPath: filePath }));
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "yt-dlp.exeを選択できませんでした。");
    }
  }

  async function chooseFfmpeg() {
    if (!window.kickRecorder) return;
    try {
      const filePath = await window.kickRecorder.selectFfmpeg();
      if (filePath) setSettings(prev => ({ ...prev, ffmpegPath: filePath }));
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "ffmpeg.exeを選択できませんでした。");
    }
  }

  async function chooseCommentVideo() {
    if (!window.kickRecorder) return;
    setCommentFileError("");
    try {
      const filePath = await window.kickRecorder.selectCommentVideo();
      if (filePath) {
        setCommentVideoPath(filePath);
        setCommentOutputPath("");
      }
    } catch (error) {
      setCommentFileError(error instanceof Error ? error.message : "元動画を選択できませんでした。");
    }
  }

  async function chooseCommentFile() {
    if (!window.kickRecorder) return;
    setCommentFileError("");
    setCommentFilePreview(null);
    try {
      const filePath = await window.kickRecorder.selectCommentFile();
      if (!filePath) return;
      setCommentFilePath(filePath);
      const preview = await window.kickRecorder.previewCommentFile(filePath);
      setCommentFilePreview(preview);
    } catch (error) {
      setCommentFilePath("");
      setCommentFileError(error instanceof Error ? error.message : "コメントファイルを読み込めませんでした。");
    }
  }

  async function chooseCommentOutput() {
    if (!window.kickRecorder || !commentVideoPath) return;
    setCommentFileError("");
    try {
      const filePath = await window.kickRecorder.selectCommentVideoOutput(commentVideoPath);
      if (filePath) setCommentOutputPath(filePath);
    } catch (error) {
      setCommentFileError(error instanceof Error ? error.message : "出力先を選択できませんでした。");
    }
  }

  async function startCommentVideoRender() {
    if (!window.kickRecorder || !commentVideoPath || !commentFilePath || !commentOutputPath) return;
    setIsStartingRender(true);
    setCommentFileError("");
    try {
      const status = await window.kickRecorder.renderCommentVideo({
        videoPath: commentVideoPath,
        commentsPath: commentFilePath,
        outputPath: commentOutputPath,
        ...renderOptions
      });
      setRenderStatus(status);
    } catch (error) {
      setCommentFileError(error instanceof Error ? error.message : "コメント付き動画を生成できませんでした。");
    } finally {
      setIsStartingRender(false);
    }
  }

  async function cancelCommentVideoRender() {
    if (!window.kickRecorder) return;
    try {
      const status = await window.kickRecorder.cancelCommentVideo();
      if (status) setRenderStatus(status);
    } catch (error) {
      setCommentFileError(error instanceof Error ? error.message : "動画生成をキャンセルできませんでした。");
    }
  }

  async function startRecording(slug: string) {
    if (!window.kickRecorder) return;
    setRecordingError("");
    try {
      const status = await window.kickRecorder.startRecording(slug);
      setRecordingStates(prev => ({ ...prev, [slug.toLowerCase()]: status }));
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : `${slug} の録画を開始できませんでした。`);
    }
  }

  async function stopRecording(slug: string) {
    if (!window.kickRecorder) return;
    try {
      const status = await window.kickRecorder.stopRecording(slug);
      if (status) setRecordingStates(prev => ({ ...prev, [slug.toLowerCase()]: status }));
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : `${slug} の録画を停止できませんでした。`);
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>Kick Live Message Recorder</strong><small>配信・チャット保存</small></div></div>
      <div className="nav-label">メインメニュー</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> β版・開発テスト中<small>現在のバージョン {appVersion}</small></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="eyebrow">Kick 配信管理ツール</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "library" ? "録画ライブラリ" : "設定"}</h1></div>
        <div className="top-actions"><span className="connection"><i /> {isDesktop ? "Windows デスクトップ版" : "ブラウザー版プレビュー"}</span><span className="beta-tag">β版</span><div className="avatar">KR</div></div>
      </header>

      {storageError && <div className="storage-error" role="alert">{storageError}</div>}

      {tab === "dashboard" && <>
        <section className="stats">
          <div className="stat-card"><span>登録チャンネル</span><strong>{channels.length.toString().padStart(2,"0")}</strong><small>監視対象</small></div>
          <div className="stat-card"><span>録画中</span><strong>{activeCount.toString().padStart(2,"0")}</strong><small>現在のセッション</small></div>
          <div className="stat-card"><span>保存済み録画</span><strong>00</strong><small>このPC内</small></div>
          <div className="stat-card accent"><span>現在のバージョン</span><strong className="version-value">{appVersion}</strong><small>{isReady ? "インストール済み" : "起動情報を読み込み中"}</small></div>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><h2>チャンネル管理</h2><p>録画・監視したいKickチャンネルを登録</p></div><div className="panel-heading-actions"><span className="count-pill">登録数：{channels.length}件</span><button className="small-action refresh-button" onClick={() => void refreshChannelStatuses()} disabled={!isDesktop || isCheckingChannels || channels.length === 0}>{isCheckingChannels ? "確認中..." : "配信状態を更新"}</button></div></div>
          <div className="add-channel">
            <input value={newChannel} onChange={e => setNewChannel(e.target.value)} onKeyDown={e => e.key === "Enter" && addChannel()} placeholder="チャンネル名 または kick.com のURL" aria-label="Kickチャンネル名またはURL" />
            <button onClick={addChannel}>＋ 追加する</button>
          </div>
          <div className="channel-list">
            {channels.length === 0 && <div className="empty-inline">まだチャンネルが登録されていません。</div>}
            {channels.map(c => <div className="channel-row" key={c.id}>
              <div className="channel-icon">{c.name.slice(0,1).toUpperCase()}</div>
              <div className="channel-info">
                <strong>{c.name}</strong><small>{c.url}</small>
                {recordingStates[c.name.toLowerCase()] && <small className={recordingStates[c.name.toLowerCase()].status === "error" ? "recording-status error" : "recording-status"}>{recordingStates[c.name.toLowerCase()].message}{recordingStates[c.name.toLowerCase()].progress ? ` · ${recordingStates[c.name.toLowerCase()].progress}` : ""}</small>}
              </div>
              <span className="mode-tag">{c.mode === "auto" ? "自動録画" : "手動録画"}</span>
              <span className={channelChecks[c.name.toLowerCase()]?.found
                ? (channelChecks[c.name.toLowerCase()].isLive ? "live-status live" : "live-status offline")
                : (channelChecks[c.name.toLowerCase()] ? "live-status missing" : "live-status unknown")}>
                {channelChecks[c.name.toLowerCase()]?.found
                  ? (channelChecks[c.name.toLowerCase()].isLive ? `配信中 · ${channelChecks[c.name.toLowerCase()].viewerCount.toLocaleString("ja-JP")}人` : "オフライン")
                  : (channelChecks[c.name.toLowerCase()] ? "チャンネル未検出" : "未確認")}
              </span>
              {["starting", "recording", "reconnecting", "stopping"].includes(recordingStates[c.name.toLowerCase()]?.status ?? "")
                ? <button className="small-action stop-record-button" onClick={() => void stopRecording(c.name)} disabled={recordingStates[c.name.toLowerCase()]?.status === "stopping"}>{recordingStates[c.name.toLowerCase()]?.status === "reconnecting" ? "再接続中・停止" : "録画停止"}</button>
                : <button className="small-action start-record-button" onClick={() => void startRecording(c.name)} disabled={!isDesktop || !channelChecks[c.name.toLowerCase()]?.isLive}>録画開始</button>}
              <button className="small-action" onClick={() => setChannels(prev => prev.map(x => x.id === c.id ? {...x, mode: x.mode === "auto" ? "manual" : "auto"} : x))}>録画方式を変更</button>
              <button className="remove" aria-label={`${c.name}を削除`} onClick={() => setChannels(prev => prev.filter(x => x.id !== c.id))}>×</button>
            </div>)}
          </div>
          {recordingError && <div className="storage-error">{recordingError}</div>}
          <div className="notice">手動録画は配信中のチャンネルで「録画開始」を押してください。自動録画は配信開始を次回監視で検出したときに開始します。チャット保存は引き続き開発中です。{lastChannelCheck && ` 最終確認：${lastChannelCheck}`}</div>
        </section>

        <section className="panel lower-panel">
          <div className="panel-heading"><div><h2>最近の録画</h2><p>保存された配信がここに表示されます</p></div><button className="text-button" onClick={() => setTab("library")}>すべて見る →</button></div>
          <div className="empty-state"><div className="empty-icon">▣</div><strong>保存済み録画の一覧は未実装です</strong><span>録画ファイルは設定した保存先のチャンネル別フォルダーに保存されます。</span></div>
        </section>
      </>}

      {tab === "library" && <section className="panel">
        <div className="panel-heading"><div><h2>録画ライブラリ</h2><p>配信映像とチャットの保存履歴</p></div></div>
        <div className="empty-state"><div className="empty-icon">▤</div><strong>録画ライブラリは次の段階で実装します</strong><span>録画ファイルは保存先フォルダーから直接確認できます。</span></div>
      </section>}

      {tab === "settings" && <section className="panel">
        <div className="panel-heading"><div><h2>基本設定</h2><p>β版の録画動作・保存先の設定</p></div></div>
        <div className="setting-row">
          <div><strong>配信開始時に自動録画</strong><small>自動録画モードのチャンネルで、配信開始を検出したとき録画を開始します</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "有効" : "無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>チャットを保存</strong><small>チャットの取得・保存機能はまだ実装されていません</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.saveChat} onChange={e => setSettings(prev => ({ ...prev, saveChat: e.target.checked }))} /><span>{settings.saveChat ? "有効" : "無効"}</span></label>
        </div>

        <div className="settings-subsection">
          <div className="settings-subheading"><h3>録画エンジン（yt-dlp / FFmpeg）</h3><span className={settings.ytDlpPath ? "api-state connected" : "api-state"}>{settings.ytDlpPath ? "yt-dlp設定済み" : "未設定"}</span></div>
          <p className="settings-help">録画には外部ツールが必要です。yt-dlp.exeを必須設定し、映像・音声の結合が必要な配信ではFFmpegを利用します。ツールは同梱していません。公式配布元から取得し、利用条件・ライセンスを確認してください。</p>
          <div className="setting-row"><div><strong>yt-dlp.exe（必須）</strong><small>{settings.ytDlpPath || "未選択"}</small></div><button className="small-action" onClick={() => void chooseYtDlp()} disabled={!isDesktop}>実行ファイルを選択</button></div>
          <div className="setting-row"><div><strong>ffmpeg.exe（推奨）</strong><small>{settings.ffmpegPath || "未選択（PATH上のFFmpegを使用）"}</small></div><div className="folder-picker"><button className="small-action" onClick={() => void chooseFfmpeg()} disabled={!isDesktop}>実行ファイルを選択</button><button className="small-action" onClick={() => setSettings(prev => ({ ...prev, ffmpegPath: "" }))} disabled={!settings.ffmpegPath}>解除</button></div></div>
          <div className="settings-help">yt-dlp公式配布：github.com/yt-dlp/yt-dlp/releases ／ FFmpeg公式サイト：ffmpeg.org</div>
        </div>

        <div className="settings-subsection monitor-settings">
          <div className="settings-subheading">
            <h3>配信の自動監視（KickChecker参考）</h3>
            <span className={settings.autoMonitorEnabled ? "api-state connected" : "api-state"}>{settings.autoMonitorEnabled ? "自動監視：有効" : "自動監視：停止中"}</span>
          </div>
          <div className="setting-row">
            <div><strong>登録チャンネルを自動で確認</strong><small>アプリ起動中にKick公式APIで配信状態を定期確認します</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoMonitorEnabled} onChange={e => setSettings(prev => ({ ...prev, autoMonitorEnabled: e.target.checked }))} /><span>{settings.autoMonitorEnabled ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>監視間隔</strong><small>短くするとAPIへの問い合わせ回数が増えます</small></div>
            <select className="setting-select" value={settings.monitorIntervalSeconds} onChange={e => setSettings(prev => ({ ...prev, monitorIntervalSeconds: Number(e.target.value) }))}>
              <option value={30}>30秒</option>
              <option value={60}>1分</option>
              <option value={120}>2分</option>
              <option value={300}>5分</option>
              <option value={600}>10分</option>
            </select>
          </div>
          <div className="setting-row">
            <div><strong>配信開始をWindows通知で知らせる</strong><small>前回オフラインで、今回配信中になった場合に通知します</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.notifyOnLive} onChange={e => setSettings(prev => ({ ...prev, notifyOnLive: e.target.checked }))} /><span>{settings.notifyOnLive ? "有効" : "無効"}</span></label>
          </div>
          <div className="monitor-status-line">
            {isDesktop && kickCredentialsConfigured && settings.autoMonitorEnabled
              ? `監視中 · ${settings.monitorIntervalSeconds}秒ごと`
              : (!isDesktop ? "Windowsデスクトップ版で利用できます" : (!kickCredentialsConfigured ? "Kick APIの認証情報を登録してください" : "自動監視は停止中"))}
            {lastChannelCheck && ` · 最終確認：${lastChannelCheck}`}
          </div>
          {monitorError && <div className="storage-error monitor-error">自動監視エラー：{monitorError} 次回の確認時に再試行します。</div>}
        </div>
        <div className="setting-row">
          <div><strong>録画・データの保存先</strong><small>{settings.outputDirectory || "未指定（初期設定の保存場所を使用）"}</small></div>
          <div className="folder-picker">
            <button className="small-action" onClick={() => void chooseOutputDirectory()} disabled={!isDesktop}>フォルダーを選択</button>
          </div>
        </div>

        <div className="settings-subsection updater-panel">
          <div className="settings-subheading">
            <h3>アプリ情報・自動更新</h3>
            <span className="api-state connected">自動確認：有効</span>
          </div>
          <div className="version-row">
            <span>現在のバージョン</span>
            <strong>{appVersion}</strong>
          </div>
          <div className="update-description">{updateStatus.message}</div>
          {(updateStatus.status === "downloading" || updateStatus.status === "available") && <div className="update-progress"><div className="update-progress-fill" style={{ width: `${updateStatus.percent ?? 0}%` }} /></div>}
          {updateStatus.availableVersion && <div className="update-version">新しいバージョン：{updateStatus.availableVersion}</div>}
          <div className="update-actions">
            <button className="primary-small" onClick={() => void checkForAppUpdates()} disabled={!isDesktop || isCheckingUpdates || updateStatus.status === "downloading"}>{isCheckingUpdates || updateStatus.status === "checking" ? "確認中..." : "今すぐ更新を確認"}</button>
            {updateStatus.status === "downloaded" && <button className="primary-small" onClick={() => void installAppUpdate()}>再起動して更新</button>}
          </div>
          <p className="settings-help">起動時と6時間ごとに新しいバージョンを確認します。更新が見つかると自動でダウンロードし、アプリ終了時に適用します。更新の適用にはアプリの再起動が必要です。</p>
          {!isDesktop && <div className="notice">自動更新はWindowsデスクトップ版をインストールして利用してください。</div>}
        </div>

        <div className="settings-subsection">
          <div className="settings-subheading">
            <h3>Kick API接続</h3>
            <span className={kickCredentialsConfigured ? "api-state connected" : "api-state"}>{kickCredentialsConfigured ? "認証情報登録済み" : "未設定"}</span>
          </div>
          <p className="settings-help">Kick Developerで作成したアプリのClient IDとClient Secretを入力します。SecretはWindowsの暗号化機能で保護し、画面側やログには保存しません。</p>
          <label className="credential-field">クライアントID
            <input value={kickClientId} onChange={event => setKickClientId(event.target.value)} placeholder="Kick DeveloperのクライアントID" autoComplete="off" disabled={!isDesktop} />
          </label>
          <label className="credential-field">クライアントシークレット
            <input type="password" value={kickClientSecret} onChange={event => setKickClientSecret(event.target.value)} placeholder={kickCredentialsConfigured ? "保存済み（変更する場合のみ入力）" : "Kick Developerのクライアントシークレット"} autoComplete="new-password" disabled={!isDesktop} />
          </label>
          <div className="credential-actions">
            <button className="primary-small" onClick={() => void saveKickApiCredentials()} disabled={!isDesktop || !kickEncryptionAvailable}>認証情報を保存</button>
            <button className="small-action" onClick={() => void clearKickApiCredentials()} disabled={!isDesktop || !kickCredentialsConfigured}>認証情報を削除</button>
          </div>
          {kickMessage && <div className="api-message" role="status">{kickMessage}</div>}
          {!isDesktop && <div className="notice">Kick APIの認証情報登録はWindowsデスクトップ版で利用できます。</div>}
          {isDesktop && !kickEncryptionAvailable && <div className="storage-error">Windowsの暗号化ストレージが利用できないため、認証情報は保存できません。</div>}
        </div>
        {appDataDirectory && <div className="data-path-note">アプリ設定データ: {appDataDirectory}</div>}
        {!isDesktop && <div className="notice">保存先フォルダーの選択はWindowsデスクトップ版で利用できます。ブラウザープレビューでは設定をブラウザー内に保存します。</div>}
      </section>}

      <footer>Kick Live Message Recorder <span>•</span> β版 {appVersion} <span>•</span> 日本語版</footer>
    </main>
  </div>;
}
