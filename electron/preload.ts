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
  isPackaged: boolean;
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

type CommentVideoRenderStatus = {
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

type CommentVideoRenderOptions = {
  videoPath: string;
  commentsPath: string;
  outputPath: string;
  fontSize: number;
  scrollDurationSeconds: number;
  includeUsername: boolean;
  respectPosition: boolean;
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
  clearKickCredentials: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("kick:clear-credentials"),
  checkKickChannels: (slugs: string[]): Promise<KickChannelCheck[]> => ipcRenderer.invoke("kick:check-channels", slugs),
  selectYtDlp: (): Promise<string | null> => ipcRenderer.invoke("recording:select-yt-dlp"),
  selectFfmpeg: (): Promise<string | null> => ipcRenderer.invoke("recording:select-ffmpeg"),
  startRecording: (slug: string): Promise<RecordingStatus> => ipcRenderer.invoke("recording:start", slug),
  stopRecording: (slug: string): Promise<RecordingStatus | null> => ipcRenderer.invoke("recording:stop", slug),
  getRecordingStatuses: (): Promise<RecordingStatus[]> => ipcRenderer.invoke("recording:get-statuses"),
  onRecordingStatus: (callback: (status: RecordingStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: RecordingStatus): void => callback(status);
    ipcRenderer.on("recording:status", listener);
    return () => ipcRenderer.removeListener("recording:status", listener);
  },
  selectCommentVideo: (): Promise<string | null> => ipcRenderer.invoke("comment-video:select-video"),
  selectCommentFile: (): Promise<string | null> => ipcRenderer.invoke("comment-video:select-comments"),
  selectCommentVideoOutput: (videoPath: string): Promise<string | null> => ipcRenderer.invoke("comment-video:select-output", videoPath),
  previewCommentFile: (filePath: string): Promise<CommentFilePreview> => ipcRenderer.invoke("comment-video:preview", filePath),
  renderCommentVideo: (options: CommentVideoRenderOptions): Promise<CommentVideoRenderStatus> => ipcRenderer.invoke("comment-video:start", options),
  cancelCommentVideo: (): Promise<CommentVideoRenderStatus | null> => ipcRenderer.invoke("comment-video:cancel"),
  getCommentVideoStatus: (): Promise<CommentVideoRenderStatus | null> => ipcRenderer.invoke("comment-video:get-status"),
  onCommentVideoStatus: (callback: (status: CommentVideoRenderStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CommentVideoRenderStatus): void => callback(status);
    ipcRenderer.on("comment-video:status", listener);
    return () => ipcRenderer.removeListener("comment-video:status", listener);
  },
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("updater:install"),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status);
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  }
};

contextBridge.exposeInMainWorld("kickRecorder", api);
