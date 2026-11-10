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

const api = {
  loadState: (): Promise<AppState> => ipcRenderer.invoke("app:load-state"),
  saveState: (state: AppState): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:save-state", state),
  selectOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke("app:select-output-directory"),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info")
};

contextBridge.exposeInMainWorld("kickRecorder", api);
