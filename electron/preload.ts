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
  notifyOnLive: boolean;
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
  streamTitle: string;
  viewerCount: number;
  startedAt: string | null;
};

const api = {
  loadState: (): Promise<AppState> => ipcRenderer.invoke("app:load-state"),
  saveState: (state: AppState): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:save-state", state),
  selectOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke("app:select-output-directory"),
  notifyLive: (slug: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:notify-live", slug),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info"),
  getKickCredentialsStatus: (): Promise<KickCredentialsStatus> => ipcRenderer.invoke("kick:get-credentials-status"),
  saveKickCredentials: (credentials: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; clientId: string }> =>
    ipcRenderer.invoke("kick:save-credentials", credentials),
  testKickConnection: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("kick:test-connection"),
  clearKickCredentials: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("kick:clear-credentials"),
  checkKickChannels: (slugs: string[]): Promise<KickChannelCheck[]> => ipcRenderer.invoke("kick:check-channels", slugs),
  startChatReceiver: (slugs: string[]): Promise<ChatReceiverStatus> => ipcRenderer.invoke("chat:start", slugs),
  stopChatReceiver: (): Promise<ChatReceiverStatus> => ipcRenderer.invoke("chat:stop"),
  getChatReceiverStatus: (): Promise<ChatReceiverStatus> => ipcRenderer.invoke("chat:get-status"),
  listChatMessages: (limit: number): Promise<ChatMessage[]> => ipcRenderer.invoke("chat:list", limit),
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
  stopRecording: (slug: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:stop", slug),
  listRecordings: (): Promise<RecordingFile[]> => ipcRenderer.invoke("recording:list"),
  openRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:open", filePath),
  revealRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:reveal", filePath),
  onRecordingStatus: (callback: (event: RecordingEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: RecordingEvent): void => callback(event);
    ipcRenderer.on("recording:status", listener);
    return () => ipcRenderer.removeListener("recording:status", listener);
  }
};

contextBridge.exposeInMainWorld("kickRecorder", api);
