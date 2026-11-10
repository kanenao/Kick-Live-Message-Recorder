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
};

type AppState = {
  channels: Channel[];
  settings: AppSettings;
};

type AppInfo = {
  version: string;
  dataDirectory: string;
  isPackaged: boolean;
};

type KickCredentialsStatus = {
  configured: boolean;
  encryptionAvailable: boolean;
  clientId: string;
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
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info"),
  getKickCredentialsStatus: (): Promise<KickCredentialsStatus> => ipcRenderer.invoke("kick:get-credentials-status"),
  saveKickCredentials: (credentials: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; clientId: string }> =>
    ipcRenderer.invoke("kick:save-credentials", credentials),
  clearKickCredentials: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("kick:clear-credentials"),
  checkKickChannels: (slugs: string[]): Promise<KickChannelCheck[]> => ipcRenderer.invoke("kick:check-channels", slugs)
};

contextBridge.exposeInMainWorld("kickRecorder", api);
