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
  autoReceiveChat: boolean;
  autoReceiveChatForRecordingOnly: boolean;
  saveChat: boolean;
  outputDirectory: string;
  autoMonitorEnabled: boolean;
  monitorIntervalSeconds: number;
  autoRecordRecordingOnlyOnStreamStart: boolean;
  launchAtLogin: boolean;
  preventSystemSleep: boolean;
  recordingRetryCount: number;
  recordingRetryDelaySeconds: number;
  notifyOnLive: boolean;
  showRecordingPreview: boolean;
};

type PersistedState = {
  channels: Channel[];
  recordingOnlyChannels: Channel[];
  settings: AppSettings;
};

type ChannelCheck = {
  slug: string;
  found: boolean;
  isLive: boolean;
  displayName: string;
  profilePicture: string | null;
  broadcasterUserId: number | null;
  streamTitle: string;
  categoryName: string;
  categoryThumbnail: string | null;
  viewerCount: number;
  startedAt: string | null;
};

type BackgroundMonitorStatus = {
  enabled: boolean; running: boolean; monitoredChannels: number; intervalSeconds: number;
  lastCheckAt: string | null; lastError: string; message: string; results: ChannelCheck[];
};

type UpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message: string;
};

type RecordingFile = {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
};

type ChatMessage = {
  eventId: string;
  messageId: string;
  channelSlug: string;
  broadcasterUserId: number | null;
  senderUsername: string;
  senderUserId: number | null;
  content: string;
  createdAt: string;
  receivedAt: string;
  usernameColor: string | null;
  badges: string[];
  emotes: Array<{ emoteId: string; positions: Array<{ start: number; end: number }> }>;
  replyToMessageId: string | null;
};

type ChatReceiverStatus = {
  running: boolean;
  connectedChannels: number;
  messageCount: number;
  lastMessageAt: string | null;
  message: string;
};

type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
  isVod?: boolean;
};
type CommentLogFile = { path: string; name: string; channelSlug: string; kind: "LIVE" | "VOD"; size: number; modifiedAt: string };
type CommentVideoEvent = { status: "starting" | "encoding" | "completed" | "cancelled" | "error"; percent: number; message: string; outputPath?: string; generatedComments?: number; skippedComments?: number };

const APP_VERSION = "0.1.0-beta.29";
const STORAGE_KEY = "kick-recorder-state-v1";

const DEFAULT_SETTINGS: AppSettings = {
  autoRecordOnStreamStart: true,
  autoReceiveChat: true,
  autoReceiveChatForRecordingOnly: true,
  saveChat: true,
  outputDirectory: "",
  autoMonitorEnabled: true,
  monitorIntervalSeconds: 10,
  autoRecordRecordingOnlyOnStreamStart: true,
  launchAtLogin: true,
  preventSystemSleep: true,
  recordingRetryCount: 5,
  recordingRetryDelaySeconds: 10,
  notifyOnLive: true,
  showRecordingPreview: true
};

function normalizeState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") {
    return { channels: [], recordingOnlyChannels: [], settings: DEFAULT_SETTINGS };
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

  const recordingOnlyChannels = Array.isArray(source.recordingOnlyChannels)
    ? source.recordingOnlyChannels.filter((channel): channel is Channel =>
        Boolean(channel) &&
        typeof channel === "object" &&
        typeof channel.id === "number" &&
        typeof channel.name === "string" &&
        /^[a-zA-Z0-9_]{1,25}$/.test(channel.name)
      ).map(channel => ({
        id: channel.id,
        name: channel.name,
        url: `https://kick.com/${channel.name}`,
        mode: "manual" as const,
        status: "待機中" as const,
        recording: false
      }))
    : [];
  const settings = source.settings ?? DEFAULT_SETTINGS;
  return {
    channels,
    recordingOnlyChannels,
    settings: {
      autoRecordOnStreamStart: settings.autoRecordOnStreamStart !== false,
      autoReceiveChat: settings.autoReceiveChat !== false,
      autoReceiveChatForRecordingOnly: settings.autoReceiveChatForRecordingOnly !== false,
      saveChat: settings.saveChat !== false,
      outputDirectory: typeof settings.outputDirectory === "string" ? settings.outputDirectory : "",
      autoMonitorEnabled: settings.autoMonitorEnabled !== false,
      monitorIntervalSeconds: typeof settings.monitorIntervalSeconds === "number"
        ? Math.max(10, Math.min(3600, Math.round(settings.monitorIntervalSeconds)))
        : 10,
      autoRecordRecordingOnlyOnStreamStart: settings.autoRecordRecordingOnlyOnStreamStart !== false,
      launchAtLogin: settings.launchAtLogin !== false,
      preventSystemSleep: settings.preventSystemSleep !== false,
      recordingRetryCount: typeof settings.recordingRetryCount === "number"
        ? Math.max(0, Math.min(10, Math.round(settings.recordingRetryCount)))
        : 5,
      recordingRetryDelaySeconds: typeof settings.recordingRetryDelaySeconds === "number"
        ? Math.max(5, Math.min(60, Math.round(settings.recordingRetryDelaySeconds)))
        : 10,
      notifyOnLive: settings.notifyOnLive !== false,
      showRecordingPreview: settings.showRecordingPreview !== false
    }
  };
}

