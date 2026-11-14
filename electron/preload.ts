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
  saveChat: boolean;
  outputDirectory: string;
  autoMonitorEnabled: boolean;
  monitorIntervalSeconds: number;
  notifyOnLive: boolean;
  autoGenerateArticles: boolean;
  ffmpegPath: string;
  whisperCliPath: string;
  whisperModelPath: string;
};

type AppState = {
  channels: Channel[];
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
  startedAt?: string;
  endedAt?: string;
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
  message: string;
};

type KickChannelCheck = {
  slug: string;
  broadcasterUserId: number | null;
  found: boolean;
  isLive: boolean;
  streamTitle: string;
  viewerCount: number;
  startedAt: string | null;
};

type ChatServiceStatus = { serverRunning: boolean; tunnelRunning: boolean; localUrl: string; publicUrl: string; receivedCount: number; lastMessageAt: string | null; message: string };
type ChatSubscriptionStatus = { slug: string; broadcasterUserId: number | null; subscribed: boolean; subscriptionId: string | null; createdAt: string | null };
type SavedChatMessage = { messageId: string; slug: string; broadcaster: string; user: string; text: string; timestamp: string; receivedAt: string; badges: string[]; emotes: Array<{ emoteId: string; start: number; end: number }> };
type ChatEvent = { type: "status"; status: ChatServiceStatus } | { type: "message"; message: SavedChatMessage };
type MediaToolStatus = {
  ffmpegAvailable: boolean; ffmpegPath: string;
  whisperAvailable: boolean; whisperCliPath: string;
  whisperModelAvailable: boolean; whisperModelPath: string;
  visionModelRequired: string; setupNotes: string[];
};
type SavedArticle = {
  id: string; slug: string; broadcaster: string; streamTitle: string; startedAt: string | null;
  generatedAt: string; commentCount: number; isFinal: boolean; title: string; summary: string;
  paragraphs: string[]; topics: string[]; provider: string; model: string;
  mediaSources?: string[]; visualSummary?: string; transcript?: string; analyzedAt?: string;
  analysis?: {
    frameCount: number; transcriptCharacters: number; commentCount: number;
    durationMs: number; visionAnalyzed: boolean; warnings: string[];
  };
};

const api = {
  loadState: (): Promise<AppState> => ipcRenderer.invoke("app:load-state"),
  saveState: (state: AppState): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:save-state", state),
  selectOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke("app:select-output-directory"),
  notifyLive: (slug: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:notify-live", slug),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info"),
  getOllamaStatus: (): Promise<{ connected: boolean; baseUrl: string; models: Array<{ name: string; size: number }>; message?: string }> =>
    ipcRenderer.invoke("ollama:get-status"),
  getMediaToolStatus: (): Promise<MediaToolStatus> => ipcRenderer.invoke("media:get-status"),
  selectMediaTool: (kind: "ffmpeg" | "whisperCli" | "whisperModel"): Promise<string | null> =>
    ipcRenderer.invoke("media:select-tool", kind),
  generateOllamaArticle: (input: { title?: string; broadcaster?: string; startedAt?: string; comments: Array<{ user?: string; text: string; timestamp?: string }> }): Promise<{ title: string; summary: string; paragraphs: string[]; topics: string[]; provider: string; model: string }> =>
    ipcRenderer.invoke("ollama:generate-article", input),
  getKickCredentialsStatus: (): Promise<KickCredentialsStatus> => ipcRenderer.invoke("kick:get-credentials-status"),
  saveKickCredentials: (credentials: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; clientId: string }> =>
    ipcRenderer.invoke("kick:save-credentials", credentials),
  clearKickCredentials: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("kick:clear-credentials"),
  checkKickChannels: (slugs: string[]): Promise<KickChannelCheck[]> => ipcRenderer.invoke("kick:check-channels", slugs),
  getChatStatus: (): Promise<ChatServiceStatus> => ipcRenderer.invoke("chat:get-status"),
  startChat: (): Promise<ChatServiceStatus> => ipcRenderer.invoke("chat:start"),
  stopChat: (): Promise<ChatServiceStatus> => ipcRenderer.invoke("chat:stop"),
  subscribeChat: (slugs: string[]): Promise<Array<{ slug: string; ok: boolean; message: string }>> => ipcRenderer.invoke("chat:subscribe", slugs),
  getChatSubscriptionStatus: (slugs: string[]): Promise<ChatSubscriptionStatus[]> => ipcRenderer.invoke("chat:subscription-status", slugs),
  listChatMessages: (slug: string): Promise<SavedChatMessage[]> => ipcRenderer.invoke("chat:list", slug),
  exportChatMessages: (slug: string, format: "csv" | "jsonl"): Promise<{ saved: boolean; path?: string; count: number }> => ipcRenderer.invoke("chat:export", { slug, format }),
  listArticles: (): Promise<SavedArticle[]> => ipcRenderer.invoke("articles:list"),
  generateArticle: (slug: string): Promise<SavedArticle> => ipcRenderer.invoke("articles:generate", slug),
  onArticleNew: (callback: (article: any) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, article: any): void => callback(article);
    ipcRenderer.on("articles:new", listener);
    return () => ipcRenderer.removeListener("articles:new", listener);
  },
  onArticleStatus: (callback: (status: { slug: string; message: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { slug: string; message: string }): void => callback(status);
    ipcRenderer.on("articles:status", listener);
    return () => ipcRenderer.removeListener("articles:status", listener);
  },
  onChatEvent: (callback: (event: ChatEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ChatEvent): void => callback(event);
    ipcRenderer.on("chat:event", listener);
    return () => ipcRenderer.removeListener("chat:event", listener);
  },
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("updater:install"),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status);
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  },
  startRecording: (slug: string): Promise<{ ok: true; outputDirectory: string }> =>
    ipcRenderer.invoke("recording:start", slug),
  stopRecording: (slug: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:stop", slug),
  listRecordings: (): Promise<RecordingFile[]> => ipcRenderer.invoke("recording:list"),
  openRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:open", filePath),
  revealRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:reveal", filePath),
  exportRecordingChatAss: (filePath: string): Promise<{ saved: boolean; path?: string; count: number; slug?: string; startedAt?: string; endedAt?: string; durationMs?: number; startReference?: string }> =>
    ipcRenderer.invoke("recording:export-chat-ass", filePath),
  onRecordingStatus: (callback: (event: RecordingEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: RecordingEvent): void => callback(event);
    ipcRenderer.on("recording:status", listener);
    return () => ipcRenderer.removeListener("recording:status", listener);
  }
};

contextBridge.exposeInMainWorld("kickRecorder", api);
