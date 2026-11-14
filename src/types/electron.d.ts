export {};

type KickRecorderChannel = {
  id: number;
  name: string;
  url: string;
  mode: "auto" | "manual";
  status: "監視中" | "待機中";
  recording: boolean;
};

type KickRecorderAppState = {
  channels: KickRecorderChannel[];
  recordingOnlyChannels: KickRecorderChannel[];
  settings: {
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
    aiArticleProvider: "ollama" | "openai";
    aiArticleOllamaUrl: string;
    aiArticleModel: string;
    aiArticleIntervalSeconds: number;
    aiArticleAudioEnabled: boolean;
    aiArticleAudioModel: string;
  };
};

type KickRecorderAppInfo = {
  version: string;
  dataDirectory: string;
  defaultOutputDirectory: string;
  isPackaged: boolean;
};

type KickRecorderRecordingFile = {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
};

type KickRecorderRecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
  isVod?: boolean;
};
type KickRecorderCommentLogFile = { path: string; name: string; channelSlug: string; kind: "LIVE" | "VOD"; size: number; modifiedAt: string };
type KickRecorderStreamArticle = {
  id: string; slug: string; displayName: string; headline: string; streamTitle?: string; category: string; startedAt: string;
  durationSeconds: number; commentCount: number; uniqueCommenters: number; keywords: string[];
  paragraphs: string[]; sourceVideo: string; sourceLogs: string[]; createdAt: string;
  status?: "live" | "completed"; aiGenerated?: boolean; aiSummary?: string; highlights?: string[];
  lastAiUpdateAt?: string | null; viewerCount?: number; peakViewerCount?: number; aiError?: string;
  videoAnalyzed?: boolean; videoFrameCount?: number; videoSummary?: string; videoScenes?: string[]; videoAnalyzedAt?: string | null;
  audioAnalyzed?: boolean; audioSegmentCount?: number; audioSummary?: string; audioTranscript?: string;
  audioTranscriptSegments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  audioAnalyzedAt?: string | null; audioError?: string;
};

type KickRecorderAiArticleStatus = {
  configured: boolean; encryptionAvailable: boolean;
  aiArticleEnabled: boolean; aiArticleProvider: "ollama" | "openai"; aiArticleOllamaUrl: string; aiArticleModel: string; aiArticleIntervalSeconds: number;
};

type KickRecorderAiModelPullStatus = {
  model: string;
  status: string;
  percent: number | null;
  completed?: number;
  total?: number;
  done: boolean;
  error?: string;
};

type KickRecorderCommentVideoEvent = {
  status: "starting" | "encoding" | "completed" | "cancelled" | "error"; percent: number; message: string;
  outputPath?: string; generatedComments?: number; skippedComments?: number;
};

type KickRecorderCommentVideoPreview = {
  width: number;
  height: number;
  durationSeconds: number;
  totalComments: number;
  malformedLines: number;
  outsideVideoCount: number;
  syncSource: "recording-metadata" | "filename" | "file-mtime";
  estimatedVideoStartAt: string;
  comments: Array<{ seconds: number; content: string; username: string; color: string }>;
};

type KickRecorderVodChatEvent = {
  status: "starting" | "progress" | "completed" | "stopped" | "error";
  slug: string;
  videoId: string;
  pages: number;
  messageCount: number;
  message: string;
  filePaths?: string[];
};

type KickRecorderCredentialsStatus = {
  configured: boolean;
  encryptionAvailable: boolean;
  clientId: string;
};

type KickRecorderUpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  releaseNotes?: string;
  releaseDate?: string;
  message: string;
};

type KickRecorderBackgroundMonitorStatus = {
  enabled: boolean; running: boolean; monitoredChannels: number; intervalSeconds: number;
  lastCheckAt: string | null; lastError: string; message: string; results: KickRecorderChannelCheck[];
};

