import { useEffect, useMemo, useRef, useState } from "react";

type OllamaStatus = { connected: boolean; baseUrl: string; models: Array<{ name: string; size: number }>; message?: string };
type ChatStatus = { serverRunning: boolean; tunnelRunning: boolean; localUrl: string; publicUrl: string; receivedCount: number; lastMessageAt: string | null; message: string };
type KickRecorderSavedChatMessage = { messageId: string; slug: string; broadcaster: string; user: string; text: string; timestamp: string; receivedAt: string; badges: string[]; emotes: Array<{ emoteId: string; start: number; end: number }> };
type KickRecorderArticle = { id: string; slug: string; broadcaster: string; streamTitle: string; startedAt: string | null; generatedAt: string; commentCount: number; isFinal: boolean; title: string; summary: string; paragraphs: string[]; topics: string[]; provider: string; model: string };

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
  autoMonitorEnabled: boolean;
  monitorIntervalSeconds: number;
  notifyOnLive: boolean;
  autoGenerateArticles: boolean;
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

type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
};

const APP_VERSION = "0.1.0-beta.13";
const STORAGE_KEY = "kick-recorder-state-v1";

const DEFAULT_SETTINGS: AppSettings = {
  autoRecordOnStreamStart: true,
  saveChat: true,
  outputDirectory: "",
  autoMonitorEnabled: true,
  monitorIntervalSeconds: 60,
  notifyOnLive: true,
  autoGenerateArticles: true
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
      autoMonitorEnabled: settings.autoMonitorEnabled !== false,
      monitorIntervalSeconds: typeof settings.monitorIntervalSeconds === "number"
        ? Math.max(30, Math.min(3600, Math.round(settings.monitorIntervalSeconds)))
        : 60,
      notifyOnLive: settings.notifyOnLive !== false,
      autoGenerateArticles: settings.autoGenerateArticles !== false
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
  const [tab, setTab] = useState<"dashboard" | "library" | "chat" | "articles" | "settings">("dashboard");
  const [isReady, setIsReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [appDataDirectory, setAppDataDirectory] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [kickClientId, setKickClientId] = useState("");
  const [kickClientSecret, setKickClientSecret] = useState("");
  const [kickCredentialsConfigured, setKickCredentialsConfigured] = useState(false);
  const [kickEncryptionAvailable, setKickEncryptionAvailable] = useState(false);
  const [kickMessage, setKickMessage] = useState("");
  const [chatStatus, setChatStatus] = useState<ChatStatus>({ serverRunning: false, tunnelRunning: false, localUrl: "", publicUrl: "", receivedCount: 0, lastMessageAt: null, message: "停止中" });
  const [chatBusy, setChatBusy] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [chatSelectedChannel, setChatSelectedChannel] = useState("");
  const chatSelectedChannelRef = useRef("");
  const [chatLogMessages, setChatLogMessages] = useState<KickRecorderSavedChatMessage[]>([]);
  const [chatLogLoading, setChatLogLoading] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [chatExporting, setChatExporting] = useState(false);
  const [chatViewMessage, setChatViewMessage] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({ connected: false, baseUrl: "http://127.0.0.1:11434", models: [], message: "未確認" });
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [channelChecks, setChannelChecks] = useState<Record<string, ChannelCheck>>({});
  const [isCheckingChannels, setIsCheckingChannels] = useState(false);
  const [lastChannelCheck, setLastChannelCheck] = useState("");
  const [monitorError, setMonitorError] = useState("");
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
  const [recordingMessage, setRecordingMessage] = useState("");
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [articles, setArticles] = useState<KickRecorderArticle[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [articleBusySlug, setArticleBusySlug] = useState("");
  const [articleMessage, setArticleMessage] = useState("");
  const activeCount = useMemo(() => channels.filter(c => c.recording).length, [channels]);

  useEffect(() => {
    chatSelectedChannelRef.current = chatSelectedChannel.toLowerCase();
  }, [chatSelectedChannel]);

  useEffect(() => {
    if (!chatSelectedChannel && channels.length > 0) setChatSelectedChannel(channels[0].name);
  }, [channels, chatSelectedChannel]);

  useEffect(() => {
    let active = true;
    let unsubscribeUpdate: (() => void) | undefined;
    let unsubscribeRecording: (() => void) | undefined;
    let unsubscribeChat: (() => void) | undefined;
    let unsubscribeArticleNew: (() => void) | undefined;
    let unsubscribeArticleStatus: (() => void) | undefined;
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
      void window.kickRecorder.getOllamaStatus().then(setOllamaStatus).catch(() => undefined);
      unsubscribeUpdate = window.kickRecorder.onUpdateStatus(status => {
        if (active) setUpdateStatus(status);
      });
      unsubscribeChat = window.kickRecorder.onChatEvent(event => {
        if (!active) return;
        if (event.type === "status") setChatStatus(event.status);
        else {
          setChatStatus(previous => ({ ...previous, receivedCount: previous.receivedCount + 1, lastMessageAt: event.message.receivedAt, message: `${event.message.slug}：コメントを保存しました` }));
          if (event.message.slug === chatSelectedChannelRef.current) {
            setChatLogMessages(previous => [...previous.filter(item => item.messageId !== event.message.messageId), event.message].slice(-500));
          }
        }
      });
      void window.kickRecorder.getChatStatus().then(status => { if (active) setChatStatus(status); }).catch(() => undefined);
      unsubscribeArticleNew = window.kickRecorder.onArticleNew(article => {
        if (!active) return;
        setArticles(previous => [article, ...previous.filter(item => item.id !== article.id)].slice(0, 100));
        setArticleMessage(`${article.slug} の${article.isFinal ? "配信終了記事" : "ライブ記事"}を保存しました。`);
      });
      unsubscribeArticleStatus = window.kickRecorder.onArticleStatus(status => {
        if (active) setArticleMessage(`${status.slug ? status.slug + "：" : ""}${status.message}`);
      });
      unsubscribeRecording = window.kickRecorder.onRecordingStatus((event: RecordingEvent) => {
        if (!active) return;
        setChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug
            ? { ...channel, recording: event.status === "starting" || event.status === "recording" }
            : channel
        ));
        setRecordingRequests(previous => ({ ...previous, [event.slug]: false }));
        if (event.status === "error") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画に失敗しました。"}`);
        } else if (event.status === "recording") {
          setRecordingMessage(`${event.slug} の録画を開始しました。`);
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
      unsubscribeChat?.();
      unsubscribeArticleNew?.();
      unsubscribeArticleStatus?.();
    };
  }, []);

  const monitorSlugs = useMemo(
    () => channels.map(channel => channel.name),
    [channels]
  );

  useEffect(() => {
    if (tab !== "chat" || !chatSelectedChannel || !isDesktop || !window.kickRecorder) return;
    let active = true;
    setChatLogLoading(true);
    setChatViewMessage("");
    void window.kickRecorder.listChatMessages(chatSelectedChannel).then(messages => {
      if (active) setChatLogMessages(messages.slice(-500));
    }).catch(error => {
      if (active) setChatViewMessage(error instanceof Error ? error.message : "チャットログを読み込めませんでした。");
    }).finally(() => { if (active) setChatLogLoading(false); });
    return () => { active = false; };
  }, [tab, chatSelectedChannel, isDesktop]);

  useEffect(() => {
    if (tab !== "articles" || !isDesktop || !window.kickRecorder) return;
    let active = true;
    setArticlesLoading(true);
    void window.kickRecorder.listArticles().then(items => {
      if (active) setArticles(items);
    }).catch(error => {
      if (active) setArticleMessage(error instanceof Error ? error.message : "記事一覧を読み込めませんでした。");
    }).finally(() => { if (active) setArticlesLoading(false); });
    return () => { active = false; };
  }, [tab, isDesktop]);

  useEffect(() => {
    if ((tab !== "library" && tab !== "dashboard") || !isDesktop || !window.kickRecorder) return;
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
          const watchedChannel = channels.find(channel => channel.name.toLowerCase() === result.slug.toLowerCase());
          if (
            settings.autoRecordOnStreamStart &&
            watchedChannel?.mode === "auto" &&
            result.found &&
            result.isLive &&
            !previous?.isLive &&
            !watchedChannel.recording
          ) {
            void window.kickRecorder.startRecording(result.slug).catch(error => {
              setRecordingMessage(error instanceof Error ? error.message : `${result.slug} の自動録画を開始できませんでした。`);
            });
          }
          if (
            settings.notifyOnLive &&
            result.found &&
            result.isLive &&
            previous?.found &&
            !previous.isLive
          ) {
            void window.kickRecorder.notifyLive(result.slug).catch(() => undefined);
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
    settings.autoRecordOnStreamStart,
    channels,
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

  async function startChatCapture() {
    if (!window.kickRecorder) return;
    setChatBusy(true);
    setChatMessage("");
    try {
      const status = await window.kickRecorder.startChat();
      setChatStatus(status);
      setChatMessage("受信サーバーとCloudflare Tunnelを起動しました。公開URLをKick Developerへ登録してから購読登録してください。");
    } catch (error) {
      const status = await window.kickRecorder.getChatStatus().catch(() => chatStatus);
      setChatStatus(status);
      setChatMessage(error instanceof Error ? error.message : "チャット受信を開始できませんでした。");
    } finally { setChatBusy(false); }
  }

  async function stopChatCapture() {
    if (!window.kickRecorder) return;
    setChatBusy(true);
    try {
      const status = await window.kickRecorder.stopChat();
      setChatStatus(status);
      setChatMessage("チャット受信を停止しました。");
    } catch (error) {
      setChatMessage(error instanceof Error ? error.message : "停止できませんでした。");
    } finally { setChatBusy(false); }
  }

  async function registerChatSubscriptions() {
    if (!window.kickRecorder || channels.length === 0) {
      setChatMessage("先に監視チャンネルを登録してください。");
      return;
    }
    setChatBusy(true);
    try {
      const results = await window.kickRecorder.subscribeChat(channels.map(channel => channel.name));
      const successCount = results.filter(result => result.ok).length;
      const errors = results.filter(result => !result.ok).map(result => `${result.slug}: ${result.message}`);
      setChatMessage(`購読登録要求：${successCount}/${results.length}件成功。${errors.length ? " エラー：" + errors.join(" / ") : " 実際のコメント受信は受信件数で確認してください。"}`);
    } catch (error) {
      setChatMessage(error instanceof Error ? error.message : "購読登録に失敗しました。");
    } finally { setChatBusy(false); }
  }

  async function copyWebhookUrl() {
    if (!chatStatus.publicUrl) return;
    try {
      await navigator.clipboard.writeText(chatStatus.publicUrl);
      setChatMessage("Webhook URLをコピーしました。");
    } catch {
      setChatMessage("URLをコピーできませんでした。表示されたURLを手動でコピーしてください。");
    }
  }

  async function checkOllamaStatus() {
    if (!window.kickRecorder) return;
    setOllamaChecking(true);
    try {
      const status = await window.kickRecorder.getOllamaStatus();
      setOllamaStatus(status);
    } catch (error) {
      setOllamaStatus({ connected: false, baseUrl: "http://127.0.0.1:11434", models: [], message: error instanceof Error ? error.message : "接続に失敗しました。" });
    } finally {
      setOllamaChecking(false);
    }
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
      for (const result of results) {
        const channel = channels.find(item => item.name.toLowerCase() === result.slug.toLowerCase());
        if (
          settings.autoRecordOnStreamStart &&
          channel?.mode === "auto" &&
          result.found &&
          result.isLive &&
          !channel.recording
        ) {
          void window.kickRecorder.startRecording(result.slug).catch(error => {
            setRecordingMessage(error instanceof Error ? error.message : `${result.slug} の自動録画を開始できませんでした。`);
          });
        }
      }
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

  async function exportChatLog(format: "csv" | "jsonl") {
    if (!window.kickRecorder || !chatSelectedChannel) return;
    setChatExporting(true);
    setChatViewMessage(`${chatSelectedChannel} のコメントを書き出しています...`);
    try {
      const result = await window.kickRecorder.exportChatMessages(chatSelectedChannel, format);
      setChatViewMessage(result.saved
        ? `${result.count.toLocaleString("ja-JP")}件を書き出しました：${result.path}`
        : "書き出しをキャンセルしました。");
    } catch (error) {
      setChatViewMessage(error instanceof Error ? error.message : "チャットログを書き出せませんでした。");
    } finally { setChatExporting(false); }
  }

  async function refreshChatLog() {
    if (!window.kickRecorder || !chatSelectedChannel) return;
    setChatLogLoading(true);
    try {
      const messages = await window.kickRecorder.listChatMessages(chatSelectedChannel);
      setChatLogMessages(messages.slice(-500));
      setChatViewMessage(`${messages.length.toLocaleString("ja-JP")}件を読み込みました。`);
    } catch (error) {
      setChatViewMessage(error instanceof Error ? error.message : "チャットログを更新できませんでした。");
    } finally { setChatLogLoading(false); }
  }

  async function generateArticleNow(slug: string) {
    if (!window.kickRecorder) return;
    setArticleBusySlug(slug);
    setArticleMessage(`${slug} の記事を生成しています。Ollamaの処理には数分かかる場合があります。`);
    try {
      const article = await window.kickRecorder.generateArticle(slug);
      setArticles(previous => [article, ...previous.filter(item => item.id !== article.id)].slice(0, 100));
      setArticleMessage(`${slug} の記事を保存しました。`);
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事を生成できませんでした。");
    } finally { setArticleBusySlug(""); }
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

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>Kick Live Message Recorder</strong><small>配信映像・チャット記録</small></div></div>
      <div className="nav-label">メインメニュー</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "chat" ? "nav-item selected" : "nav-item"} onClick={() => setTab("chat")}>☷ <span>チャットビューアー</span></button>
      <button className={tab === "articles" ? "nav-item selected" : "nav-item"} onClick={() => setTab("articles")}>▧ <span>配信記事</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> β版・開発テスト中<small>現在のバージョン {appVersion}</small></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="eyebrow">Kick 配信管理ツール</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "library" ? "録画ライブラリ" : tab === "chat" ? "チャットビューアー" : tab === "articles" ? "配信記事" : "設定"}</h1></div>
        <div className="top-actions"><span className="connection"><i /> {isDesktop ? "Windows デスクトップ版" : "ブラウザー版プレビュー"}</span><span className="beta-tag">β版</span><div className="avatar">KR</div></div>
      </header>

      {storageError && <div className="storage-error" role="alert">{storageError}</div>}

      {tab === "dashboard" && <>
        <section className="stats">
          <div className="stat-card"><span>登録チャンネル</span><strong>{channels.length.toString().padStart(2,"0")}</strong><small>監視対象</small></div>
          <div className="stat-card"><span>録画中</span><strong>{activeCount.toString().padStart(2,"0")}</strong><small>現在のセッション</small></div>
          <div className="stat-card"><span>保存済み録画</span><strong>{recordingFiles.length.toLocaleString("ja-JP")}</strong><small>このPC内</small></div>
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
          <div className="notice">Kickの配信状態監視、映像・音声録画、公式Webhookによるチャット受信・JSONL保存に対応しています。コメント受信には設定画面でWebhook URL登録と購読設定が必要です。{lastChannelCheck && ` 最終確認：${lastChannelCheck}`}</div>
          {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        </section>

        <section className="panel lower-panel">
          <div className="panel-heading"><div><h2>最近の録画</h2><p>保存された配信がここに表示されます</p></div><button className="text-button" onClick={() => setTab("library")}>すべて見る →</button></div>
          {recordingFiles.length === 0
            ? <div className="empty-state"><div className="empty-icon">▣</div><strong>保存された録画はありません</strong><span>配信の録画を開始すると、ここに最新5件が表示されます。</span></div>
            : <div className="recording-library-list">{recordingFiles.slice(0, 5).map(file => <div className="recording-file-row" key={file.path}>
                <div className="recording-file-icon">▶</div>
                <div className="recording-file-info"><strong>{file.name}</strong><small>{new Date(file.modifiedAt).toLocaleString("ja-JP")} ・ {file.extension} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</small></div>
                <button className="primary-small" onClick={() => void openRecordingFile(file.path)}>再生</button>
                <button className="small-action" onClick={() => void revealRecordingFile(file.path)}>保存先を表示</button>
              </div>)}</div>}
        </section>
      </>}

      {tab === "library" && <section className="panel">
        <div className="panel-heading">
          <div><h2>録画ライブラリ</h2><p>このPCに保存されたKick配信映像</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || isLoadingRecordings}>一覧を更新</button>
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
                  </div>)}
                </div>}
        <div className="data-path-note">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}</div>
      </section>}



      {tab === "chat" && <section className="panel">
        <div className="panel-heading">
          <div><h2>チャットビューアー</h2><p>Kickの配信コメントをリアルタイム表示・検索・書き出し</p></div>
          <span className={chatStatus.serverRunning && chatStatus.tunnelRunning ? "api-state connected" : "api-state"}>{chatStatus.serverRunning && chatStatus.tunnelRunning ? "リアルタイム受信中" : "保存ログを表示中"}</span>
        </div>
        {!isDesktop
          ? <div className="empty-state"><strong>Windowsデスクトップ版で利用できます</strong><span>チャットログはPC内に保存されます。</span></div>
          : <>
            <div className="chat-view-toolbar">
              <label className="chat-channel-select">チャンネル
                <select className="setting-select" value={chatSelectedChannel} onChange={event => setChatSelectedChannel(event.target.value)}>
                  {channels.map(channel => <option key={channel.id} value={channel.name}>{channel.name}</option>)}
                </select>
              </label>
              <input className="chat-search-input" value={chatSearch} onChange={event => setChatSearch(event.target.value)} placeholder="コメント・ユーザー名を検索" aria-label="コメント検索" />
              <button className="small-action" onClick={() => void refreshChatLog()} disabled={!chatSelectedChannel || chatLogLoading}>{chatLogLoading ? "読込中..." : "更新"}</button>
              <button className="small-action" onClick={() => void exportChatLog("csv")} disabled={!chatSelectedChannel || chatLogMessages.length === 0 || chatExporting}>CSV出力</button>
              <button className="small-action" onClick={() => void exportChatLog("jsonl")} disabled={!chatSelectedChannel || chatLogMessages.length === 0 || chatExporting}>JSONL出力</button>
            </div>
            <div className="chat-view-summary">
              <span>表示中：{chatLogMessages.length.toLocaleString("ja-JP")}件（最大500件）</span>
              <span>新着受信：{chatStatus.receivedCount.toLocaleString("ja-JP")}件</span>
              <span>保存形式：JSONL</span>
            </div>
            {chatViewMessage && <div className="api-message" role="status">{chatViewMessage}</div>}
            {channels.length === 0
              ? <div className="empty-state"><strong>チャンネルが登録されていません</strong><span>ダッシュボードでチャンネルを追加してください。</span></div>
              : chatLogLoading && chatLogMessages.length === 0
                ? <div className="empty-state"><strong>チャットログを読み込み中...</strong></div>
                : <div className="chat-message-list">
                    {chatLogMessages
                      .filter(message => {
                        const query = chatSearch.trim().toLocaleLowerCase();
                        return !query || message.text.toLocaleLowerCase().includes(query) || message.user.toLocaleLowerCase().includes(query);
                      })
                      .slice()
                      .reverse()
                      .map(message => <div className="chat-message-row" key={message.messageId}>
                        <time>{new Date(message.timestamp || message.receivedAt).toLocaleTimeString("ja-JP")}</time>
                        <strong>{message.user || "匿名ユーザー"}</strong>
                        <span className="chat-message-text">{message.text}</span>
                        {message.badges.length > 0 && <small>{message.badges.join("・")}</small>}
                      </div>)}
                    {chatLogMessages.length > 0 && chatLogMessages.filter(message => {
                      const query = chatSearch.trim().toLocaleLowerCase();
                      return !query || message.text.toLocaleLowerCase().includes(query) || message.user.toLocaleLowerCase().includes(query);
                    }).length === 0 && <div className="empty-inline">検索に一致するコメントがありません。</div>}
                    {chatLogMessages.length === 0 && <div className="empty-state"><strong>保存済みコメントはありません</strong><span>設定画面でチャット受信を開始し、Kick Developer側でWebhookを設定してください。</span></div>}
                  </div>}
            <div className="data-path-note">チャットログの保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"} / ChatLogs</div>
          </>}
      </section>}

      {tab === "articles" && <section className="panel">
        <div className="panel-heading">
          <div><h2>AI配信記事</h2><p>保存されたKickチャットをOllamaで日本語記事にします</p></div>
          <span className={ollamaStatus.connected ? "api-state connected" : "api-state"}>{ollamaStatus.connected ? "Ollama接続済み" : "Ollama未接続"}</span>
        </div>
        <div className="article-toolbar">
          <span className="settings-help">保存した視聴者コメントとKickの番組情報を元に生成します。映像・音声の内容を直接解析する機能ではありません。ライブ受信中は約3分ごとに新着コメントから記事スナップショットを保存し、配信終了検出時には最終記事を作成します。</span>
          <div className="update-actions">
            {channels.map(channel => <button key={channel.id} className="small-action" onClick={() => void generateArticleNow(channel.name)} disabled={!isDesktop || !ollamaStatus.connected || Boolean(articleBusySlug)}>
              {articleBusySlug === channel.name ? "生成中..." : `${channel.name} の記事を生成`}
            </button>)}
          </div>
        </div>
        {articleMessage && <div className="api-message" role="status">{articleMessage}</div>}
        {articlesLoading
          ? <div className="empty-state"><strong>記事一覧を読み込み中...</strong></div>
          : articles.length === 0
            ? <div className="empty-state"><div className="empty-icon">▧</div><strong>記事はまだありません</strong><span>チャット受信を有効にしてコメントを保存するか、チャンネルごとの記事生成を実行してください。</span></div>
            : <div className="article-list">
                {articles.map(article => <article className="article-card" key={article.id}>
                  <div className="article-card-head">
                    <div><strong>{article.title}</strong><small>{article.slug} ・ {new Date(article.generatedAt).toLocaleString("ja-JP")} ・ コメント {article.commentCount.toLocaleString("ja-JP")}件</small></div>
                    <span className="api-state connected">{article.isFinal ? "最終記事" : "ライブ記事"}</span>
                  </div>
                  {article.summary && <p className="article-summary">{article.summary}</p>}
                  <div className="article-body">{article.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
                  {article.topics.length > 0 && <div className="article-topics">{article.topics.map(topic => <span key={topic}>{topic}</span>)}</div>}
                  <small className="article-meta">生成：{article.provider} / {article.model}</small>
                </article>)}
              </div>}
      </section>}

      {tab === "settings" && <section className="panel">
        <div className="panel-heading"><div><h2>基本設定</h2><p>β版の録画動作・保存先の設定</p></div></div>
        <div className="settings-subsection">
          <div className="settings-subheading">
            <h3>無料AI記事生成（Ollama）</h3>
            <span className={ollamaStatus.connected ? "api-state connected" : "api-state"}>{ollamaStatus.connected ? "Ollama接続済み" : "未接続"}</span>
          </div>
          <p className="settings-help">AI処理をPC内で実行します。OpenAI APIキー・従量課金は不要です。接続先：{ollamaStatus.baseUrl}</p>
          <p className="settings-help">標準モデル：qwen2.5:3b ／ 検出したモデル：{ollamaStatus.models.length ? ollamaStatus.models.map(model => model.name).join("、") : "なし"}</p>
          <div className="update-actions">
            <button className="primary-small" onClick={() => void checkOllamaStatus()} disabled={!isDesktop || ollamaChecking}>{ollamaChecking ? "確認中..." : "Ollama接続を確認"}</button>
          </div>
          {ollamaStatus.connected
            ? <p className="settings-help">検出したモデル：{ollamaStatus.models.length ? ollamaStatus.models.map(model => model.name).join("、") : "なし"}</p>
            : <div className="notice">{ollamaStatus.message || "Ollamaを起動してから接続確認してください。"}<br />モデルの導入コマンド：ollama pull qwen2.5:3b</div>}
          <div className="notice">配信記事タブから手動生成できるほか、チャット受信中は約3分ごとに新しいコメントからライブ記事を自動保存します。配信終了を検出した際には最終記事を作成します。Ollamaとモデルが必要です。</div>
        </div>
        <div className="setting-row">
          <div><strong>配信中の記事を自動生成</strong><small>チャット受信中、約3分ごとに新しいコメントから記事を生成し、配信終了時に最終記事を保存します</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoGenerateArticles} onChange={e => setSettings(prev => ({ ...prev, autoGenerateArticles: e.target.checked }))} /><span>{settings.autoGenerateArticles ? "有効" : "無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>配信開始時に自動録画</strong><small>自動モードの登録チャンネルが配信を開始すると録画します</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "有効" : "無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>チャットログ保存</strong><small>Webhook受信サーバー起動中に、署名検証済みコメントをJSONLで保存します。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.saveChat} disabled /><span>受信設定で管理</span></label>
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

        <div className="settings-subsection chat-settings">
          <div className="settings-subheading">
            <h3>Kickチャット受信・保存</h3>
            <span className={chatStatus.serverRunning && chatStatus.tunnelRunning ? "api-state connected" : "api-state"}>{chatStatus.serverRunning && chatStatus.tunnelRunning ? "受信準備完了" : "停止中／未接続"}</span>
          </div>
          <p className="settings-help">Kick公式Webhookの chat.message.sent を使ってコメントをリアルタイム保存します。受信データは録画保存先の ChatLogs フォルダーへJSONL形式で保存されます。Kickから届いたデータはRSA署名を検証してから保存します。</p>
          <div className="chat-status-grid">
            <div><small>受信サーバー</small><strong>{chatStatus.serverRunning ? "起動中" : "停止中"}</strong></div>
            <div><small>Cloudflare Tunnel</small><strong>{chatStatus.tunnelRunning ? "接続中" : "停止中"}</strong></div>
            <div><small>保存コメント</small><strong>{chatStatus.receivedCount.toLocaleString("ja-JP")}件</strong></div>
            <div><small>最終受信</small><strong>{chatStatus.lastMessageAt ? new Date(chatStatus.lastMessageAt).toLocaleTimeString("ja-JP") : "未受信"}</strong></div>
          </div>
          {chatStatus.publicUrl && <label className="credential-field">Kick Developerへ登録するWebhook URL
            <input readOnly value={chatStatus.publicUrl} onFocus={event => event.currentTarget.select()} />
          </label>}
          <div className="update-actions">
            {!chatStatus.serverRunning || !chatStatus.tunnelRunning
              ? <button className="primary-small" onClick={() => void startChatCapture()} disabled={!isDesktop || !kickCredentialsConfigured || chatBusy}>{chatBusy ? "起動中..." : "チャット受信を開始"}</button>
              : <button className="small-action" onClick={() => void stopChatCapture()} disabled={chatBusy}>受信を停止</button>}
            <button className="small-action" onClick={() => void copyWebhookUrl()} disabled={!chatStatus.publicUrl}>Webhook URLをコピー</button>
            <button className="small-action" onClick={() => void registerChatSubscriptions()} disabled={!isDesktop || !kickCredentialsConfigured || !chatStatus.serverRunning || !chatStatus.tunnelRunning || channels.length === 0 || chatBusy}>登録チャンネルを購読</button>
          </div>
          <div className="notice">設定手順：①「チャット受信を開始」②表示されたURLをKick Developerの対象アプリでWebhooksを有効にしてWebhook URLへ登録 ③「登録チャンネルを購読」を実行。Quick TunnelのURLは起動ごとに変わるため、再起動後はDeveloper側のURLも更新してください。アプリが起動中のみ受信できます。</div>
          <p className="settings-help">{chatStatus.message}</p>
          {chatMessage && <div className="api-message" role="status">{chatMessage}</div>}
          {!isDesktop && <div className="notice">チャット受信はWindowsデスクトップ版で利用できます。</div>}
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
