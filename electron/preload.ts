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
  removeEmotesFromAss: boolean;
  assAutoFlow: boolean;
  vodAssCrossingSeconds: number;
  vodAssSpeedPercent: number;
  vodAssEntryOffsetPx: number;
  vodAssRowLimit: number;
  vodAssCollisionGap: number;
  vodAssDelaySeconds: number;
  rankingAiModel: string;
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

type LibrarySession = {
  id: string;
  slug: string;
  kind: "LIVE" | "VOD";
  startedAt: string;
  endedAt?: string;
  title: string;
  videos: RecordingFile[];
  logs: CommentLogFile[];
  status: "saved" | "interrupted" | "failed" | "unknown";
  warnings: string[];
  commentAssociation: "exact" | "none";
};

type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
  isVod?: boolean;
};

type VodDownloadJob = {
  id: string;
  url: string;
  slug: string;
  videoId: string;
  status: "queued" | "downloading" | "completed" | "cancelled" | "error";
  progress: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  estimatedRemainingSeconds?: number;
  filePath?: string;
  message: string;
};

type CommentLogFile = {
  path: string; name: string; channelSlug: string; kind: "LIVE" | "VOD"; size: number; modifiedAt: string;
};
type LibraryCommentMessage = {
  eventId: string; senderUsername: string; content: string; createdAt: string; usernameColor: string | null;
};
type CommentVideoOptions = {
  videoPath: string; chatPath?: string; chatPaths?: string[]; delaySeconds?: number; fontFamily?: "ms-pgothic" | "meiryo" | "yu-gothic" | "arial"; fontSize?: number;
  displaySeconds?: number; speedPercent?: number; rowLimit?: number; collisionGap?: number; opacity?: number;
  quality?: "high" | "standard" | "compact"; position?: "scroll" | "top" | "bottom"; showUsername?: boolean; removeEmotes?: boolean; autoFlow?: boolean;
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

type EditionRelease = {
  edition: "beta" | "stable"; version: string; title: string; publishedAt: string;
  notes: string; url: string; installerUrl: string;
};
type EditionHistory = { beta: EditionRelease[]; stable: EditionRelease[] };

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
  getRankingBackground: ():Promise<import("./ranking-background").RankingBackgroundStatus> => ipcRenderer.invoke("kick:ranking-background:get"),
  setRankingBackground: (enabled:boolean,scope:"ja"|"all"):Promise<import("./ranking-background").RankingBackgroundStatus> => ipcRenderer.invoke("kick:ranking-background:set",enabled,scope),
  getRankingAi: (scope:"ja"|"all"):Promise<import("./ranking-ai").RankingAiStatus> => ipcRenderer.invoke("kick:ranking-ai",scope),
  getRegisteredRanks: ():Promise<Record<"ja"|"all",import("./kick-ranking").RankingSnapshot|null>> => ipcRenderer.invoke("kick:registered-ranks"),
  getRankingChatActivity: (scope:"ja"|"all",enabled:boolean,selected:string|null=null):Promise<{rows:Array<{slug:string;messages:number;state:"connected"|"connecting"|"recent"|"unavailable";observedSeconds:number;ratePerMinute:number|null;recentMessages:number|null;activeUsers:number|null;activeSeconds:number;activeComplete:boolean;activeMinuteUsers:number|null;activeMinuteSeconds:number}>;support:import("./ranking-support").SupportObservation[];message:string;targets:number;connected:number}> => ipcRenderer.invoke("kick:ranking-chat-activity",scope,enabled,selected),
  getKickRankingHistory: (scope:"ja"|"all",hours:24|168|720,slug:string|null):Promise<import("./kick-ranking-history").RankingHistory> => ipcRenderer.invoke("kick:ranking-history",scope,hours,slug),
  getKickRanking: (scope: "ja" | "all"): Promise<import("./kick-ranking").RankingSnapshot> => ipcRenderer.invoke("kick:ranking",scope),
  listActiveLiveRecordings: (): Promise<string[]> => ipcRenderer.invoke("recording:active-live"),
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
  startVodChatDownload: (url: string, removeEmotes = true, assOptions?: {
    crossingSeconds?: number; speedPercent?: number; entryOffsetPx?: number;
    rowLimit?: number; collisionGap?: number; delaySeconds?: number; autoFlow?: boolean;
  }): Promise<{ ok: true; outputDirectory: string }> =>
    ipcRenderer.invoke("vod-chat:start", url, removeEmotes, assOptions),
  stopVodChatDownload: (): Promise<{ ok: true }> => ipcRenderer.invoke("vod-chat:stop"),
  regenerateSavedVodAss: (jsonlPath: string, removeEmotes = true, assOptions?: {
    crossingSeconds?: number; speedPercent?: number; entryOffsetPx?: number;
    rowLimit?: number; collisionGap?: number; delaySeconds?: number; autoFlow?: boolean;
  }): Promise<{ ok: true; outputPath: string; sourcePath: string; validComments: number; generatedComments: number; skippedComments: number }> =>
    ipcRenderer.invoke("vod-chat:regenerate-ass", jsonlPath, removeEmotes, assOptions),
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
  getEditionReleases: (): Promise<EditionHistory> => ipcRenderer.invoke("editions:list"),
  openEditionInstaller: (target: "beta" | "stable"): Promise<{ opened: boolean; version?: string }> =>
    ipcRenderer.invoke("editions:switch", target),
  openFeedbackForm: (kind: "bug" | "feature", details: string): Promise<{ opened: boolean }> => ipcRenderer.invoke("feedback:open", kind, details),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("updater:install"),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status);
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  },
  listChaseChatRecovery: ():Promise<Array<{url:string;slug:string;videoId:string;state:string;message:string}>> => ipcRenderer.invoke("chase-chat:list"),
  cancelChaseChatRecovery: (url:string):Promise<{ok:boolean}> => ipcRenderer.invoke("chase-chat:cancel",url),
  listChaseVodRecovery: (): Promise<Array<{id:string;slug:string;startedAt:string|null;state:string;attempt:number;message:string}>> => ipcRenderer.invoke("chase-vod:list"),
  cancelChaseVodRecovery: (id:string):Promise<{ok:boolean}> => ipcRenderer.invoke("chase-vod:cancel",id),
  startRecording: (slug: string, sourceUrl?: string, chaseFromEarliest = false, recoverVodAfterLive = false, recoverVodChat = false): Promise<{ ok: true; outputDirectory: string }> =>
    ipcRenderer.invoke("recording:start", slug, sourceUrl, chaseFromEarliest, recoverVodAfterLive, recoverVodChat),
  stopRecording: (slug: string, isVod = false): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:stop", slug, isVod),
  enqueueVodDownloads: (urls: string[]): Promise<VodDownloadJob[]> => ipcRenderer.invoke("vod-download:enqueue", urls),
  listVodDownloads: (): Promise<VodDownloadJob[]> => ipcRenderer.invoke("vod-download:list"),
  cancelVodDownload: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke("vod-download:cancel", id),
  onVodDownloadStatus: (callback: (job: VodDownloadJob) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, job: VodDownloadJob): void => callback(job);
    ipcRenderer.on("vod-download:status", listener);
    return () => ipcRenderer.removeListener("vod-download:status", listener);
  },
  listLibrarySessions: (): Promise<LibrarySession[]> => ipcRenderer.invoke("library:sessions"),
  listRecordings: (): Promise<RecordingFile[]> => ipcRenderer.invoke("recording:list"),
  getRecordingThumbnail: (filePath: string): Promise<string | null> => ipcRenderer.invoke("recording:thumbnail", filePath),
  getRecordingStoryboard: (filePath: string): Promise<{
    durationSeconds: number; frames: Array<{ timeSeconds: number; imageDataUrl: string }>
  }> => ipcRenderer.invoke("recording:storyboard", filePath),
  openKickProfile: (channelSlug: string): Promise<{ ok: true }> => ipcRenderer.invoke("kick:open-profile", channelSlug),
  deleteRecording: (filePath: string): Promise<{ ok: true; name: string }> =>
    ipcRenderer.invoke("recording:delete", filePath),
  openRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:open", filePath),
  revealRecording: (filePath: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("recording:reveal", filePath),
  openRecordingFolder: (): Promise<{ ok: true }> => ipcRenderer.invoke("recording:open-folder"),
  listCommentLogFiles: (): Promise<CommentLogFile[]> => ipcRenderer.invoke("comment-video:list-logs"),
  deleteCommentLog: (filePath: string): Promise<{ ok: true; name: string }> => ipcRenderer.invoke("library:delete-comment-log", filePath),
  listRecentCommentMessages: (channelSlug: string, limit = 100): Promise<LibraryCommentMessage[]> =>
    ipcRenderer.invoke("library:recent-comments", channelSlug, limit),
  listCommentFileMessages: (channelSlug: string, fileName: string, limit = 100): Promise<LibraryCommentMessage[]> =>
    ipcRenderer.invoke("library:recent-comments", channelSlug, limit, fileName),
  previewCommentVideo: (input: { videoPath: string; chatPaths: string[]; delaySeconds?: number; removeEmotes?: boolean; position?: "scroll" | "top" | "bottom" | "command" }): Promise<CommentVideoPreviewResult> =>
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