type KickRecorderChatMessage = {
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

type KickRecorderChatStatus = {
  running: boolean;
  connectedChannels: number;
  messageCount: number;
  lastMessageAt: string | null;
  message: string;
};

type KickRecorderChannelCheck = {
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

declare global {
  interface Window {
    kickRecorder?: {
      loadState: () => Promise<KickRecorderAppState>;
      saveState: (state: KickRecorderAppState) => Promise<{ ok: boolean }>;
      selectOutputDirectory: () => Promise<string | null>;
      notifyLive: (slug: string, details?: {
        displayName?: string;
        streamTitle?: string;
        categoryName?: string;
        startedAt?: string | null;
        viewerCount?: number;
      }) => Promise<{ ok: boolean }>;
      getAppInfo: () => Promise<KickRecorderAppInfo>;
      getKickCredentialsStatus: () => Promise<KickRecorderCredentialsStatus>;
      saveKickCredentials: (credentials: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; clientId: string }>;
      testKickConnection: () => Promise<{ ok: boolean; message: string }>;
      clearKickCredentials: () => Promise<{ ok: boolean }>;
      checkKickChannels: (slugs: string[]) => Promise<KickRecorderChannelCheck[]>;
      getBackgroundMonitorStatus: () => Promise<KickRecorderBackgroundMonitorStatus>;
      onBackgroundMonitorStatus: (callback: (status: KickRecorderBackgroundMonitorStatus) => void) => () => void;
      startChatReceiver: (slugs: string[]) => Promise<KickRecorderChatStatus>;
      stopChatReceiver: () => Promise<KickRecorderChatStatus>;
      getChatReceiverStatus: () => Promise<KickRecorderChatStatus>;
      listChatMessages: (limit: number) => Promise<KickRecorderChatMessage[]>;
      startVodChatDownload: (url: string) => Promise<{ ok: true; outputDirectory: string }>;
      stopVodChatDownload: () => Promise<{ ok: true }>;
      onVodChatStatus: (callback: (event: KickRecorderVodChatEvent) => void) => () => void;
      copyText: (value: string) => Promise<{ ok: boolean }>;
      onChatMessage: (callback: (message: KickRecorderChatMessage) => void) => () => void;
      onChatStatus: (callback: (status: KickRecorderChatStatus) => void) => () => void;
      getUpdateStatus: () => Promise<KickRecorderUpdateStatus>;
      checkForUpdates: () => Promise<KickRecorderUpdateStatus>;
      installUpdate: () => Promise<{ ok: boolean }>;
      onUpdateStatus: (callback: (status: KickRecorderUpdateStatus) => void) => () => void;
      startRecording: (slug: string, sourceUrl?: string) => Promise<{ ok: true; outputDirectory: string }>;
      stopRecording: (slug: string, isVod?: boolean) => Promise<{ ok: true }>;
      listRecordings: () => Promise<KickRecorderRecordingFile[]>;
      deleteRecording: (filePath: string) => Promise<{ ok: true; name: string }>;
      openRecording: (filePath: string) => Promise<{ ok: true }>;
      revealRecording: (filePath: string) => Promise<{ ok: true }>;
      getAiArticleStatus: () => Promise<KickRecorderAiArticleStatus>;
      saveAiArticleKey: (apiKey: string) => Promise<{ ok: true }>;
      clearAiArticleKey: () => Promise<{ ok: true }>;
      testAiArticleConnection: (model: string) => Promise<{ ok: true; message: string }>;
      pullAiArticleModel: (model: string) => Promise<{ ok: true; model: string }>;
      cancelAiArticleModelPull: () => Promise<{ ok: true; cancelled: boolean; model?: string }>;
      onAiArticleModelPullStatus: (callback: (status: KickRecorderAiModelPullStatus) => void) => () => void;
      onStreamArticleUpdate: (callback: (article: KickRecorderStreamArticle) => void) => () => void;
      startManualLiveArticle: (channel: string) => Promise<{ ok: true; slug: string; article: KickRecorderStreamArticle; chatStatus: KickRecorderChatStatus }>;
      stopManualLiveArticle: () => Promise<{ ok: true; slug: string }>;
      onLiveArticleCaptureStatus: (callback: (status: { slug: string; status: "starting" | "capturing" | "completed" | "stopped" | "error"; frameCount: number; message: string }) => void) => () => void;
      listStreamArticles: (slug?: string) => Promise<KickRecorderStreamArticle[]>;
      deleteStreamArticle: (slug: string, id: string) => Promise<{ ok: true; id: string }>;
      generateStreamArticle: (input: { videoPath: string; slug: string; displayName?: string; category?: string; headline?: string; chatPaths?: string[] }) => Promise<KickRecorderStreamArticle>;
      listCommentLogFiles: () => Promise<KickRecorderCommentLogFile[]>;
      previewCommentVideo: (input: { videoPath: string; chatPaths: string[]; delaySeconds?: number }) => Promise<KickRecorderCommentVideoPreview>;
      startCommentVideo: (options: { videoPath: string; chatPath?: string; chatPaths?: string[]; delaySeconds?: number; fontFamily?: "ms-pgothic" | "meiryo" | "yu-gothic" | "arial"; fontSize?: number; displaySeconds?: number; speedPercent?: number; rowLimit?: number; collisionGap?: number; opacity?: number; quality?: "high" | "standard" | "compact"; position?: "scroll" | "top" | "bottom" | "command"; showUsername?: boolean }) => Promise<{ ok: true; outputPath: string }>;
      stopCommentVideo: () => Promise<{ ok: true }>;
      onCommentVideoStatus: (callback: (event: KickRecorderCommentVideoEvent) => void) => () => void;
      onRecordingStatus: (callback: (event: KickRecorderRecordingEvent) => void) => () => void;
    };
  }
}
