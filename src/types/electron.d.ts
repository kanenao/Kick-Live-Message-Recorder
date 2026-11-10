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
  isPackaged: boolean;
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

type KickRecorderRecordingStatus = {
  slug: string;
  status: "starting" | "recording" | "reconnecting" | "stopping" | "stopped" | "error";
  startedAt: string;
  filePath: string;
  progress: string;
  message: string;
  reconnectCount: number;
  exitCode?: number | null;
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
      clearKickCredentials: () => Promise<{ ok: boolean }>;
      checkKickChannels: (slugs: string[]) => Promise<KickRecorderChannelCheck[]>;
      selectYtDlp: () => Promise<string | null>;
      selectFfmpeg: () => Promise<string | null>;
      startRecording: (slug: string) => Promise<KickRecorderRecordingStatus>;
      stopRecording: (slug: string) => Promise<KickRecorderRecordingStatus | null>;
      getRecordingStatuses: () => Promise<KickRecorderRecordingStatus[]>;
      onRecordingStatus: (callback: (status: KickRecorderRecordingStatus) => void) => () => void;
      getUpdateStatus: () => Promise<KickRecorderUpdateStatus>;
      checkForUpdates: () => Promise<KickRecorderUpdateStatus>;
      installUpdate: () => Promise<{ ok: boolean }>;
      onUpdateStatus: (callback: (status: KickRecorderUpdateStatus) => void) => () => void;
    };
  }
}
