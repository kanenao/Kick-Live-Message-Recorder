import { contextBridge, ipcRenderer } from "electron";

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
  notifyOnLive: boolean;
  showRecordingPreview: boolean;
  aiArticleEnabled: boolean;
  aiArticleModel: string;
  aiArticleIntervalSeconds: number;
};

type AppState = {
  channels: Channel[];
  recordingOnlyChannels: Channel[];
  settings: AppSettings;
};

type AppInfo = {
  version: string;
  dataDirectory: string;
  defaultOutputDirectory: string;
  isPackaged: boolean;
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
  isVod?: boolean;
};

type CommentLogFile = {
  path: string; name: string; channelSlug: string; kind: "LIVE" | "VOD"; size: number; modifiedAt: string;
};
type CommentVideoOptions = {
  videoPath: string; chatPath?: string; chatPaths?: string[]; delaySeconds?: number; fontFamily?: "ms-pgothic" | "meiryo" | "yu-gothic" | "arial"; fontSize?: number;
  displaySeconds?: number; speedPercent?: number; rowLimit?: number; collisionGap?: number; opacity?: number;
  quality?: "high" | "standard" | "compact"; showUsername?: boolean;
};
type StreamArticle = {
  id: string; slug: string; displayName: string; headline: string; category: string; startedAt: string;
  durationSeconds: number; commentCount: number; uniqueCommenters: number; keywords: string[];
  paragraphs: string[]; sourceVideo: string; sourceLogs: string[]; createdAt: string;
  status?: "live" | "completed"; aiGenerated?: boolean; aiSummary?: string; highlights?: string[];
  lastAiUpdateAt?: string | null; viewerCount?: number; peakViewerCount?: number; aiError?: string;
};

type CommentVideoPreviewResult = {
  width: number;
  height: number;
  durationSeconds: number;
  totalComments: number;
  malformedLines: number;
  outsideVideoCount: number;
  comments: Array<{ seconds: number; content: string; username: string; color: string }>;
};
type AiArticleStatus = {
  configured: boolean; encryptionAvailable: boolean;
  aiArticleEnabled: boolean; aiArticleModel: string; aiArticleIntervalSeconds: number;
};
type CommentVideoEvent = {
  status: "starting" | "encoding" | "completed" | "cancelled" | "error"; percent: number; message: string;
  outputPath?: string; generatedComments?: number; skippedComments?: number;
};

type VodChatEvent = {
  status: "starting" | "progress" | "completed" | "stopped" | "error";
  slug: string;
  videoId: string;
  pages: number;
  messageCount: number;
  message: string;
  filePaths?: string[];
};

type KickCredentialsStatus = {
  configured: boolean;
  encryptionAvailable: boolean;
  clientId: string;
};

type UpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  releaseNotes?: string;
  releaseDate?: string;
  message: string;
};