function formatLiveStartTime(value: string | null): string {
  if (!value) return "開始時刻不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "開始時刻不明";
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatLiveElapsed(value: string | null, now: number): string {
  if (!value) return "計測できません";
  const startedAt = Date.parse(value);
  if (!Number.isFinite(startedAt)) return "計測できません";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map(part => String(part).padStart(2, "0")).join(":");
}

async function loadState(): Promise<PersistedState> {
  if (window.kickRecorder) {
    return normalizeState(await window.kickRecorder.loadState());
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw) as unknown) : { channels: [], recordingOnlyChannels: [], settings: DEFAULT_SETTINGS };
  } catch {
    return { channels: [], recordingOnlyChannels: [], settings: DEFAULT_SETTINGS };
  }
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recordingOnlyChannels, setRecordingOnlyChannels] = useState<Channel[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [newChannel, setNewChannel] = useState("");
  const [newRecordingOnlyChannel, setNewRecordingOnlyChannel] = useState("");
  const [vodUrl, setVodUrl] = useState("");
  const [vodSlug, setVodSlug] = useState("");
  const vodSlugRef = useRef("");
  const [vodDownloadStatus, setVodDownloadStatus] = useState("");
  const [vodDownloadActive, setVodDownloadActive] = useState(false);
  const [vodChatStatus, setVodChatStatus] = useState("");
  const [vodChatActive, setVodChatActive] = useState(false);
  const [tab, setTab] = useState<"dashboard" | "recording" | "library" | "comment-video" | "settings">("dashboard");
  const [isReady, setIsReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [appDataDirectory, setAppDataDirectory] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [kickClientId, setKickClientId] = useState("");
  const [kickClientSecret, setKickClientSecret] = useState("");
  const [kickCredentialsConfigured, setKickCredentialsConfigured] = useState(false);
  const [kickEncryptionAvailable, setKickEncryptionAvailable] = useState(false);
  const [kickMessage, setKickMessage] = useState("");
  const [isTestingKickConnection, setIsTestingKickConnection] = useState(false);
  const [chatStatus, setChatStatus] = useState<ChatReceiverStatus>({
    running: false,
    connectedChannels: 0,
    messageCount: 0,
    lastMessageAt: null,
    message: "チャット受信サーバーは停止中です。"
  });
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSetupMessage, setChatSetupMessage] = useState("");
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [channelChecks, setChannelChecks] = useState<Record<string, ChannelCheck>>({});
  const [liveClock, setLiveClock] = useState(() => Date.now());
  const [isCheckingChannels, setIsCheckingChannels] = useState(false);
  const [lastChannelCheck, setLastChannelCheck] = useState("");
  const [monitorError, setMonitorError] = useState("");
  const [backgroundMonitorStatus, setBackgroundMonitorStatus] = useState<BackgroundMonitorStatus>({
    enabled: true, running: false, monitoredChannels: 0, intervalSeconds: 10,
    lastCheckAt: null, lastError: "", message: "監視状態を読み込み中...", results: []
  });
  const previousChecksRef = useRef<Record<string, ChannelCheck>>({});
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    status: "idle",
    currentVersion: APP_VERSION,
    message: "起動時に自動で更新を確認します。"
  });
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [recordingRequests, setRecordingRequests] = useState<Record<string, boolean>>({});
  const [recordingFiles, setRecordingFiles] = useState<RecordingFile[]>([]);
  const [isLoadingRecordings, setIsLoadingRecordings] = useState(false);
  const [deletingRecordingPath, setDeletingRecordingPath] = useState<string | null>(null);
  const [recordingMessage, setRecordingMessage] = useState("");
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [commentLogFiles, setCommentLogFiles] = useState<CommentLogFile[]>([]);
  const [selectedCommentVideoPath, setSelectedCommentVideoPath] = useState("");
  const [selectedCommentLogPaths, setSelectedCommentLogPaths] = useState<string[]>([]);
  const [isLoadingCommentLogs, setIsLoadingCommentLogs] = useState(false);
  const [commentVideoDelay, setCommentVideoDelay] = useState(0);
  const [commentVideoFontSize, setCommentVideoFontSize] = useState(42);
  const [commentVideoDuration, setCommentVideoDuration] = useState(6);
  const [commentVideoRows, setCommentVideoRows] = useState(8);
  const [commentVideoOpacity, setCommentVideoOpacity] = useState(92);
  const [commentVideoQuality, setCommentVideoQuality] = useState<"high" | "standard" | "compact">("standard");
  const [commentVideoShowUsername, setCommentVideoShowUsername] = useState(false);
  const [commentVideoBusy, setCommentVideoBusy] = useState(false);
  const [commentVideoEvent, setCommentVideoEvent] = useState<CommentVideoEvent | null>(null);
  const [commentVideoOutputPath, setCommentVideoOutputPath] = useState("");
  const activeCount = useMemo(() => [...channels, ...recordingOnlyChannels].filter(c => c.recording).length, [channels, recordingOnlyChannels]);
  const activeRecordingChannels = useMemo(() => {
    const unique = new Map<string, Channel>();
    for (const channel of [...channels, ...recordingOnlyChannels]) {
      if (channel.recording) unique.set(channel.name.toLowerCase(), channel);
    }
    return [...unique.values()];
  }, [channels, recordingOnlyChannels]);
  const liveChannelCards = useMemo(() => {
    const watchedChannels = [
      ...channels.map(channel => ({ channel, isRecordingOnly: false })),
      ...recordingOnlyChannels.map(channel => ({ channel, isRecordingOnly: true }))
    ];
    const uniqueChannels = new Map<string, (typeof watchedChannels)[number]>();
    for (const item of watchedChannels) uniqueChannels.set(item.channel.name.toLowerCase(), item);

    return [...uniqueChannels.values()].flatMap(({ channel, isRecordingOnly }) => {
      const live = channelChecks[channel.name.toLowerCase()];
      return live?.found && live.isLive ? [{ channel, live, isRecordingOnly }] : [];
    }).sort((a, b) => {
      const aStart = a.live.startedAt ? Date.parse(a.live.startedAt) : 0;
      const bStart = b.live.startedAt ? Date.parse(b.live.startedAt) : 0;
      return bStart - aStart;
    });
  }, [channels, recordingOnlyChannels, channelChecks]);
  const [previewSelection, setPreviewSelection] = useState("");
  const previewChannel = activeRecordingChannels.find(channel => channel.name === previewSelection) ?? activeRecordingChannels[0] ?? null;

  useEffect(() => {
    let active = true;
    let unsubscribeUpdate: (() => void) | undefined;
    let unsubscribeRecording: (() => void) | undefined;
    let unsubscribeChatMessage: (() => void) | undefined;
    let unsubscribeChatStatus: (() => void) | undefined;
    let unsubscribeVodChat: (() => void) | undefined;
    let unsubscribeCommentVideo: (() => void) | undefined;
    let unsubscribeBackgroundMonitor: (() => void) | undefined;
    void loadState().then(state => {
      if (!active) return;
      setChannels(state.channels);
      setRecordingOnlyChannels(state.recordingOnlyChannels);
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
      unsubscribeChatMessage = window.kickRecorder.onChatMessage(message => {
        if (!active) return;
        setChatMessages(previous => [message, ...previous.filter(item => item.eventId !== message.eventId)].slice(0, 100));
      });
      unsubscribeChatStatus = window.kickRecorder.onChatStatus(status => {
        if (active) setChatStatus(status);
      });
      void window.kickRecorder.getChatReceiverStatus().then(status => {
        if (active) setChatStatus(status);
      }).catch(() => undefined);
      void window.kickRecorder.listChatMessages(50).then(messages => {
        if (active) setChatMessages(messages);
      }).catch(() => undefined);
      unsubscribeVodChat = window.kickRecorder.onVodChatStatus(event => {
        if (!active) return;
        setVodChatStatus(event.message);
        setVodChatActive(event.status === "starting" || event.status === "progress");
        if (event.status === "completed") setLibraryRefreshKey(value => value + 1);
      });
      unsubscribeCommentVideo = window.kickRecorder.onCommentVideoStatus(event => {
        if (!active) return;
        setCommentVideoEvent(event);
        setCommentVideoBusy(event.status === "starting" || event.status === "encoding");
        if (event.outputPath) setCommentVideoOutputPath(event.outputPath);
        if (event.status === "completed") setLibraryRefreshKey(value => value + 1);
      });
      const applyMonitorStatus = (status: BackgroundMonitorStatus) => {
        setBackgroundMonitorStatus(status);
        if (status.lastCheckAt) setLastChannelCheck(new Date(status.lastCheckAt).toLocaleString("ja-JP"));
        setMonitorError(status.lastError);
        if (status.results.length > 0) {
          const next = Object.fromEntries(status.results.map(result => [result.slug.toLowerCase(), result]));
          previousChecksRef.current = next;
          setChannelChecks(next);
        }
      };
      unsubscribeBackgroundMonitor = window.kickRecorder.onBackgroundMonitorStatus(applyMonitorStatus);
      void window.kickRecorder.getBackgroundMonitorStatus().then(status => {
        if (active) applyMonitorStatus(status);
      }).catch(() => undefined);
      unsubscribeRecording = window.kickRecorder.onRecordingStatus((event: RecordingEvent) => {
        if (!active) return;
        const isRecording = event.status === "starting" || event.status === "recording";
        if (event.isVod && vodSlugRef.current && event.slug === vodSlugRef.current) {
          setVodDownloadStatus(event.message ?? "過去配信を処理しています。");
          if (event.status === "recording") setVodDownloadActive(true);
          if (event.status === "stopped" || event.status === "error") setVodDownloadActive(false);
        }
        if (!event.isVod) setChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug ? { ...channel, recording: isRecording } : channel
        ));
        if (!event.isVod) setRecordingOnlyChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug ? { ...channel, recording: isRecording } : channel
        ));
        if (!event.isVod) setRecordingRequests(previous => ({ ...previous, [event.slug]: false }));
        if (event.status === "error") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画に失敗しました。"}`);
        } else if (event.status === "starting") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画を準備しています。"}`);
        } else if (event.status === "recording") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画を開始しました。"}`);
        } else if (event.status === "stopped") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画を終了しました。"}`);
        }
        setLibraryRefreshKey(value => value + 1);
      });
      void window.kickRecorder.getAppInfo().then(info => {
        if (!active) return;
        setAppDataDirectory(info.dataDirectory);
        setAppVersion(info.version);
        setSettings(previous => previous.outputDirectory
          ? previous
          : { ...previous, outputDirectory: info.defaultOutputDirectory });
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
      unsubscribeChatMessage?.();
      unsubscribeChatStatus?.();
      unsubscribeVodChat?.();
      unsubscribeCommentVideo?.();
      unsubscribeBackgroundMonitor?.();
    };
  }, []);

  const monitorSlugs = useMemo(
    () => [...new Set([...channels, ...recordingOnlyChannels].map(channel => channel.name.toLowerCase()))].slice(0, 200),
    [channels, recordingOnlyChannels]
  );

  const recordingOnlyMessages = useMemo(
    () => chatMessages.filter(message =>
      recordingOnlyChannels.some(channel => channel.name.toLowerCase() === message.channelSlug.toLowerCase())
    ),
    [chatMessages, recordingOnlyChannels]
  );

  useEffect(() => {
    if ((tab !== "library" && tab !== "dashboard" && tab !== "comment-video") || !isDesktop || !window.kickRecorder) return;
    let active = true;
    setIsLoadingRecordings(true);
    void window.kickRecorder.listRecordings().then(files => {
      if (active) setRecordingFiles(files);
    }).catch(error => {
      if (active) setRecordingMessage(error instanceof Error ? error.message : "録画一覧を取得できませんでした。");
    }).finally(() => {
      if (active) setIsLoadingRecordings(false);
    });
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (tab !== "comment-video" || !isDesktop || !window.kickRecorder) return;
    let active = true;
    setIsLoadingCommentLogs(true);
    void window.kickRecorder.listCommentLogFiles().then(files => {
      if (active) setCommentLogFiles(files);
    }).catch(error => {
      if (active) setRecordingMessage(error instanceof Error ? error.message : "コメントファイル一覧を取得できませんでした。");
    }).finally(() => {
      if (active) setIsLoadingCommentLogs(false);
    });
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (!selectedCommentVideoPath && recordingFiles.length > 0) setSelectedCommentVideoPath(recordingFiles[0].path);
    else if (selectedCommentVideoPath && !recordingFiles.some(file => file.path === selectedCommentVideoPath)) setSelectedCommentVideoPath(recordingFiles[0]?.path ?? "");
  }, [recordingFiles, selectedCommentVideoPath]);

  useEffect(() => {
    setSelectedCommentLogPaths(current => {
      const availablePaths = new Set(commentLogFiles.map(file => file.path));
      const retained = current.filter(path => availablePaths.has(path));
      return retained.length > 0 ? retained : commentLogFiles.length > 0 ? [commentLogFiles[0].path] : [];
    });
  }, [commentLogFiles]);

  useEffect(() => {
    if (liveChannelCards.length === 0) return;
    setLiveClock(Date.now());
    const timer = window.setInterval(() => setLiveClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveChannelCards.length]);

  useEffect(() => {
    if (!isReady) return;
    const state: PersistedState = { channels, recordingOnlyChannels, settings };
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
  }, [channels, recordingOnlyChannels, settings, isReady]);

  function addChannel() {
    const raw = newChannel.trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
      .split(/[/?#]/)[0]
      .replace(/\/$/, "");
    if (!raw || !/^[a-zA-Z0-9_]{1,25}$/.test(raw) || [...channels, ...recordingOnlyChannels].some(c => c.name.toLowerCase() === raw.toLowerCase())) {
      if (raw) setRecordingMessage("このチャンネルはすでに別の一覧に登録されています。");
      return;
    }

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

  function addRecordingOnlyChannel() {
    const raw = newRecordingOnlyChannel.trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
      .split(/[/?#]/)[0]
      .replace(/\/$/, "");
    if (!raw || !/^[a-zA-Z0-9_]{1,25}$/.test(raw) ||
      [...channels, ...recordingOnlyChannels].some(channel => channel.name.toLowerCase() === raw.toLowerCase())) {
      if (raw) setRecordingMessage("このチャンネルはすでに別の一覧に登録されているか、名前が正しくありません。");
      return;
    }

    setRecordingOnlyChannels(previous => [...previous, {
      id: Date.now(),
      name: raw,
      url: `https://kick.com/${raw}`,
      mode: "manual",
      status: "待機中",
      recording: false
    }]);
    setNewRecordingOnlyChannel("");
    setRecordingMessage(`${raw} を録画専用一覧に追加しました。配信中に「録画開始」を押してください。`);
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

  async function testKickApiConnection() {
    if (!window.kickRecorder) return;
    if (!kickCredentialsConfigured) {
      setKickMessage("先にClient IDとClient Secretを保存してください。");
      return;
    }

    setIsTestingKickConnection(true);
    setKickMessage("Kick APIの認証を確認しています...");
    try {
      const result = await window.kickRecorder.testKickConnection();
      setKickMessage(`接続成功：${result.message}`);
      setMonitorError("");
    } catch (error) {
      setKickMessage(error instanceof Error ? `接続失敗：${error.message}` : "接続に失敗しました。Client ID／Secretとネットワークを確認してください。");
    } finally {
      setIsTestingKickConnection(false);
    }
  }

  async function startChatReceiver() {
    if (!window.kickRecorder) return;
    const targets = [
      ...(settings.autoReceiveChat ? channels : []),
      ...(settings.autoReceiveChatForRecordingOnly ? recordingOnlyChannels : [])
    ];
    if (targets.length === 0) {
      if (channels.length === 0 && recordingOnlyChannels.length === 0) {
        setChatSetupMessage("先にチャンネル管理または録画専用へチャンネルを登録してください。");
        return;
      }
      setSettings(previous => ({
        ...previous,
        autoReceiveChat: previous.autoReceiveChat || channels.length > 0,
        autoReceiveChatForRecordingOnly: previous.autoReceiveChatForRecordingOnly || recordingOnlyChannels.length > 0
      }));
      setChatSetupMessage("登録済みのチャンネルでコメント自動取得を有効にしました。");
      return;
    }
    setIsStartingChat(true);
    setChatSetupMessage("自動取得対象のKickチャンネルへ接続し直しています...");
    try {
      const status = await window.kickRecorder.startChatReceiver([...new Set(targets.map(channel => channel.name.toLowerCase()))]);
      setChatStatus(status);
      setChatSetupMessage(status.connectedChannels + "チャンネルのコメントを受信しています。");
    } catch (error) {
      setChatSetupMessage(error instanceof Error ? error.message : "コメント受信を開始できませんでした。");
    } finally {
      setIsStartingChat(false);
    }
  }

  async function stopChatReceiver() {
    if (!window.kickRecorder) return;
    setSettings(previous => ({
      ...previous,
      autoReceiveChat: false,
      autoReceiveChatForRecordingOnly: false
    }));
    try {
      const status = await window.kickRecorder.stopChatReceiver();
      setChatStatus(status);
      setChatSetupMessage("すべてのチャット自動取得を停止しました。");
    } catch (error) {
      setChatSetupMessage(error instanceof Error ? error.message : "コメント受信を停止できませんでした。");
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
    if (monitorSlugs.length === 0) {
      setKickMessage("先にチャンネル管理または録画専用へチャンネルを登録してください。");
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
      const results = await window.kickRecorder.checkKickChannels(monitorSlugs);
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


  async function toggleRecording(slug: string, isRecording: boolean) {
    if (!window.kickRecorder) {
      setRecordingMessage("録画はWindowsデスクトップ版で利用できます。");
      return;
    }
    setRecordingRequests(previous => ({ ...previous, [slug.toLowerCase()]: true }));
    setRecordingMessage("");
    try {
      if (isRecording) {
        await window.kickRecorder.stopRecording(slug);
      } else {
        const result = await window.kickRecorder.startRecording(slug);
        setRecordingMessage(`録画要求を送信しました。保存先：${result.outputDirectory}`);
      }
    } catch (error) {
      setRecordingRequests(previous => ({ ...previous, [slug.toLowerCase()]: false }));
      setRecordingMessage(error instanceof Error ? error.message : "録画操作に失敗しました。");
    }
  }

  async function toggleRecordingWithChat(slug: string, isRecording: boolean) {
    if (!window.kickRecorder) {
      setRecordingMessage("録画とコメント取得はWindowsデスクトップ版で利用できます。");
      return;
    }

    const key = slug.toLowerCase();
    setRecordingRequests(previous => ({ ...previous, [key]: true }));
    setRecordingMessage("");
    try {
      if (isRecording) {
        await window.kickRecorder.stopRecording(slug);
        setRecordingMessage(`${slug} の映像録画を停止しました。コメント自動取得は設定に従って継続します。`);
        return;
      }

      // 録画専用から同時開始した場合は、次回起動後もコメント取得を継続する。
      setSettings(previous => ({ ...previous, autoReceiveChatForRecordingOnly: true }));

      let chatWarning = "";
      if (settings.autoReceiveChatForRecordingOnly && !chatStatus.running && !isStartingChat) {
        const chatTargets = [
          ...(settings.autoReceiveChat ? channels : []),
          ...recordingOnlyChannels
        ];
        const slugs = [...new Set(chatTargets.map(channel => channel.name.toLowerCase()))];
        if (slugs.length > 0) {
          setIsStartingChat(true);
          try {
            const status = await window.kickRecorder.startChatReceiver(slugs);
            setChatStatus(status);
            setChatSetupMessage(status.connectedChannels + "チャンネルのコメントを受信しています。");
          } catch (error) {
            chatWarning = error instanceof Error ? error.message : "コメント受信の接続に失敗しました。";
            setChatSetupMessage(chatWarning);
          } finally {
            setIsStartingChat(false);
          }
        }
      }

      const result = await window.kickRecorder.startRecording(slug);
      setRecordingMessage(
        `${slug} の映像録画を開始しました。録画専用チャンネルのコメント自動取得も有効です。保存先：${result.outputDirectory}` +
        (chatWarning ? " コメント接続エラー：" + chatWarning : "")
      );
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "録画・コメント取得の開始に失敗しました。");
    } finally {
      setRecordingRequests(previous => ({ ...previous, [key]: false }));
    }
  }

  async function downloadPastBroadcast() {
    if (!window.kickRecorder) { setVodDownloadStatus("Windowsデスクトップ版で利用できます。"); return; }
    const match = vodUrl.trim().match(/^https:\/\/(?:www\.)?kick\.com\/([a-zA-Z0-9_-]{1,40})\/videos\/[a-f0-9-]{20,40}\/?(?:[?#].*)?$/i);
    if (!match) { setVodDownloadStatus("Kickの過去配信URLを入力してください（https://kick.com/チャンネル/videos/動画ID）。"); return; }
    const slug = match[1].toLowerCase();
    vodSlugRef.current = slug; setVodSlug(slug); setVodDownloadActive(false); setVodDownloadStatus("過去配信のダウンロードを準備しています...");
    try {
      const result = await window.kickRecorder.startRecording(slug, vodUrl.trim());
      setVodDownloadActive(true); setVodDownloadStatus(`ダウンロードを開始しました。保存先：${result.outputDirectory}`);
    } catch (error) { setVodDownloadActive(false); setVodDownloadStatus(error instanceof Error ? error.message : "過去配信のダウンロードに失敗しました。"); }
  }

  async function stopPastBroadcastDownload() {
    if (!window.kickRecorder || !vodSlug) return;
    try { await window.kickRecorder.stopRecording(vodSlug, true); setVodDownloadStatus("停止要求を送信しました。"); }
    catch (error) { setVodDownloadStatus(error instanceof Error ? error.message : "停止できませんでした。"); }
  }

  async function downloadPastBroadcastChat() {
    if (!window.kickRecorder) { setVodChatStatus("Windowsデスクトップ版で利用できます。"); return; }
    if (!vodUrl.trim()) { setVodChatStatus("先にKickの過去配信URLを入力してください。"); return; }
    setVodChatActive(true);
    setVodChatStatus("過去コメントの取得を準備しています...");
    try {
      const result = await window.kickRecorder.startVodChatDownload(vodUrl.trim());
      setVodChatStatus("コメント取得を開始しました。保存先：" + result.outputDirectory);
    } catch (error) {
      setVodChatActive(false);
      setVodChatStatus(error instanceof Error ? error.message : "過去コメントを取得できませんでした。");
    }
  }

  async function stopPastBroadcastChat() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.stopVodChatDownload();
      setVodChatStatus("コメント取得の停止要求を送信しました...");
    } catch (error) {
      setVodChatStatus(error instanceof Error ? error.message : "コメント取得を停止できませんでした。");
    }
  }
  async function openRecordingFile(filePath: string) {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.openRecording(filePath);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "録画ファイルを開けませんでした。");
    }
  }

  async function revealRecordingFile(filePath: string) {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.revealRecording(filePath);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "保存先を表示できませんでした。");
    }
  }

  async function deleteRecordingFromLibrary(filePath: string, fileName: string) {
    if (!window.kickRecorder || deletingRecordingPath) return;
    const confirmed = window.confirm(`「${fileName}」を完全に削除しますか？\n\n削除したファイルは元に戻せません。`);
    if (!confirmed) return;

    setDeletingRecordingPath(filePath);
    setRecordingMessage("");
    try {
      const result = await window.kickRecorder.deleteRecording(filePath);
      setRecordingFiles(current => current.filter(file => file.path !== filePath));
      setRecordingMessage(`「${result.name}」を削除しました。`);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "録画ファイルを削除できませんでした。");
    } finally {
      setDeletingRecordingPath(null);
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

  async function startCommentVideoGeneration() {
    if (!window.kickRecorder) return;
    if (!selectedCommentVideoPath || selectedCommentLogPaths.length === 0) {
      setCommentVideoEvent({ status: "error", percent: 0, message: "元動画とコメントファイルの両方を選択してください。" });
      return;
    }
    setCommentVideoBusy(true);
    setCommentVideoOutputPath("");
    setCommentVideoEvent({ status: "starting", percent: 0, message: "コメント付き動画の生成を準備しています。" });
    try {
      const result = await window.kickRecorder.startCommentVideo({
        videoPath: selectedCommentVideoPath, chatPaths: selectedCommentLogPaths, delaySeconds: commentVideoDelay,
        fontSize: commentVideoFontSize, displaySeconds: commentVideoDuration, rowLimit: commentVideoRows,
        opacity: commentVideoOpacity, quality: commentVideoQuality, showUsername: commentVideoShowUsername
      });
      setCommentVideoOutputPath(result.outputPath);
    } catch (error) {
      setCommentVideoBusy(false);
      setCommentVideoEvent({ status: "error", percent: 0, message: error instanceof Error ? error.message : "コメント付き動画を開始できませんでした。" });
    }
  }

  async function stopCommentVideoGeneration() {
    if (!window.kickRecorder) return;
    try { await window.kickRecorder.stopCommentVideo(); }
    catch (error) {
      setCommentVideoBusy(false);
      setCommentVideoEvent({ status: "error", percent: 0, message: error instanceof Error ? error.message : "生成を停止できませんでした。" });
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

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>Kick Live Message Recorder</strong><small>配信映像・チャット記録</small></div></div>
      <div className="nav-label">メインメニュー</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "recording" ? "nav-item selected" : "nav-item"} onClick={() => setTab("recording")}>● <span>録画専用</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "comment-video" ? "nav-item selected" : "nav-item"} onClick={() => setTab("comment-video")}>✦ <span>コメント付き動画</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> β版・開発テスト中<small>現在のバージョン {appVersion}</small></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="eyebrow">Kick 配信管理ツール</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "recording" ? "録画専用" : tab === "library" ? "録画ライブラリ" : tab === "comment-video" ? "コメント付き動画を生成" : "設定"}</h1></div>
        <div className="top-actions"><span className="connection"><i /> {isDesktop ? "Windows デスクトップ版" : "ブラウザー版プレビュー"}</span><span className="beta-tag">β版</span><div className="avatar">KR</div></div>
      </header>

      {storageError && <div className="storage-error" role="alert">{storageError}</div>}

      {tab === "dashboard" && <>
        <section className="stats">
          <div className="stat-card"><span>登録チャンネル</span><strong>{channels.length.toString().padStart(2,"0")}</strong><small>監視対象</small></div>
          <div className="stat-card"><span>録画中</span><strong>{activeCount.toString().padStart(2,"0")}</strong><small>現在のセッション</small></div>
          <div className="stat-card"><span>保存済み録画</span><strong>{recordingFiles.length.toString().padStart(2,"0")}</strong><small>このPC内</small></div>
          <div className="stat-card accent"><span>現在のバージョン</span><strong className="version-value">{appVersion}</strong><small>{isReady ? "インストール済み" : "起動情報を読み込み中"}</small></div>
        </section>

        {monitorSlugs.length > 0 && <section className="panel live-now-panel">
          <div className="panel-heading">
            <div><h2>LIVE中の配信者</h2><p>チャンネル管理・録画専用に登録した配信者の情報を自動更新します</p></div>
            <span className="live-status live">LIVE · {liveChannelCards.length}件</span>
          </div>
          {!kickCredentialsConfigured
            ? <div className="empty-inline">配信者のLIVE情報を表示するには、設定画面でKick APIのClient IDとClient Secretを登録してください。</div>
            : !settings.autoMonitorEnabled
              ? <div className="empty-inline">自動監視は停止中です。設定画面で自動監視を有効にすると、LIVE情報が更新されます。</div>
              : liveChannelCards.length === 0
                ? <div className="empty-inline">{monitorError ? "LIVE情報を取得できませんでした。ネットワークとKick APIの設定を確認してください。" : "現在LIVE中の登録配信者はいません。配信を検知すると、ここにタイトルや開始時刻などが表示されます。"}</div>
                : <div className="live-stream-grid">
                    {liveChannelCards.map(({ channel, live, isRecordingOnly }) => <article className="live-stream-card" key={channel.name.toLowerCase()}>
                      <div className="live-stream-header">
                        {live.profilePicture
                          ? <img className="live-stream-avatar" src={live.profilePicture} alt="" />
                          : <div className="live-stream-avatar live-stream-avatar-fallback">{channel.name.slice(0, 1).toUpperCase()}</div>}
                        <div className="live-stream-identity">
                          <strong>{live.displayName || channel.name}</strong>
                          <small>@{channel.name}</small>
                        </div>
                        <span className="live-status live"><i /> LIVE</span>
                      </div>
                      <div className="live-stream-title">{live.streamTitle || "配信タイトル未設定"}</div>
                      {live.categoryName && <div className="live-stream-category">{live.categoryName}</div>}
                      <div className="live-stream-meta">
                        <div><small>配信開始</small><strong>{formatLiveStartTime(live.startedAt)}</strong></div>
                        <div><small>配信時間</small><strong className="live-elapsed">{formatLiveElapsed(live.startedAt, liveClock)}</strong></div>
                        <div><small>視聴者数</small><strong>{live.viewerCount.toLocaleString("ja-JP")} 人</strong></div>
                      </div>
                      <div className="live-stream-footer"><span>https://kick.com/{channel.name}</span><span>{isRecordingOnly ? "録画専用・監視中" : "監視中"}</span></div>
                    </article>)}
                  </div>}
          <div className="live-now-footer">
            <span>{lastChannelCheck ? "最終確認：" + lastChannelCheck : "配信状態を確認中..."}</span>
            {monitorError && <span className="monitor-error">{monitorError}</span>}
          </div>
        </section>}

        {settings.showRecordingPreview && activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
          <div className="panel-heading">
            <div><h2>録画中の映像プレビュー</h2><p>Kick公式プレーヤーで現在録画している配信を表示します</p></div>
            <span className="live-status live">● LIVE · {activeRecordingChannels.length}件</span>
          </div>
          <div className="live-preview-frame">
            <iframe
              key={previewChannel?.name.toLowerCase()}
              src={previewChannel ? `https://player.kick.com/${encodeURIComponent(previewChannel.name)}?autoplay=true&muted=true` : "about:blank"}
              title={previewChannel ? `${previewChannel.name} のライブ映像` : "録画中の映像"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="eager"
            />
          </div>
          <div className="live-preview-footer">
            <strong>{previewChannel?.name}</strong>
            <span>音声はミュート状態で開始します。プレーヤー内の音量ボタンから変更できます。</span>
            {activeRecordingChannels.length > 1 && <label>表示チャンネル
              <select value={previewChannel?.name ?? ""} onChange={event => {
                const selected = activeRecordingChannels.find(channel => channel.name === event.target.value);
                if (selected) setPreviewSelection(selected.name);
              }}>
                {activeRecordingChannels.map(channel => <option key={channel.name} value={channel.name}>{channel.name}</option>)}
              </select>
            </label>}
          </div>
        </section>}

        <section className="panel">
          <div className="panel-heading"><div><h2>チャンネル管理</h2><p>録画・監視したいKickチャンネルを登録</p></div><div className="panel-heading-actions"><span className="count-pill">登録数：{channels.length}件</span><button className="small-action refresh-button" onClick={() => void refreshChannelStatuses()} disabled={!isDesktop || isCheckingChannels || monitorSlugs.length === 0}>{isCheckingChannels ? "確認中..." : "配信状態を更新"}</button></div></div>
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
              <span className={channelChecks[c.name.toLowerCase()]?.found
                ? (channelChecks[c.name.toLowerCase()].isLive ? "live-status live" : "live-status offline")
                : (channelChecks[c.name.toLowerCase()] ? "live-status missing" : "live-status unknown")}>
                {channelChecks[c.name.toLowerCase()]?.found
                  ? (channelChecks[c.name.toLowerCase()].isLive ? `配信中 · ${channelChecks[c.name.toLowerCase()].viewerCount.toLocaleString("ja-JP")}人` : "オフライン")
                  : (channelChecks[c.name.toLowerCase()] ? "チャンネル未検出" : "未確認")}
              </span>
              <button className="small-action" onClick={() => setChannels(prev => prev.map(x => x.id === c.id ? {...x, mode: x.mode === "auto" ? "manual" : "auto"} : x))}>方式：{c.mode === "auto" ? "自動" : "手動"}</button>
              <button className="primary-small recording-action" onClick={() => void toggleRecording(c.name, c.recording)} disabled={!isDesktop || Boolean(recordingRequests[c.name.toLowerCase()])}>
                {recordingRequests[c.name.toLowerCase()] ? "処理中..." : c.recording ? "録画停止" : "録画開始"}
              </button>
              <button className="remove" aria-label={`${c.name}を削除`} onClick={() => setChannels(prev => prev.filter(x => x.id !== c.id))}>×</button>
            </div>)}
          </div>
          <div className="notice">この一覧は配信監視・自動録画・チャット取得の対象です。録画だけ行いたいチャンネルは左メニューの「録画専用」に登録してください。{lastChannelCheck && ` 最終確認：${lastChannelCheck}`}</div>
          {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        </section>

        <section className="panel lower-panel">
          <div className="panel-heading"><div><h2>最近の録画</h2><p>通常チャンネル・録画専用の録画ファイル</p></div><button className="text-button" onClick={() => setTab("library")}>すべて見る →</button></div>
          {isLoadingRecordings
            ? <div className="empty-state"><strong>最近の録画を読み込み中...</strong></div>
            : recordingFiles.length === 0
              ? <div className="empty-state"><div className="empty-icon">▣</div><strong>録画はまだありません</strong><span>チャンネル一覧から録画を開始すると、ここに表示されます。</span></div>
              : <div className="recording-library-list">
                  {recordingFiles.slice(0, 3).map(file => <div className="recording-file-row" key={file.path}>
                    <div className="recording-file-icon">▶</div>
                    <div className="recording-file-info">
                      <strong>{file.name}</strong>
                      <small>{new Date(file.modifiedAt).toLocaleString("ja-JP")} ・ {file.extension} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</small>
                    </div>
                    <button className="primary-small" onClick={() => void openRecordingFile(file.path)}>再生</button>
                    <button className="small-action" onClick={() => void revealRecordingFile(file.path)}>保存先を表示</button>
                  </div>)}
                </div>}
        </section>
      </>}

      {tab === "recording" && <section className="panel">
        <div className="panel-heading">
          <div><h2>録画専用チャンネル</h2><p>配信監視・自動録画は行わず、必要なときに録画を開始するチャンネルを登録します</p></div>
          <span className="count-pill">登録数：{recordingOnlyChannels.length}件</span>
        </div>
        {settings.showRecordingPreview && activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
          <div className="panel-heading">
            <div><h2>録画中の映像プレビュー</h2><p>Kick公式プレーヤーで現在録画している配信を表示します</p></div>
            <span className="live-status live">● LIVE · {activeRecordingChannels.length}件</span>
          </div>
          <div className="live-preview-frame">
            <iframe
              key={previewChannel?.name.toLowerCase()}
              src={previewChannel ? `https://player.kick.com/${encodeURIComponent(previewChannel.name)}?autoplay=true&muted=true` : "about:blank"}
              title={previewChannel ? `${previewChannel.name} のライブ映像` : "録画中の映像"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="eager"
            />
          </div>
          <div className="live-preview-footer">
            <strong>{previewChannel?.name}</strong>
            <span>音声はミュート状態で開始します。プレーヤー内の音量ボタンから変更できます。</span>
            {activeRecordingChannels.length > 1 && <label>表示チャンネル
              <select value={previewChannel?.name ?? ""} onChange={event => {
                const selected = activeRecordingChannels.find(channel => channel.name === event.target.value);
                if (selected) setPreviewSelection(selected.name);
              }}>
                {activeRecordingChannels.map(channel => <option key={channel.name} value={channel.name}>{channel.name}</option>)}
              </select>
            </label>}
          </div>
        </section>}
                <section className="panel vod-download-panel">
          <div className="panel-heading"><div><h2>過去の配信（VOD）を録画・コメント取得</h2><p>KickのVideosページから過去配信のURLをコピーして貼り付けます</p></div></div>
          <div className="add-channel">
            <input value={vodUrl} onChange={event => setVodUrl(event.target.value)} placeholder="https://kick.com/channel/videos/動画ID" aria-label="Kick過去配信URL" />
            <button className="primary-small" onClick={() => void downloadPastBroadcast()} disabled={!isDesktop || vodDownloadActive}>過去配信をダウンロード</button>
            {vodDownloadActive && <button className="remove" onClick={() => void stopPastBroadcastDownload()}>動画停止</button>}
          </div>
          {vodDownloadStatus && <div className="api-message" role="status">{vodDownloadStatus}</div>}
          <div className="add-channel vod-chat-actions">
            <button className="primary-small" onClick={() => void downloadPastBroadcastChat()} disabled={!isDesktop || vodChatActive}>過去配信のコメントを取得（JSONL・TXT）</button>
            {vodChatActive && <button className="remove" onClick={() => void stopPastBroadcastChat()}>コメント取得を停止</button>}
          </div>
          {vodChatStatus && <div className="api-message" role="status">{vodChatStatus}</div>}
          <div className="notice">公開状態で取得可能なVODが対象です。コメントは配信開始からの経過時刻・投稿者名・本文を保持し、ChatフォルダーにJSONLとTXTで保存します。Kick側の非公開設定やアクセス制限、API仕様変更により取得できない場合があります。</div>
        </section>
        <div className="setting-row">
          <div><strong>録画専用チャンネルの録画・コメント取得</strong><small>チャンネル一覧の「録画＋コメント取得」から映像とコメントを同時に開始できます。ONならアプリ起動時もコメントへ自動接続します。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoReceiveChatForRecordingOnly} onChange={event => setSettings(previous => ({ ...previous, autoReceiveChatForRecordingOnly: event.target.checked }))} /><span>{settings.autoReceiveChatForRecordingOnly ? "コメント自動接続：有効" : "コメント自動接続：無効"}</span></label>
        </div>
        <div className="add-channel">
          <input value={newRecordingOnlyChannel} onChange={event => setNewRecordingOnlyChannel(event.target.value)} onKeyDown={event => event.key === "Enter" && addRecordingOnlyChannel()} placeholder="録画したいKickチャンネル名 または URL" aria-label="録画専用Kickチャンネル名" />
          <button onClick={addRecordingOnlyChannel}>＋ 録画専用に追加</button>
        </div>
        <div className="channel-list">
          {recordingOnlyChannels.length === 0 && <div className="empty-inline">録画専用チャンネルはまだ登録されていません。チャンネルを追加すると、録画専用のコメント自動取得設定に従ってコメントを取得できます。</div>}
          {recordingOnlyChannels.map(channel => <div className="channel-row" key={channel.id}>
            <div className="channel-icon">{channel.name.slice(0,1).toUpperCase()}</div>
            <div className="channel-info"><strong>{channel.name}</strong><small>{channel.url}</small></div>
            <span className="mode-tag">{settings.autoReceiveChatForRecordingOnly ? "コメント自動取得ON" : "コメント取得OFF"}</span>
            <span className={channel.recording ? "live-status live" : "live-status unknown"}>{channel.recording ? "録画中" : "録画待機"}</span>
            <button className="primary-small recording-action combined-recording-action" onClick={() => void toggleRecordingWithChat(channel.name, channel.recording)} disabled={!isDesktop || Boolean(recordingRequests[channel.name.toLowerCase()])}>
              {recordingRequests[channel.name.toLowerCase()] ? "処理中..." : channel.recording ? "録画停止" : "録画＋コメント取得"}
            </button>
            <button className="remove" aria-label={`${channel.name}を録画専用一覧から削除`} onClick={() => setRecordingOnlyChannels(previous => previous.filter(item => item.id !== channel.id))}>×</button>
          </div>)}
        </div>
        {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        <div className="notice">この一覧は手動開始専用です。各チャンネルの「録画＋コメント取得」を押すと映像録画とコメント受信を同時に開始し、コメント自動接続も有効になります。録画停止後もコメント取得は設定に従って継続します。</div>
        <div className="chat-preview">
          <div className="chat-preview-heading"><strong>録画専用チャンネルの最近のコメント</strong><span>{recordingOnlyMessages.length}件</span></div>
          {recordingOnlyMessages.length === 0
            ? <div className="empty-inline">{settings.autoReceiveChatForRecordingOnly ? "コメントを待っています。チャンネルの配信中にコメントが投稿されると、ここに表示されます。" : "コメント自動取得は停止中です。"}</div>
            : <div className="chat-preview-list">
                {recordingOnlyMessages.slice(0, 20).map(message => <div className="chat-preview-item" key={message.eventId}>
                  <div className="chat-preview-meta"><strong>{message.senderUsername}</strong><span>#{message.channelSlug}</span><time>{new Date(message.createdAt).toLocaleTimeString("ja-JP")}</time></div>
                  <div className="chat-preview-content">{message.content}</div>
                </div>)}
              </div>}
        </div>
        <p className="data-path-note">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}</p>
        {!isDesktop && <div className="notice">録画機能はWindowsデスクトップ版で利用できます。</div>}
      </section>}

      {tab === "library" && <section className="panel">
        <div className="panel-heading">
          <div><h2>録画ライブラリ</h2><p>このPCに保存されたKick配信映像</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || isLoadingRecordings || deletingRecordingPath !== null}>一覧を更新</button>
        </div>
        {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        {!isDesktop
          ? <div className="empty-state"><div className="empty-icon">▤</div><strong>Windowsデスクトップ版で利用できます</strong><span>ブラウザープレビューではPC内の録画ファイルを読み取れません。</span></div>
          : isLoadingRecordings
            ? <div className="empty-state"><strong>録画一覧を読み込み中...</strong></div>
            : recordingFiles.length === 0
              ? <div className="empty-state"><div className="empty-icon">▤</div><strong>保存された録画はありません</strong><span>ダッシュボードで配信を録画すると、ここに表示されます。</span></div>
              : <div className="recording-library-list">
                  {recordingFiles.map(file => <div className="recording-file-row" key={file.path}>
                    <div className="recording-file-icon">▶</div>
                    <div className="recording-file-info">
                      <strong>{file.name}</strong>
                      <small>{new Date(file.modifiedAt).toLocaleString("ja-JP")} ・ {file.extension} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</small>
                    </div>
                    <button className="primary-small" onClick={() => void openRecordingFile(file.path)}>再生</button>
                    <button className="small-action" onClick={() => void revealRecordingFile(file.path)}>保存先を表示</button>
                    <button className="danger-small" onClick={() => void deleteRecordingFromLibrary(file.path, file.name)} disabled={deletingRecordingPath !== null}>
                      {deletingRecordingPath === file.path ? "削除中..." : "削除"}
                    </button>
                  </div>)}
                </div>}
        <div className="data-path-note">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}</div>
      </section>}

      {tab === "comment-video" && <section className="panel comment-video-panel">
        <div className="panel-heading">
          <div><h2>コメント付き動画を生成</h2><p>NicoConvAssのコメント流し込みと、HandBrakeの画質設定を参考にした動画合成</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || commentVideoBusy || isLoadingRecordings || isLoadingCommentLogs}>一覧を更新</button>
        </div>
        {!isDesktop
          ? <div className="empty-state"><div className="empty-icon">✦</div><strong>Windowsデスクトップ版で利用できます</strong><span>ブラウザープレビューでは動画ファイルの読み書きやエンコードを実行できません。</span></div>
          : <>
            <div className="comment-video-intro">録画した動画と保存済みコメント（JSONL）を選ぶと、コメントを右から左へ流して動画に焼き込みます。元動画は変更せず、CommentVideosフォルダーへ別ファイルとして保存します。</div>
            <div className="comment-video-form-grid">
              <label className="comment-video-field"><span>元動画</span>
                <select value={selectedCommentVideoPath} onChange={event => setSelectedCommentVideoPath(event.target.value)} disabled={commentVideoBusy || isLoadingRecordings}>
                  <option value="">動画を選択してください</option>
                  {recordingFiles.map(file => <option key={file.path} value={file.path}>{file.name} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</option>)}
                </select>
                {recordingFiles.length === 0 && <small>録画ライブラリに動画がありません。先に配信を録画してください。</small>}
              </label>
              <div className="comment-video-field comment-video-log-field"><span>コメントファイル（複数選択可）</span>
                <div className="comment-video-log-count">選択中：{selectedCommentLogPaths.length}／最大31ファイル</div>
                <div className="comment-video-log-list" role="group" aria-label="コメントファイルの複数選択">
                  {commentLogFiles.map(file => <label className="comment-video-log-option" key={file.path}>
                    <input type="checkbox" checked={selectedCommentLogPaths.includes(file.path)} onChange={event => setSelectedCommentLogPaths(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path))} disabled={commentVideoBusy || isLoadingCommentLogs || (!selectedCommentLogPaths.includes(file.path) && selectedCommentLogPaths.length >= 31)} />
                    <span><strong>{file.channelSlug} ・ {file.kind}</strong><small>{file.name} ・ {(file.size / (1024 * 1024)).toFixed(2)} MB</small></span>
                  </label>)}
                  {isLoadingCommentLogs && <small>コメントファイルを読み込み中...</small>}
                  {!isLoadingCommentLogs && commentLogFiles.length === 0 && <small>ChatフォルダーにJSONLがありません。コメント保存を有効にして配信コメントを取得してください。</small>}
                </div>
                <small>LIVE配信が日付をまたいだ場合は、同じチャンネルの複数日分ログを選択してください。異なるチャンネルやLIVE／VODの混在はできません。VODログは1ファイルずつ生成します。</small>
              </div>
            </div>
            <div className="settings-subsection">
              <div className="settings-subheading"><h3>コメント表示設定</h3><span className="api-state connected">ASS字幕合成</span></div>
              <div className="comment-video-settings-grid">
                <label className="comment-video-field"><span>同期ずれ（秒）</span><input type="number" min="-300" max="300" step="0.1" value={commentVideoDelay} onChange={event => setCommentVideoDelay(Number(event.target.value))} disabled={commentVideoBusy} /><small>＋はコメントを遅らせ、－は早めます。</small></label>
                <label className="comment-video-field"><span>文字サイズ</span><input type="number" min="16" max="80" value={commentVideoFontSize} onChange={event => setCommentVideoFontSize(Number(event.target.value))} disabled={commentVideoBusy} /><small>動画の解像度に合わせて調整します。</small></label>
                <label className="comment-video-field"><span>コメント表示時間（秒）</span><input type="number" min="2" max="15" value={commentVideoDuration} onChange={event => setCommentVideoDuration(Number(event.target.value))} disabled={commentVideoBusy} /></label>
                <label className="comment-video-field"><span>最大表示行数</span><input type="number" min="1" max="20" value={commentVideoRows} onChange={event => setCommentVideoRows(Number(event.target.value))} disabled={commentVideoBusy} /></label>
                <label className="comment-video-field"><span>文字の不透明度（%）</span><input type="number" min="20" max="100" value={commentVideoOpacity} onChange={event => setCommentVideoOpacity(Number(event.target.value))} disabled={commentVideoBusy} /><small>100で不透明、低いほど透過します。</small></label>
                <label className="comment-video-field"><span>出力画質</span><select value={commentVideoQuality} onChange={event => setCommentVideoQuality(event.target.value as "high" | "standard" | "compact")} disabled={commentVideoBusy}><option value="high">高画質・大きめ</option><option value="standard">標準（おすすめ）</option><option value="compact">容量優先</option></select><small>利用可能なH.264エンコーダーを優先し、ない場合は互換形式へ切り替えます。</small></label>
              </div>
              <label className="comment-video-checkbox"><input type="checkbox" checked={commentVideoShowUsername} onChange={event => setCommentVideoShowUsername(event.target.checked)} disabled={commentVideoBusy} /><span>コメントに投稿者名も表示する</span></label>
            </div>
            {commentVideoEvent && <div className={commentVideoEvent.status === "error" ? "comment-video-status error" : "comment-video-status"} role="status">
              <div className="comment-video-status-line"><strong>{commentVideoEvent.message}</strong>{commentVideoBusy && <span>{Math.round(commentVideoEvent.percent)}%</span>}</div>
              {commentVideoBusy && <div className="comment-video-progress"><div style={{ width: Math.max(0, Math.min(100, commentVideoEvent.percent)).toString() + "%" }} /></div>}
              {commentVideoEvent.status === "completed" && <small>合成コメント：{(commentVideoEvent.generatedComments ?? 0).toLocaleString("ja-JP")}件 ・ 省略：{(commentVideoEvent.skippedComments ?? 0).toLocaleString("ja-JP")}件</small>}
            </div>}
            <div className="comment-video-actions">
              <button className="primary-small" onClick={() => void startCommentVideoGeneration()} disabled={commentVideoBusy || !selectedCommentVideoPath || selectedCommentLogPaths.length === 0 || isLoadingRecordings || isLoadingCommentLogs}>コメント付き動画を生成</button>
              {commentVideoBusy && <button className="remove" onClick={() => void stopCommentVideoGeneration()}>生成を停止</button>}
              {!commentVideoBusy && commentVideoEvent?.status === "completed" && commentVideoOutputPath && <button className="small-action" onClick={() => void revealRecordingFile(commentVideoOutputPath)}>生成ファイルの保存先を表示</button>}
            </div>
            <div className="notice">生成には動画の再エンコードが必要なため、動画の長さ・解像度・PC性能によって時間がかかります。元動画とコメントJSONLは削除・変更しません。</div>
          </>}
      </section>}

      {tab === "settings" && <section className="panel">
        <div className="panel-heading"><div><h2>基本設定</h2><p>β版の録画動作・保存先の設定</p></div></div>
        <div className="setting-row">
          <div><strong>配信開始時に自動録画</strong><small>自動モードの登録チャンネルが配信を開始すると録画します</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "有効" : "無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>Kickチャットを自動取得</strong><small>アプリ起動時やチャンネル追加時に、通常のチャンネル管理へ自動接続します。録画専用一覧のON／OFFは録画専用画面で別に設定できます。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoReceiveChat} onChange={event => setSettings(previous => ({ ...previous, autoReceiveChat: event.target.checked }))} /><span>{settings.autoReceiveChat ? "自動取得：有効" : "自動取得：無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>チャットを保存</strong><small>受信したコメントをJSONL形式で保存します。画面にもリアルタイム表示します。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.saveChat} onChange={event => setSettings(previous => ({ ...previous, saveChat: event.target.checked }))} /><span>{settings.saveChat ? "有効" : "無効"}</span></label>
        </div>

        <div className="settings-subsection recording-retry-settings">
          <div className="settings-subheading">
            <h3>録画の自動再接続</h3>
            <span className="api-state connected">通信エラー対策</span>
          </div>
          <div className="setting-row">
            <div><strong>予期しない録画終了時に再接続</strong><small>通信切断などで録画が異常終了した場合だけ再試行します。手動停止・正常な配信終了では再接続しません。</small></div>
            <select className="setting-select" value={settings.recordingRetryCount} onChange={e => setSettings(prev => ({ ...prev, recordingRetryCount: Number(e.target.value) }))}>
              <option value={0}>再接続しない</option>
              <option value={1}>1回</option>
              <option value={3}>3回</option>
              <option value={5}>5回（推奨）</option>
              <option value={10}>10回</option>
            </select>
          </div>
          <div className="setting-row">
            <div><strong>再接続までの待ち時間</strong><small>再接続する前に待機する秒数です。再接続ごとの録画は別ファイルとして保存します。</small></div>
            <select className="setting-select" value={settings.recordingRetryDelaySeconds} onChange={e => setSettings(prev => ({ ...prev, recordingRetryDelaySeconds: Number(e.target.value) }))}>
              <option value={5}>5秒</option>
              <option value={10}>10秒</option>
              <option value={15}>15秒</option>
              <option value={30}>30秒</option>
              <option value={60}>60秒</option>
            </select>
          </div>
        </div>

        <div className="settings-subsection">
          <div className="settings-subheading"><h3>配信プレビュー</h3><span className={settings.showRecordingPreview ? "api-state connected" : "api-state"}>{settings.showRecordingPreview ? "表示：ON" : "表示：OFF"}</span></div>
          <div className="setting-row">
            <div><strong>録画中の映像プレビューを表示</strong><small>ダッシュボードと録画専用画面のプレーヤー表示を切り替えます。OFFにしても録画・コメント取得は継続します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.showRecordingPreview} onChange={e => setSettings(prev => ({ ...prev, showRecordingPreview: e.target.checked }))} /><span>{settings.showRecordingPreview ? "有効" : "無効"}</span></label>
          </div>
        </div>

        <div className="settings-subsection monitor-settings">
          <div className="settings-subheading">
            <h3>24時間バックグラウンド監視・自動録画</h3>
            <span className={backgroundMonitorStatus.running ? "api-state connected" : "api-state"}>{backgroundMonitorStatus.running ? "監視中" : "停止中"}</span>
          </div>
          <div className="setting-row">
            <div><strong>登録チャンネルを24時間監視</strong><small>メインプロセスで監視するため、ウィンドウを閉じて通知領域に常駐していても配信を検知します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoMonitorEnabled} onChange={e => setSettings(prev => ({ ...prev, autoMonitorEnabled: e.target.checked }))} /><span>{settings.autoMonitorEnabled ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>配信開始時に通常チャンネルを自動録画</strong><small>チャンネル管理で「自動録画」に設定したチャンネルが対象です。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>録画専用チャンネルも配信開始時に自動録画</strong><small>録画専用一覧に登録したチャンネルも、LIVE検知時に録画とコメント取得を開始します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoRecordRecordingOnlyOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordRecordingOnlyOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordRecordingOnlyOnStreamStart ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>監視間隔</strong><small>最短10秒。配信開始後、次の確認で録画を開始します。APIのアクセス制限時はRetry-Afterに従って待機します。</small></div>
            <select className="setting-select" value={settings.monitorIntervalSeconds} onChange={e => setSettings(prev => ({ ...prev, monitorIntervalSeconds: Number(e.target.value) }))}>
              <option value={10}>10秒（最速）</option><option value={15}>15秒</option><option value={20}>20秒</option><option value={30}>30秒</option>
              <option value={60}>1分</option><option value={120}>2分</option><option value={300}>5分</option><option value={600}>10分</option>
            </select>
          </div>
          <div className="setting-row">
            <div><strong>Windowsログイン時に自動起動</strong><small>PCへサインインするとアプリを通知領域で起動して監視を再開します（Windowsデスクトップ版）。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.launchAtLogin} onChange={e => setSettings(prev => ({ ...prev, launchAtLogin: e.target.checked }))} /><span>{settings.launchAtLogin ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>監視中はPCのスリープを抑止</strong><small>監視中にWindowsがスリープへ移行しないよう要求します。ディスプレイは消灯できます。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.preventSystemSleep} onChange={e => setSettings(prev => ({ ...prev, preventSystemSleep: e.target.checked }))} /><span>{settings.preventSystemSleep ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>配信開始をWindows通知で知らせる</strong><small>LIVEを検知したとき、録画開始の結果とともに通知します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.notifyOnLive} onChange={e => setSettings(prev => ({ ...prev, notifyOnLive: e.target.checked }))} /><span>{settings.notifyOnLive ? "有効" : "無効"}</span></label>
          </div>
          <div className="monitor-status-line">
            {backgroundMonitorStatus.message}
            {backgroundMonitorStatus.lastCheckAt && ` · 最終確認：${new Date(backgroundMonitorStatus.lastCheckAt).toLocaleString("ja-JP")}`}
          </div>
          {backgroundMonitorStatus.lastError && <div className="storage-error monitor-error">監視・コメント取得エラー：{backgroundMonitorStatus.lastError} 自動再試行します。</div>}
          <div className="notice">注意：24時間監視には、アプリのプロセスが動作していること、PCの電源とネットワークが利用可能であることが必要です。ウィンドウ右上の×は終了ではなく通知領域へ最小化します。完全終了は通知領域アイコンのメニューから行います。自動録画・コメント取得には対応する各チャット自動取得設定も有効にしてください。</div>
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
          <p className="settings-help">Kick Developerで作成したアプリのClient IDとClient Secretを入力します。SecretはWindowsの暗号化機能で保護し、画面側やログには保存しません。保存後に「接続テスト」を押すと、Kickの認証サーバーからApp Access Tokenを取得できるか確認します。</p>
          <label className="credential-field">クライアントID
            <input value={kickClientId} onChange={event => setKickClientId(event.target.value)} placeholder="Kick DeveloperのクライアントID" autoComplete="off" disabled={!isDesktop} />
          </label>
          <label className="credential-field">クライアントシークレット
            <input type="password" value={kickClientSecret} onChange={event => setKickClientSecret(event.target.value)} placeholder={kickCredentialsConfigured ? "保存済み（変更する場合のみ入力）" : "Kick Developerのクライアントシークレット"} autoComplete="new-password" disabled={!isDesktop} />
          </label>
          <div className="credential-actions">
            <button className="primary-small" onClick={() => void saveKickApiCredentials()} disabled={!isDesktop || !kickEncryptionAvailable}>認証情報を保存</button>
            <button className="small-action" onClick={() => void testKickApiConnection()} disabled={!isDesktop || !kickCredentialsConfigured || isTestingKickConnection}>{isTestingKickConnection ? "接続確認中..." : "接続テスト"}</button>
            <button className="small-action" onClick={() => void clearKickApiCredentials()} disabled={!isDesktop || !kickCredentialsConfigured}>認証情報を削除</button>
          </div>
          {kickMessage && <div className="api-message" role="status">{kickMessage}</div>}
          <div className="notice">この認証はKick公式APIによる配信状態の自動監視に使用します。コメント受信は別方式のため、ここでのClient ID／Secret登録は不要です。</div>
          {!isDesktop && <div className="notice">Kick APIの認証情報登録はWindowsデスクトップ版で利用できます。</div>}
          {isDesktop && !kickEncryptionAvailable && <div className="storage-error">Windowsの暗号化ストレージが利用できないため、認証情報は保存できません。</div>}
        </div>
        <div className="settings-subsection chat-settings">
          <div className="settings-subheading">
            <h3>Kickチャット受信</h3>
            <span className={chatStatus.running ? "api-state connected" : "api-state"}>{chatStatus.running ? "受信中（" + chatStatus.connectedChannels + "チャンネル）" : "停止中"}</span>
          </div>
          <p className="settings-help">登録したKickチャンネルの公開チャットへアプリから直接接続します。同時に最大50チャンネルまで受信でき、自動取得が有効ならアプリ起動時とチャンネル追加時に自動で接続します。ngrok・Cloudflare Tunnel・Webhook URL登録は不要です。Kickの非公式リアルタイム接続を利用するため、Kick側の仕様変更で受信できなくなる場合があります。</p>
          <div className="chat-receiver-actions">
            <button className="primary-small" onClick={() => void startChatReceiver()} disabled={!isDesktop || isStartingChat || chatStatus.running || channels.length === 0}>
              {isStartingChat ? "接続中..." : "コメント受信を開始"}
            </button>
            <button className="small-action" onClick={() => void stopChatReceiver()} disabled={!isDesktop || !chatStatus.running}>受信を停止</button>
            <span className="chat-count">受信数：{chatStatus.messageCount.toLocaleString("ja-JP")}件</span>
            {chatStatus.lastMessageAt && <span className="chat-count">最終受信：{new Date(chatStatus.lastMessageAt).toLocaleTimeString("ja-JP")}</span>}
          </div>
          {chatSetupMessage && <div className="api-message" role="status">{chatSetupMessage}</div>}
          <div className="monitor-status-line">{chatStatus.message}</div>
          <div className="chat-preview">
            <div className="chat-preview-heading"><strong>最近受信したコメント</strong><span>{chatMessages.length}件を表示</span></div>
            {chatMessages.length === 0
              ? <div className="empty-inline">自動取得が有効なら、アプリ起動後に登録チャンネルのコメントが自動で表示されます。手動で開始することもできます。</div>
              : <div className="chat-preview-list">
                  {chatMessages.slice(0, 20).map(message => <div className="chat-preview-item" key={message.eventId}>
                    <div className="chat-preview-meta"><strong>{message.senderUsername}</strong><span>#{message.channelSlug}</span><time>{new Date(message.createdAt).toLocaleTimeString("ja-JP")}</time></div>
                    <div className="chat-preview-content">{message.content}</div>
                  </div>)}
                </div>}
          </div>
          <p className="settings-help">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}/Chat/チャンネル名/YYYY-MM-DD.jsonl</p>
          {!isDesktop && <div className="notice">チャット受信はWindowsデスクトップ版で利用できます。</div>}
        </div>
        {appDataDirectory && <div className="data-path-note">アプリ設定データ: {appDataDirectory}</div>}
        {!isDesktop && <div className="notice">保存先フォルダーの選択はWindowsデスクトップ版で利用できます。ブラウザープレビューでは設定をブラウザー内に保存します。</div>}
      </section>}

      <footer>Kick Live Message Recorder <span>•</span> β版 {appVersion} <span>•</span> 日本語版</footer>
    </main>
  </div>;
}
