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
  isVod?: boolean;
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
  streamTitle: string;
  viewerCount: number;
  startedAt: string | null;
};

declare global {
  interface Window {
    kickRecorder?: {
      loadState: () => Promise<KickRecorderAppState>;
      saveState: (state: KickRecorderAppState) => Promise<{ ok: boolean }>;
      selectOutputDirectory: () => Promise<string | null>;
      notifyLive: (slug: string) => Promise<{ ok: boolean }>;
      getAppInfo: () => Promise<KickRecorderAppInfo>;
      getKickCredentialsStatus: () => Promise<KickRecorderCredentialsStatus>;
      saveKickCredentials: (credentials: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; clientId: string }>;
      testKickConnection: () => Promise<{ ok: boolean; message: string }>;
      clearKickCredentials: () => Promise<{ ok: boolean }>;
      checkKickChannels: (slugs: string[]) => Promise<KickRecorderChannelCheck[]>;
      startChatReceiver: (slugs: string[]) => Promise<KickRecorderChatStatus>;
      stopChatReceiver: () => Promise<KickRecorderChatStatus>;
      getChatReceiverStatus: () => Promise<KickRecorderChatStatus>;
      listChatMessages: (limit: number) => Promise<KickRecorderChatMessage[]>;
      copyText: (value: string) => Promise<{ ok: boolean }>;
      onChatMessage: (callback: (message: KickRecorderChatMessage) => void) => () => void;
      onChatStatus: (callback: (status: KickRecorderChatStatus) => void) => () => void;
      getUpdateStatus: () => Promise<KickRecorderUpdateStatus>;
      checkForUpdates: () => Promise<KickRecorderUpdateStatus>;
      installUpdate: () => Promise<{ ok: boolean }>;
      onUpdateStatus: (callback: (status: KickRecorderUpdateStatus) => void) => () => void;
      startRecording: (slug: string, sourceUrl?: string) => Promise<{ ok: true; outputDirectory: string }>;
      stopRecording: (slug: string) => Promise<{ ok: true }>;
      listRecordings: () => Promise<KickRecorderRecordingFile[]>;
      openRecording: (filePath: string) => Promise<{ ok: true }>;
      revealRecording: (filePath: string) => Promise<{ ok: true }>;
      onRecordingStatus: (callback: (event: KickRecorderRecordingEvent) => void) => () => void;
    };
  }
}