type BackgroundMonitorStatus = {
  enabled: boolean; running: boolean; monitoredChannels: number; intervalSeconds: number;
  lastCheckAt: string | null; lastError: string; message: string; results: KickChannelCheck[];
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

type KickChannelCheck = {
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

const api = {
  loadState: (): Promise<AppState> => ipcRenderer.invoke("app:load-state"),
  saveState: (state: AppState): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:save-state", state),
  selectOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke("app:select-output-directory"),
  notifyLive: (slug: string, details?: {
    displayName?: string;
    streamTitle?: string;
    categoryName?: string;
    startedAt?: string | null;
    viewerCount?: number;
  }): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:notify-live", slug, details),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info"),
  getKickCredentialsStatus: (): Promise<KickCredentialsStatus> => ipcRenderer.invoke("kick:get-credentials-status"),
  saveKickCredentials: (credentials: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; clientId: string }> =>
    ipcRenderer.invoke("kick:save-credentials", credentials),
  testKickConnection: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("kick:test-connection"),
  clearKickCredentials: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("kick:clear-credentials"),
  checkKickChannels: (slugs: string[]): Promise<KickChannelCheck[]> => ipcRenderer.invoke("kick:check-channels", slugs),
  getBackgroundMonitorStatus: (): Promise<BackgroundMonitorStatus> => ipcRenderer.invoke("monitor:get-status"),
  onBackgroundMonitorStatus: (callback: (status: BackgroundMonitorStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: BackgroundMonitorStatus): void => callback(status);
    ipcRenderer.on("monitor:status", listener);
    return () => ipcRenderer.removeListener("monitor:status", listener);
  },
  startChatReceiver: (slugs: string[]): Promise<ChatReceiverStatus> => ipcRenderer.invoke("chat:start", slugs),
  stopChatReceiver: (): Promise<ChatReceiverStatus> => ipcRenderer.invoke("chat:stop"),
  getChatReceiverStatus: (): Promise<ChatReceiverStatus> => ipcRenderer.invoke("chat:get-status"),
  listChatMessages: (limit: number): Promise<ChatMessage[]> => ipcRenderer.invoke("chat:list", limit),
  startVodChatDownload: (url: string): Promise<{ ok: true; outputDirectory: string }> =>
    ipcRenderer.invoke("vod-chat:start", url),
  stopVodChatDownload: (): Promise<{ ok: true }> => ipcRenderer.invoke("vod-chat:stop"),
  onVodChatStatus: (callback: (event: VodChatEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: VodChatEvent): void => callback(event);
    ipcRenderer.on("vod-chat:status", listener);
    return () => ipcRenderer.removeListener("vod-chat:status", listener);
  },
  copyText: (value: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:copy-text", value),
  onChatMessage: (callback: (message: ChatMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: ChatMessage): void => callback(message);
    ipcRenderer.on("chat:message", listener);
    return () => ipcRenderer.removeListener("chat:message", listener);
  },
  onChatStatus: (callback: (status: ChatReceiverStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ChatReceiverStatus): void => callback(status);
    ipcRenderer.on("chat:status", listener);
    return () => ipcRenderer.removeListener("chat:status", listener);
  },
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("updater:install"),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status);
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  },
  startRecording: (slug: string, sourceUrl?: string): Promise<{ ok: true; outputDirectory: string }> =>
    ipcRenderer.invoke("recording:start", slug, sourceUrl),
  stopRecording: (slug: string, isVod = false): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:stop", slug, isVod),
  listRecordings: (): Promise<RecordingFile[]> => ipcRenderer.invoke("recording:list"),
  deleteRecording: (filePath: string): Promise<{ ok: true; name: string }> =>
    ipcRenderer.invoke("recording:delete", filePath),
  openRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:open", filePath),
  revealRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:reveal", filePath),
  getAiArticleStatus: (): Promise<AiArticleStatus> => ipcRenderer.invoke("ai-article:get-status"),
  saveAiArticleKey: (apiKey: string): Promise<{ ok: true }> => ipcRenderer.invoke("ai-article:save-key", apiKey),
  clearAiArticleKey: (): Promise<{ ok: true }> => ipcRenderer.invoke("ai-article:clear-key"),
  testAiArticleConnection: (model: string): Promise<{ ok: true; message: string }> => ipcRenderer.invoke("ai-article:test", model),
  onStreamArticleUpdate: (callback: (article: StreamArticle) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, article: StreamArticle): void => callback(article);
    ipcRenderer.on("articles:updated", listener);
    return () => ipcRenderer.removeListener("articles:updated", listener);
  },
  listStreamArticles: (slug?: string): Promise<StreamArticle[]> => ipcRenderer.invoke("articles:list", slug),
  generateStreamArticle: (input: { videoPath: string; slug: string; displayName?: string; category?: string; headline?: string; chatPaths?: string[] }): Promise<StreamArticle> =>
    ipcRenderer.invoke("articles:generate", input),
  listCommentLogFiles: (): Promise<CommentLogFile[]> => ipcRenderer.invoke("comment-video:list-logs"),
  previewCommentVideo: (input: { videoPath: string; chatPaths: string[]; delaySeconds?: number }): Promise<CommentVideoPreviewResult> =>
    ipcRenderer.invoke("comment-video:preview", input),
  startCommentVideo: (options: CommentVideoOptions): Promise<{ ok: true; outputPath: string }> => ipcRenderer.invoke("comment-video:start", options),
  stopCommentVideo: (): Promise<{ ok: true }> => ipcRenderer.invoke("comment-video:stop"),
  onCommentVideoStatus: (callback: (event: CommentVideoEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: CommentVideoEvent): void => callback(event);
    ipcRenderer.on("comment-video:status", listener);
    return () => ipcRenderer.removeListener("comment-video:status", listener);
  },
  onRecordingStatus: (callback: (event: RecordingEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: RecordingEvent): void => callback(event);
    ipcRenderer.on("recording:status", listener);
    return () => ipcRenderer.removeListener("recording:status", listener);
  }
};

contextBridge.exposeInMainWorld("kickRecorder", api);
