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
  settings: {
    autoRecordOnStreamStart: boolean;
    saveChat: boolean;
    outputDirectory: string;
    autoMonitorEnabled: boolean;
    monitorIntervalSeconds: number;
    notifyOnLive: boolean;
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
  message: string;
};

type KickRecorderChannelCheck = {
  slug: string;
  broadcasterUserId: number | null;
  found: boolean;
  isLive: boolean;
  streamTitle: string;
  viewerCount: number;
  startedAt: string | null;
};

type KickRecorderChatStatus = { serverRunning: boolean; tunnelRunning: boolean; localUrl: string; publicUrl: string; receivedCount: number; lastMessageAt: string | null; message: string };
type KickRecorderSavedChatMessage = { messageId: string; slug: string; broadcaster: string; user: string; text: string; timestamp: string; receivedAt: string; badges: string[]; emotes: Array<{ emoteId: string; start: number; end: number }> };
type KickRecorderChatEvent = { type: "status"; status: KickRecorderChatStatus } | { type: "message"; message: KickRecorderSavedChatMessage };

declare global {
  interface Window {
    kickRecorder?: {
      loadState: () => Promise<KickRecorderAppState>;
      saveState: (state: KickRecorderAppState) => Promise<{ ok: boolean }>;
      selectOutputDirectory: () => Promise<string | null>;
      notifyLive: (slug: string) => Promise<{ ok: boolean }>;
      getAppInfo: () => Promise<KickRecorderAppInfo>;
      getOllamaStatus: () => Promise<{ connected: boolean; baseUrl: string; models: Array<{ name: string; size: number }>; message?: string }>;
      generateOllamaArticle: (input: { title?: string; broadcaster?: string; startedAt?: string; comments: Array<{ user?: string; text: string; timestamp?: string }> }) => Promise<{ title: string; summary: string; paragraphs: string[]; topics: string[]; provider: string; model: string }>;
      getKickCredentialsStatus: () => Promise<KickRecorderCredentialsStatus>;
      saveKickCredentials: (credentials: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; clientId: string }>;
      clearKickCredentials: () => Promise<{ ok: boolean }>;
      checkKickChannels: (slugs: string[]) => Promise<KickRecorderChannelCheck[]>;
      getChatStatus: () => Promise<KickRecorderChatStatus>;
      startChat: () => Promise<KickRecorderChatStatus>;
      stopChat: () => Promise<KickRecorderChatStatus>;
      subscribeChat: (slugs: string[]) => Promise<Array<{ slug: string; ok: boolean; message: string }>>;
      listChatMessages: (slug: string) => Promise<KickRecorderSavedChatMessage[]>;
      onChatEvent: (callback: (event: KickRecorderChatEvent) => void) => () => void;
      getUpdateStatus: () => Promise<KickRecorderUpdateStatus>;
      checkForUpdates: () => Promise<KickRecorderUpdateStatus>;
      installUpdate: () => Promise<{ ok: boolean }>;
      onUpdateStatus: (callback: (status: KickRecorderUpdateStatus) => void) => () => void;
      startRecording: (slug: string) => Promise<{ ok: true; outputDirectory: string }>;
      stopRecording: (slug: string) => Promise<{ ok: true }>;
      listRecordings: () => Promise<KickRecorderRecordingFile[]>;
      openRecording: (filePath: string) => Promise<{ ok: true }>;
      revealRecording: (filePath: string) => Promise<{ ok: true }>;
      onRecordingStatus: (callback: (event: KickRecorderRecordingEvent) => void) => () => void;
    };
  }
}
