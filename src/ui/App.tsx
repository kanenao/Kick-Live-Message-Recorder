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
  recordingRetryCount: number;
  recordingRetryDelaySeconds: number;
  notifyOnLive: boolean;
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
};

const APP_VERSION = "0.1.0-beta.20";
const STORAGE_KEY = "kick-recorder-state-v1";

const DEFAULT_SETTINGS: AppSettings = {
  autoRecordOnStreamStart: true,
  autoReceiveChat: true,
  autoReceiveChatForRecordingOnly: true,
  saveChat: true,
  outputDirectory: "",
  autoMonitorEnabled: true,
  monitorIntervalSeconds: 60,
  recordingRetryCount: 5,
  recordingRetryDelaySeconds: 10,
  notifyOnLive: true
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
        : 60,
      recordingRetryCount: typeof settings.recordingRetryCount === "number"
        ? Math.max(0, Math.min(10, Math.round(settings.recordingRetryCount)))
        : 5,
      recordingRetryDelaySeconds: typeof settings.recordingRetryDelaySeconds === "number"
        ? Math.max(5, Math.min(60, Math.round(settings.recordingRetryDelaySeconds)))
        : 10,
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
  const [tab, setTab] = useState<"dashboard" | "recording" | "library" | "settings">("dashboard");
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
  const activeCount = useMemo(() => [...channels, ...recordingOnlyChannels].filter(c => c.recording).length, [channels, recordingOnlyChannels]);
  const activeRecordingChannels = useMemo(() => {
    const unique = new Map<string, Channel>();
    for (const channel of [...channels, ...recordingOnlyChannels]) {
      if (channel.recording) unique.set(channel.name.toLowerCase(), channel);
    }
    return [...unique.values()];
  }, [channels, recordingOnlyChannels]);
  const [previewSelection, setPreviewSelection] = useState("");
  const previewChannel = activeRecordingChannels.find(channel => channel.name === previewSelection) ?? activeRecordingChannels[0] ?? null;

  useEffect(() => {
    let active = true;
    let unsubscribeUpdate: (() => void) | undefined;
    let unsubscribeRecording: (() => void) | undefined;
    let unsubscribeChatMessage: (() => void) | undefined;
    let unsubscribeChatStatus: (() => void) | undefined;
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
      unsubscribeRecording = window.kickRecorder.onRecordingStatus((event: RecordingEvent) => {
        if (!active) return;
        const isRecording = event.status === "starting" || event.status === "recording";
        setChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug ? { ...channel, recording: isRecording } : channel
        ));
        setRecordingOnlyChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug ? { ...channel, recording: isRecording } : channel
        ));
        setRecordingRequests(previous => ({ ...previous, [event.slug]: false }));
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
    };
  }, []);

  const monitorSlugs = useMemo(
    () => channels.map(channel => channel.name),
    [channels]
  );

  const autoChatSlugs = useMemo(() => {
    const selected = [
      ...(settings.autoReceiveChat ? channels : []),
      ...(settings.autoReceiveChatForRecordingOnly ? recordingOnlyChannels : [])
    ].map(channel => channel.name.toLowerCase());
    return [...new Set(selected)];
  }, [channels, recordingOnlyChannels, settings.autoReceiveChat, settings.autoReceiveChatForRecordingOnly]);
  const autoChatSlugKey = autoChatSlugs.join("|");
  const recordingOnlyMessages = useMemo(
    () => chatMessages.filter(message =>
      recordingOnlyChannels.some(channel => channel.name.toLowerCase() === message.channelSlug.toLowerCase())
    ),
    [chatMessages, recordingOnlyChannels]
  );

  useEffect(() => {
    if (!isReady || !isDesktop || !window.kickRecorder) return;
    const slugs = autoChatSlugKey ? autoChatSlugKey.split("|") : [];
    let active = true;

    if (slugs.length === 0) {
      void window.kickRecorder.stopChatReceiver().then(status => {
        if (active) setChatStatus(status);
      }).catch(error => {
        if (active) setChatSetupMessage(error instanceof Error ? error.message : "チャット受信を停止できませんでした。");
      });
      const hasAnyChannels = channels.length > 0 || recordingOnlyChannels.length > 0;
      if (hasAnyChannels) {
        setChatSetupMessage("チャット自動取得は停止中です。設定画面または録画専用画面で有効にできます。");
      }
      return () => { active = false; };
    }

    setIsStartingChat(true);
    setChatSetupMessage("登録チャンネルのコメントを自動取得しています...");
    void window.kickRecorder.startChatReceiver(slugs).then(status => {
      if (!active) return;
      setChatStatus(status);
      setChatSetupMessage(status.connectedChannels + "チャンネルのコメントを自動取得しています。");
    }).catch(error => {
      if (active) setChatSetupMessage(error instanceof Error ? error.message : "コメントの自動取得を開始できませんでした。");
    }).finally(() => {
      if (active) setIsStartingChat(false);
    });

    return () => { active = false; };
  }, [isReady, isDesktop, autoChatSlugKey, channels.length, recordingOnlyChannels.length]);

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
    const interval = Math.max(10, Math.min(3600, settings.monitorIntervalSeconds)) * 1000;
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
      <button className={tab === "recording" ? "nav-item selected" : "nav-item"} onClick={() => setTab("recording")}>● <span>録画専用</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> β版・開発テスト中<small>現在のバージョン {appVersion}</small></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="eyebrow">Kick 配信管理ツール</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "recording" ? "録画専用" : tab === "library" ? "録画ライブラリ" : "設定"}</h1></div>
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

        {activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
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
        {activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
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
                <div className="setting-row">
          <div><strong>録画専用チャンネルのコメントを自動取得</strong><small>ONにするとアプリ起動時・チャンネル追加時にコメントへ自動接続します。通常チャンネル側の設定とは別に管理できます。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoReceiveChatForRecordingOnly} onChange={event => setSettings(previous => ({ ...previous, autoReceiveChatForRecordingOnly: event.target.checked }))} /><span>{settings.autoReceiveChatForRecordingOnly ? "自動取得：有効" : "自動取得：無効"}</span></label>
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
            <button className="primary-small recording-action" onClick={() => void toggleRecording(channel.name, channel.recording)} disabled={!isDesktop || Boolean(recordingRequests[channel.name.toLowerCase()])}>
              {recordingRequests[channel.name.toLowerCase()] ? "処理中..." : channel.recording ? "録画停止" : "録画開始"}
            </button>
            <button className="remove" aria-label={`${channel.name}を録画専用一覧から削除`} onClick={() => setRecordingOnlyChannels(previous => previous.filter(item => item.id !== channel.id))}>×</button>
          </div>)}
        </div>
        {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        <div className="notice">この一覧は手動録画専用です。配信状態の自動監視・自動録画は行いません。コメント自動取得は上の項目で個別にON／OFFできます。録画を開始したいときだけ「録画開始」を押してください。</div>
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
            <div><strong>監視間隔</strong><small>最短10秒。短いほどAPIへの問い合わせが増えます。制限時は自動で待機します。</small></div>
            <select className="setting-select" value={settings.monitorIntervalSeconds} onChange={e => setSettings(prev => ({ ...prev, monitorIntervalSeconds: Number(e.target.value) }))}>
              <option value={10}>10秒（高速）</option>
              <option value={15}>15秒</option>
              <option value={20}>20秒</option>
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
