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
  getOllamaStatus: (): Promise<{ connected: boolean; baseUrl: string; models: Array<{ name: string; size: number }>; message?: string }> =>
    ipcRenderer.invoke("ollama:get-status"),
  generateOllamaArticle: (input: { title?: string; broadcaster?: string; startedAt?: string; comments: Array<{ user?: string; text: string; timestamp?: string }> }): Promise<{ title: string; summary: string; paragraphs: string[]; topics: string[]; provider: string; model: string }> =>
    ipcRenderer.invoke("ollama:generate-article", input),
  getKickCredentialsStatus: (): Promise<KickCredentialsStatus> => ipcRenderer.invoke("kick:get-credentials-status"),
  saveKickCredentials: (credentials: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; clientId: string }> =>
    ipcRenderer.invoke("kick:save-credentials", credentials),
  clearKickCredentials: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("kick:clear-credentials"),
  checkKickChannels: (slugs: string[]): Promise<KickChannelCheck[]> => ipcRenderer.invoke("kick:check-channels", slugs),
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
  onRecordingStatus: (callback: (event: RecordingEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: RecordingEvent): void => callback(event);
    ipcRenderer.on("recording:status", listener);
    return () => ipcRenderer.removeListener("recording:status", listener);
  }
};

contextBridge.exposeInMainWorld("kickRecorder", api);
