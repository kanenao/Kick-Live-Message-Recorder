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
  };
};

type KickRecorderAppInfo = {
  version: string;
  dataDirectory: string;
  isPackaged: boolean;
};

declare global {
  interface Window {
    kickRecorder?: {
      loadState: () => Promise<KickRecorderAppState>;
      saveState: (state: KickRecorderAppState) => Promise<{ ok: boolean }>;
      selectOutputDirectory: () => Promise<string | null>;
      getAppInfo: () => Promise<KickRecorderAppInfo>;
    };
  }
}
