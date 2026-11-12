import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";
import { KickChatReceiver } from "./chat";
import { KickVodChatDownloader } from "./vod-chat";
import { KickCommentVideoGenerator, listCommentLogFiles } from "./comment-video";
import { deleteRecordingFile, isPathInsideDirectory, KickRecordingManager, listRecordingFiles } from "./recording";

// Chromiumが提供する標準メニューやコンテキストメニューも日本語で表示する。
app.commandLine.appendSwitch("lang", "ja-JP");

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
  recordingRetryCount: number;
  recordingRetryDelaySeconds: number;
  notifyOnLive: boolean;
  showRecordingPreview: boolean;
};

type AppState = {
  channels: Channel[];
  recordingOnlyChannels: Channel[];
  settings: AppSettings;
};

const DEFAULT_STATE: AppState = {
  channels: [],
  recordingOnlyChannels: [],
  settings: {
    autoRecordOnStreamStart: true,
    autoReceiveChat: true,
    autoReceiveChatForRecordingOnly: true,
    saveChat: true,
    outputDirectory: "",
    autoMonitorEnabled: true,
    monitorIntervalSeconds: 10,
    autoRecordRecordingOnlyOnStreamStart: true,
    launchAtLogin: true,
    preventSystemSleep: true,
    recordingRetryCount: 5,
    recordingRetryDelaySeconds: 10,
    notifyOnLive: true,
    showRecordingPreview: true
  }
};


type StoredKickCredentials = {
  clientId: string;
  encryptedClientSecret: string;
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

type BackgroundMonitorStatus = {
  enabled: boolean;
  running: boolean;
  monitoredChannels: number;
  intervalSeconds: number;
  lastCheckAt: string | null;
  lastError: string;
  message: string;
  results: KickChannelCheck[];
};

type KickTokenPayload = {
  access_token?: unknown;
  expires_in?: unknown;
};

type KickChannelPayload = {
  data?: Array<{
    slug?: string;
    broadcaster_user_id?: number;
    stream_title?: string;
    category?: { name?: string; thumbnail?: string } | null;
    stream?: {
      is_live?: boolean;
      viewer_count?: number;
      start_time?: string;
    } | null;
  }>;
};

type KickUsersPayload = {
  data?: Array<{
    user_id?: number;
    name?: string;
    profile_picture?: string;
  }>;
};

type CachedKickUserProfile = {
  name: string;
  profilePicture: string | null;
  expiresAt: number;
};

let cachedKickToken: { value: string; expiresAt: number } | null = null;
const kickUserProfileCache = new Map<number, CachedKickUserProfile>();
let kickChannelRateLimitUntil = 0;

function getKickChannelRateLimitWaitSeconds(response?: Response): number {
  const value = response?.headers.get("retry-after");
  if (!value) return 60;
  const seconds = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Math.max(1, Math.min(3600, Number.isFinite(seconds) ? seconds : 60));
}

function getKickCredentialsPath(): string {
  return join(app.getPath("userData"), "kick-credentials.json");
}

function readKickCredentials(): StoredKickCredentials | null {
  const filePath = getKickCredentialsPath();
  if (!existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredKickCredentials>;
    if (
      typeof parsed.clientId !== "string" ||
      typeof parsed.encryptedClientSecret !== "string"
    ) return null;
    return {
      clientId: parsed.clientId,
      encryptedClientSecret: parsed.encryptedClientSecret
    };
  } catch {
    return null;
  }
}

function getKickCredentialsStatus(): { configured: boolean; encryptionAvailable: boolean; clientId: string } {
  const credentials = readKickCredentials();
  return {
    configured: Boolean(credentials),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    clientId: credentials?.clientId ?? ""
  };
}

function saveKickCredentials(input: unknown): { ok: boolean; clientId: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("このWindows環境では安全な暗号化ストレージを利用できません。");
  }
  if (!input || typeof input !== "object") throw new Error("Client IDとClient Secretを入力してください。");

  const values = input as { clientId?: unknown; clientSecret?: unknown };
  const clientId = typeof values.clientId === "string" ? values.clientId.trim() : "";
  const clientSecret = typeof values.clientSecret === "string" ? values.clientSecret : "";
  if (!clientId || clientId.length > 256 || !clientSecret || clientSecret.length > 1024) {
    throw new Error("Client IDまたはClient Secretが未入力、もしくは長すぎます。");
  }

  const directory = app.getPath("userData");
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `kick-credentials-${process.pid}-${Date.now()}.tmp`);
  const payload: StoredKickCredentials = {
    clientId,
    encryptedClientSecret: safeStorage.encryptString(clientSecret).toString("base64")
  };
  writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, getKickCredentialsPath());
  cachedKickToken = null;
  return { ok: true, clientId };
}

function clearKickCredentials(): { ok: boolean } {
  const filePath = getKickCredentialsPath();
  if (existsSync(filePath)) unlinkSync(filePath);
  cachedKickToken = null;
  return { ok: true };
}

async function getKickAccessToken(): Promise<string> {
  if (cachedKickToken && cachedKickToken.expiresAt > Date.now() + 60_000) {
    return cachedKickToken.value;
  }

  const stored = readKickCredentials();
  if (!stored) throw new Error("Kick APIのClient IDとClient Secretを設定してください。");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("保存した認証情報を復号できません。このPCで再設定してください。");
  }

  let clientSecret: string;
  try {
    clientSecret = safeStorage.decryptString(Buffer.from(stored.encryptedClientSecret, "base64"));
  } catch {
    throw new Error("Kick APIの認証情報を読み取れません。Client Secretを再設定してください。");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: stored.clientId,
    client_secret: clientSecret
  });

  let response: Response;
  try {
    response = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error("Kickの認証サーバーに接続できません。ネットワークを確認してください。");
  }

  if (!response.ok) {
    throw new Error(`Kick APIの認証に失敗しました（HTTP ${response.status}）。Client ID/Secretを確認してください。`);
  }

  const tokenPayload = await response.json() as KickTokenPayload;
  if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
    throw new Error("Kick APIからアクセストークンを取得できませんでした。");
  }

  const expiresIn = typeof tokenPayload.expires_in === "number" ? tokenPayload.expires_in : 3600;
  cachedKickToken = {
    value: tokenPayload.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
  };
  return cachedKickToken.value;
}

async function checkKickChannels(input: unknown, includeProfiles = true): Promise<KickChannelCheck[]> {
  if (!Array.isArray(input)) throw new Error("チャンネル一覧が不正です。");
  const slugs = [...new Set(input.filter((value): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value)
  ).map(value => value.toLowerCase()))].slice(0, 200);

  if (slugs.length === 0) return [];

  const remainingCooldown = Math.ceil((kickChannelRateLimitUntil - Date.now()) / 1000);
  if (remainingCooldown > 0) {
    throw new Error(`Kick APIのアクセス制限により自動監視を一時停止しています。約${remainingCooldown}秒後に再開します。`);
  }
  kickChannelRateLimitUntil = 0;

  const accessToken = await getKickAccessToken();
  const resultBySlug = new Map<string, KickChannelCheck>();

  for (let offset = 0; offset < slugs.length; offset += 50) {
    const batch = slugs.slice(offset, offset + 50);
    const url = new URL("https://api.kick.com/public/v1/channels");
    for (const slug of batch) url.searchParams.append("slug", slug);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" },
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new Error("Kick APIに接続できません。ネットワークを確認してください。");
    }

    if (response.status === 429) {
      const waitSeconds = getKickChannelRateLimitWaitSeconds(response);
      kickChannelRateLimitUntil = Date.now() + waitSeconds * 1000;
      throw new Error(`Kick APIのアクセス制限に達しました。Retry-Afterに従い約${waitSeconds}秒間、配信監視を自動待機します。`);
    }
    if (!response.ok) {
      throw new Error(`Kickチャンネル情報の取得に失敗しました（HTTP ${response.status}）。`);
    }

    const payload = await response.json() as KickChannelPayload;
    if (!Array.isArray(payload.data)) {
      throw new Error("Kick APIから予期しない形式の応答が返されました。");
    }

    for (const channel of payload.data) {
      if (typeof channel.slug !== "string") continue;
      const stream = channel.stream;
      const broadcasterUserId = typeof channel.broadcaster_user_id === "number" &&
        Number.isSafeInteger(channel.broadcaster_user_id) && channel.broadcaster_user_id > 0
        ? channel.broadcaster_user_id
        : null;
      const category = channel.category;
      resultBySlug.set(channel.slug.toLowerCase(), {
        slug: channel.slug.toLowerCase(),
        found: true,
        isLive: stream?.is_live === true,
        displayName: channel.slug,
        profilePicture: null,
        broadcasterUserId,
        streamTitle: typeof channel.stream_title === "string" ? channel.stream_title : "",
        categoryName: typeof category?.name === "string" ? category.name : "",
        categoryThumbnail: typeof category?.thumbnail === "string" ? category.thumbnail : null,
        viewerCount: typeof stream?.viewer_count === "number" ? stream.viewer_count : 0,
        startedAt: typeof stream?.start_time === "string" ? stream.start_time : null
      });
    }
  }

  // 表示名とプロフィール画像はユーザー情報APIから取得。6時間キャッシュし、定期監視の追加API呼び出しを抑える。
  const userIds = includeProfiles ? [...new Set([...resultBySlug.values()]
    .map(channel => channel.broadcasterUserId)
    .filter((id): id is number => id !== null))] : [];
  const now = Date.now();
  const unresolvedUserIds = userIds.filter(id => {
    const cached = kickUserProfileCache.get(id);
    return !cached || cached.expiresAt <= now;
  });

  for (let offset = 0; offset < unresolvedUserIds.length; offset += 100) {
    const batch = unresolvedUserIds.slice(offset, offset + 100);
    const usersUrl = new URL("https://api.kick.com/public/v1/users");
    for (const id of batch) usersUrl.searchParams.append("id", String(id));
    try {
      const usersResponse = await fetch(usersUrl, {
        headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" },
        signal: AbortSignal.timeout(10_000)
      });
      if (usersResponse.ok) {
        const usersPayload = await usersResponse.json() as KickUsersPayload;
        if (Array.isArray(usersPayload.data)) {
          for (const user of usersPayload.data) {
            if (typeof user.user_id !== "number" || !Number.isSafeInteger(user.user_id) ||
              typeof user.name !== "string" || !user.name.trim()) continue;
            const picture = typeof user.profile_picture === "string" &&
              /^https:\/\//i.test(user.profile_picture)
              ? user.profile_picture
              : null;
            kickUserProfileCache.set(user.user_id, {
              name: user.name.trim().slice(0, 100),
              profilePicture: picture,
              expiresAt: now + 6 * 60 * 60 * 1000
            });
          }
        }
      }
    } catch {
      // ユーザー表示名APIだけ失敗した場合でも、配信監視とLIVE状態表示は継続する。
    }
  }

  return slugs.map(slug => {
    const result = resultBySlug.get(slug);
    if (!result) {
      return {
        slug,
        found: false,
        isLive: false,
        displayName: slug,
        profilePicture: null,
        broadcasterUserId: null,
        streamTitle: "",
        categoryName: "",
        categoryThumbnail: null,
        viewerCount: 0,
        startedAt: null
      };
    }
    const profile = includeProfiles && result.broadcasterUserId
      ? kickUserProfileCache.get(result.broadcasterUserId)
      : undefined;
    return {
      ...result,
      displayName: profile?.name ?? result.displayName,
      profilePicture: profile?.profilePicture ?? null
    };
  });
}

type UpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message: string;
};

let updateStatus: UpdateStatus = {
  status: "idle",
  currentVersion: app.getVersion(),
  message: "起動時に自動で更新を確認します。"
};

function publishUpdateStatus(next: Partial<UpdateStatus>): void {
  updateStatus = { ...updateStatus, ...next, currentVersion: app.getVersion() };
  mainWindow?.webContents.send("updater:status", updateStatus);
}

function initializeAutoUpdater(): void {
  if (!app.isPackaged || process.platform !== "win32") return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = app.getVersion().includes("-");

  autoUpdater.on("checking-for-update", () => {
    publishUpdateStatus({
      status: "checking",
      percent: 0,
      message: "新しいバージョンを確認しています。"
    });
  });

  autoUpdater.on("update-available", info => {
    publishUpdateStatus({
      status: "available",
      availableVersion: info.version,
      percent: 0,
      message: `新しいバージョン ${info.version} が見つかりました。自動でダウンロードします。`
    });
  });

  autoUpdater.on("download-progress", progress => {
    publishUpdateStatus({
      status: "downloading",
      percent: Math.max(0, Math.min(100, progress.percent)),
      message: `更新をダウンロードしています（${Math.round(progress.percent)}%）。`
    });
  });

  autoUpdater.on("update-downloaded", info => {
    publishUpdateStatus({
      status: "downloaded",
      availableVersion: info.version,
      percent: 100,
      message: `バージョン ${info.version} をダウンロードしました。再起動して更新できます。`
    });
  });

  autoUpdater.on("update-not-available", () => {
    publishUpdateStatus({
      status: "not-available",
      availableVersion: undefined,
      percent: 100,
      message: "現在のバージョンは最新です。"
    });
  });

  autoUpdater.on("error", error => {
    publishUpdateStatus({
      status: "error",
      message: `更新の確認・ダウンロードに失敗しました：${error.message}`
    });
  });

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(error => {
      publishUpdateStatus({
        status: "error",
        message: `更新の確認に失敗しました：${error instanceof Error ? error.message : String(error)}`
      });
    });
  };

  // 起動直後と6時間ごとに確認。取得した更新は自動ダウンロードし、アプリ終了時に適用する。
  setTimeout(check, 5_000);
  const periodicCheck = setInterval(check, 6 * 60 * 60 * 1000);
  periodicCheck.unref();
}

let mainWindow: BrowserWindow | null = null;

function createTray(): void {
  if (tray) return;
  tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, "base64")));
  tray.setToolTip("Kick Live Message Recorder");
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  publishBackgroundMonitorStatus();
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const recordingManager = new KickRecordingManager(event => {
  mainWindow?.webContents.send("recording:status", event);
});

const commentVideoGenerator = new KickCommentVideoGenerator(event => {
  mainWindow?.webContents.send("comment-video:status", event);
});

const chatReceiver = new KickChatReceiver(
  getRecordingOutputDirectory,
  () => readState().settings.saveChat,
  message => mainWindow?.webContents.send("chat:message", message),
  status => mainWindow?.webContents.send("chat:status", status)
);

const vodChatDownloader = new KickVodChatDownloader(event => {
  mainWindow?.webContents.send("vod-chat:status", event);
});

function getRecordingOutputDirectory(): string {
  const configured = readState().settings.outputDirectory.trim();
  return configured || join(app.getPath("videos"), "Kick Live Message Recorder");
}

function normalizeState(input: unknown): AppState {
  if (!input || typeof input !== "object") return DEFAULT_STATE;
  const candidate = input as Partial<AppState>;

  const normalizeChannels = (items: unknown, recordingOnly = false): Channel[] =>
    Array.isArray(items)
      ? items.slice(0, 200).flatMap((item): Channel[] => {
          if (!item || typeof item !== "object") return [];
          const channel = item as Partial<Channel>;
          if (
            typeof channel.id !== "number" ||
            !Number.isFinite(channel.id) ||
            typeof channel.name !== "string" ||
            !/^[a-zA-Z0-9_]{1,25}$/.test(channel.name) ||
            (!recordingOnly && channel.mode !== "auto" && channel.mode !== "manual")
          ) return [];

          return [{
            id: channel.id,
            name: channel.name,
            url: `https://kick.com/${channel.name}`,
            mode: recordingOnly ? "manual" : channel.mode as "auto" | "manual",
            status: "待機中",
            recording: false
          }];
        })
      : [];

  const channels = normalizeChannels(candidate.channels);
  const recordingOnlyChannels = normalizeChannels(candidate.recordingOnlyChannels, true);
  const settings = candidate.settings && typeof candidate.settings === "object"
    ? candidate.settings
    : DEFAULT_STATE.settings;

  return {
    channels,
    recordingOnlyChannels,
    settings: {
      autoRecordOnStreamStart: settings.autoRecordOnStreamStart !== false,
      autoReceiveChat: settings.autoReceiveChat !== false,
      autoReceiveChatForRecordingOnly: settings.autoReceiveChatForRecordingOnly !== false,
      saveChat: settings.saveChat !== false,
      outputDirectory: typeof settings.outputDirectory === "string"
        ? settings.outputDirectory.slice(0, 4096)
        : "",
      autoMonitorEnabled: settings.autoMonitorEnabled !== false,
      monitorIntervalSeconds: typeof settings.monitorIntervalSeconds === "number" &&
        Number.isFinite(settings.monitorIntervalSeconds)
        ? Math.max(10, Math.min(3600, Math.round(settings.monitorIntervalSeconds)))
        : 10,
      autoRecordRecordingOnlyOnStreamStart: settings.autoRecordRecordingOnlyOnStreamStart !== false,
      launchAtLogin: settings.launchAtLogin !== false,
      preventSystemSleep: settings.preventSystemSleep !== false,
      recordingRetryCount: typeof settings.recordingRetryCount === "number" &&
        Number.isFinite(settings.recordingRetryCount)
        ? Math.max(0, Math.min(10, Math.round(settings.recordingRetryCount)))
        : 5,
      recordingRetryDelaySeconds: typeof settings.recordingRetryDelaySeconds === "number" &&
        Number.isFinite(settings.recordingRetryDelaySeconds)
        ? Math.max(5, Math.min(60, Math.round(settings.recordingRetryDelaySeconds)))
        : 10,
      notifyOnLive: settings.notifyOnLive !== false,
      showRecordingPreview: settings.showRecordingPreview !== false
    }
  };
}

function getStateFilePath(): string {
  return join(app.getPath("userData"), "state.json");
}

function readState(): AppState {
  const filePath = getStateFilePath();
  if (!existsSync(filePath)) return DEFAULT_STATE;

  try {
    return normalizeState(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    console.error("Failed to read settings file:", error);
    return DEFAULT_STATE;
  }
}

function writeState(input: unknown): { ok: boolean } {
  const directory = app.getPath("userData");
  mkdirSync(directory, { recursive: true });
  const filePath = getStateFilePath();
  const temporaryPath = join(directory, `state-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporaryPath, JSON.stringify(normalizeState(input), null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  renameSync(temporaryPath, filePath);
  configureBackgroundServices();
  return { ok: true };
}

type BackgroundMonitorPatch = Partial<BackgroundMonitorStatus>;
const TRAY_ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAdElEQVR42mNgGAWjAA0Iy8n8pyUedQBdHeB/Zzp1HAAyCBkTa/mAOICQWpo6gBh1NHEAKSFEdQeQmj6o6gByEidVHECOxTRzAF0KImpYPPxCYEDTwIDngkFTDgyKknBQ1AWDpjakWXtgwFtEI6tROgpGHAAAwzanI8DLYZ4AAAAASUVORK5CYII=";

let tray: Tray | null = null;
let isQuitting = false;
let backgroundMonitorTimer: NodeJS.Timeout | null = null;
let backgroundMonitorInFlight = false;
let backgroundMonitorSignature = "";
let backgroundChatSignature = "";
let sleepBlockerId: number | null = null;
const backgroundPreviousLiveState = new Map<string, boolean>();
let backgroundMonitorStatus: BackgroundMonitorStatus = {
  enabled: true, running: false, monitoredChannels: 0, intervalSeconds: 10,
  lastCheckAt: null, lastError: "", message: "バックグラウンド監視を初期化しています。", results: []
};

function publishBackgroundMonitorStatus(patch: BackgroundMonitorPatch = {}): void {
  backgroundMonitorStatus = { ...backgroundMonitorStatus, ...patch };
  tray?.setToolTip("Kick Live Message Recorder\n" + (backgroundMonitorStatus.running
    ? `24時間監視中 · ${backgroundMonitorStatus.monitoredChannels}チャンネル`
    : backgroundMonitorStatus.message));
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: backgroundMonitorStatus.running
      ? `監視中：${backgroundMonitorStatus.monitoredChannels}チャンネル・${backgroundMonitorStatus.intervalSeconds}秒間隔`
      : "監視停止中：" + backgroundMonitorStatus.message, enabled: false },
    { type: "separator" },
    { label: "ウィンドウを開く", click: () => showMainWindow() },
    { label: "今すぐ配信状態を確認", enabled: backgroundMonitorStatus.running, click: () => { void runBackgroundMonitor(); } },
    { type: "separator" },
    { label: "アプリを終了", click: () => app.quit() }
  ]));
  mainWindow?.webContents.send("monitor:status", backgroundMonitorStatus);
}

function updateLaunchAtLogin(): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: readState().settings.launchAtLogin, path: process.execPath, args: ["--background"] });
  } catch (error) {
    console.error("Failed to update Windows login startup:", error);
  }
}

function updateSleepBlocker(enabled: boolean): void {
  if (enabled && sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  else if (!enabled && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

function getBackgroundChatSlugs(state: AppState): string[] {
  const selected = [
    ...(state.settings.autoReceiveChat ? state.channels : []),
    ...(state.settings.autoReceiveChatForRecordingOnly ? state.recordingOnlyChannels : [])
  ];
  return [...new Set(selected.map(channel => channel.name.toLowerCase()))];
}

function syncBackgroundChatReceiver(state: AppState): void {
  const slugs = getBackgroundChatSlugs(state);
  const signature = slugs.join("|");
  const desired = chatReceiver.getDesiredSlugs().join("|");
  if (!signature) {
    backgroundChatSignature = "";
    if (desired) void chatReceiver.stop().catch(error => console.error("Chat receiver stop failed:", error));
    return;
  }
  if (slugs.length > 50) {
    backgroundChatSignature = "";
    publishBackgroundMonitorStatus({ lastError: "コメント自動取得は最大50チャンネルです。対象を50件以内にしてください。" });
    return;
  }
  if (desired === signature && backgroundChatSignature === signature) return;
  if (desired === signature) {
    backgroundChatSignature = signature;
    return;
  }
  backgroundChatSignature = signature;
  void chatReceiver.start(slugs).catch(error => {
    if (backgroundChatSignature === signature) backgroundChatSignature = "";
    console.error("Background chat receiver start failed:", error);
    publishBackgroundMonitorStatus({
      lastError: "コメント接続エラー：" + (error instanceof Error ? error.message : String(error)),
      message: "配信監視中。コメント受信は再試行します。"
    });
  });
}

function scheduleBackgroundMonitor(delayMs: number): void {
  if (backgroundMonitorTimer) clearTimeout(backgroundMonitorTimer);
  backgroundMonitorTimer = setTimeout(() => {
    backgroundMonitorTimer = null;
    void runBackgroundMonitor();
  }, Math.max(0, delayMs));
}

function notifyBackgroundLive(result: KickChannelCheck, recordingStarted: boolean): void {
  if (!Notification.isSupported()) return;
  const details = [
    result.streamTitle || "配信タイトル未設定",
    result.categoryName,
    result.startedAt ? "開始 " + new Date(result.startedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "",
    result.viewerCount.toLocaleString("ja-JP") + " 人視聴中",
    recordingStarted ? "自動録画・コメント取得を開始しました。" : "配信を検知しました。"
  ].filter(Boolean).join(" ・ ");
  new Notification({ title: (result.displayName || result.slug) + " がLIVEを開始しました", body: details }).show();
}

async function runBackgroundMonitor(): Promise<void> {
  if (backgroundMonitorInFlight || isQuitting) return;
  const state = readState();
  const slugs = [...new Set([
    ...state.channels.map(channel => channel.name.toLowerCase()),
    ...state.recordingOnlyChannels.map(channel => channel.name.toLowerCase())
  ])].slice(0, 200);

  if (!state.settings.autoMonitorEnabled || slugs.length === 0 || !getKickCredentialsStatus().configured) {
    publishBackgroundMonitorStatus({
      running: false, enabled: state.settings.autoMonitorEnabled, monitoredChannels: slugs.length,
      intervalSeconds: state.settings.monitorIntervalSeconds,
      message: !state.settings.autoMonitorEnabled ? "自動監視は設定で停止中です。"
        : slugs.length === 0 ? "監視するチャンネルを登録してください。"
        : "Kick APIのClient ID／Secretを設定してください。"
    });
    updateSleepBlocker(false);
    return;
  }

  backgroundMonitorInFlight = true;
  publishBackgroundMonitorStatus({
    enabled: true, running: true, monitoredChannels: slugs.length,
    intervalSeconds: state.settings.monitorIntervalSeconds, message: "バックグラウンドで配信状態を確認しています。"
  });
  let nextDelay = Math.max(10, state.settings.monitorIntervalSeconds) * 1000;
  try {
    // Skip additional profile lookups to prioritize the LIVE status request.
    const results = await checkKickChannels(slugs, false);
    for (const result of results) {
      const live = result.found && result.isLive;
      const wasLive = backgroundPreviousLiveState.get(result.slug) === true;
      backgroundPreviousLiveState.set(result.slug, live);
      if (!live || wasLive) continue;

      const normalChannel = state.channels.find(channel => channel.name.toLowerCase() === result.slug);
      const recordingOnly = state.recordingOnlyChannels.find(channel => channel.name.toLowerCase() === result.slug);
      const shouldRecord = state.settings.autoRecordOnStreamStart && (
        normalChannel?.mode === "auto" ||
        (!normalChannel && Boolean(recordingOnly) && state.settings.autoRecordRecordingOnlyOnStreamStart)
      );
      let recordingStarted = false;
      if (shouldRecord && !recordingManager.isRecording(result.slug)) {
        try {
          recordingManager.start(result.slug, getRecordingOutputDirectory(), {
            retryCount: state.settings.recordingRetryCount,
            retryDelaySeconds: state.settings.recordingRetryDelaySeconds
          });
          recordingStarted = true;
        } catch (error) {
          publishBackgroundMonitorStatus({
            lastError: result.slug + " の自動録画開始に失敗：" + (error instanceof Error ? error.message : String(error))
          });
        }
      }
      if (state.settings.notifyOnLive) notifyBackgroundLive(result, recordingStarted);
    }
    for (const key of [...backgroundPreviousLiveState.keys()]) {
      if (!slugs.includes(key)) backgroundPreviousLiveState.delete(key);
    }
    const lastCheckAt = new Date().toISOString();
    publishBackgroundMonitorStatus({
      running: true, monitoredChannels: slugs.length, intervalSeconds: state.settings.monitorIntervalSeconds,
      lastCheckAt, lastError: "", results,
      message: `24時間監視中 · ${slugs.length}チャンネル · 約${state.settings.monitorIntervalSeconds}秒間隔`
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const retryAfterMs = Math.max(0, kickChannelRateLimitUntil - Date.now());
    if (retryAfterMs > 0) nextDelay = Math.max(nextDelay, retryAfterMs + 1000);
    publishBackgroundMonitorStatus({
      running: true, monitoredChannels: slugs.length, intervalSeconds: state.settings.monitorIntervalSeconds,
      lastError: detail, message: "監視エラー。自動再試行します。"
    });
  } finally {
    backgroundMonitorInFlight = false;
    const latest = readState();
    if (latest.settings.autoMonitorEnabled && (latest.channels.length || latest.recordingOnlyChannels.length) &&
      getKickCredentialsStatus().configured && !isQuitting) scheduleBackgroundMonitor(nextDelay);
  }
}

function configureBackgroundServices(): void {
  updateLaunchAtLogin();
  const state = readState();
  syncBackgroundChatReceiver(state);
  const slugs = [...new Set([
    ...state.channels.map(channel => channel.name.toLowerCase()),
    ...state.recordingOnlyChannels.map(channel => channel.name.toLowerCase())
  ])].slice(0, 200);
  const enabled = state.settings.autoMonitorEnabled && slugs.length > 0 && getKickCredentialsStatus().configured;
  const signature = JSON.stringify({
    enabled: state.settings.autoMonitorEnabled, slugs, interval: state.settings.monitorIntervalSeconds,
    autoRecord: state.settings.autoRecordOnStreamStart,
    autoRecordRecordingOnly: state.settings.autoRecordRecordingOnlyOnStreamStart,
    notify: state.settings.notifyOnLive, preventSleep: state.settings.preventSystemSleep,
    credentials: getKickCredentialsStatus().configured
  });
  if (signature === backgroundMonitorSignature) return;
  backgroundMonitorSignature = signature;
  if (backgroundMonitorTimer) {
    clearTimeout(backgroundMonitorTimer);
    backgroundMonitorTimer = null;
  }
  if (!enabled) {
    publishBackgroundMonitorStatus({
      enabled: state.settings.autoMonitorEnabled, running: false, monitoredChannels: slugs.length,
      intervalSeconds: state.settings.monitorIntervalSeconds,
      message: !state.settings.autoMonitorEnabled ? "自動監視は設定で停止中です。"
        : slugs.length === 0 ? "監視するチャンネルを登録してください。"
        : "Kick APIのClient ID／Secretを設定してください。"
    });
    updateSleepBlocker(false);
    return;
  }
  updateSleepBlocker(state.settings.preventSystemSleep);
  publishBackgroundMonitorStatus({
    enabled: true, running: true, monitoredChannels: slugs.length,
    intervalSeconds: state.settings.monitorIntervalSeconds, lastError: "", message: "24時間監視を開始しています。"
  });
  scheduleBackgroundMonitor(0);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || BrowserWindow.fromWebContents(event.sender) !== mainWindow) {
    throw new Error("Untrusted IPC sender");
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("app:load-state", event => {
    assertTrustedSender(event);
    return readState();
  });

  ipcMain.handle("app:save-state", (event, state: unknown) => {
    assertTrustedSender(event);
    return writeState(state);
  });

  ipcMain.handle("app:select-output-directory", async event => {
    assertTrustedSender(event);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "録画データの保存先を選択",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("app:notify-live", (event, slug: unknown, details?: unknown) => {
    assertTrustedSender(event);
    if (typeof slug !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(slug)) {
      throw new Error("通知対象のチャンネル名が不正です。");
    }
    const values = details && typeof details === "object" ? details as {
      displayName?: unknown;
      streamTitle?: unknown;
      categoryName?: unknown;
      startedAt?: unknown;
      viewerCount?: unknown;
    } : {};
    const displayName = typeof values.displayName === "string" ? values.displayName.trim().slice(0, 100) : slug;
    const streamTitle = typeof values.streamTitle === "string" ? values.streamTitle.trim().slice(0, 180) : "";
    const categoryName = typeof values.categoryName === "string" ? values.categoryName.trim().slice(0, 80) : "";
    const startedAt = typeof values.startedAt === "string" && !Number.isNaN(Date.parse(values.startedAt))
      ? new Date(values.startedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
      : "";
    const viewerCount = typeof values.viewerCount === "number" && Number.isFinite(values.viewerCount)
      ? Math.max(0, Math.floor(values.viewerCount))
      : null;
    if (!Notification.isSupported()) return { ok: false };
    const body = [
      streamTitle || "配信タイトル未設定",
      categoryName,
      startedAt ? "開始 " + startedAt : "",
      viewerCount !== null ? viewerCount.toLocaleString("ja-JP") + " 人視聴中" : ""
    ].filter(Boolean).join(" ・ ");
    new Notification({
      title: displayName + " がLIVEを開始しました",
      body
    }).show();
    return { ok: true };
  });

  ipcMain.handle("app:get-info", event => {
    assertTrustedSender(event);
    return {
      version: app.getVersion(),
      dataDirectory: app.getPath("userData"),
      defaultOutputDirectory: getRecordingOutputDirectory(),
      isPackaged: app.isPackaged
    };
  });

  ipcMain.handle("updater:get-status", event => {
    assertTrustedSender(event);
    return updateStatus;
  });

  ipcMain.handle("updater:check", async event => {
    assertTrustedSender(event);
    if (!app.isPackaged || process.platform !== "win32") {
      throw new Error("自動更新はインストール済みのWindows版で利用できます。");
    }
    await autoUpdater.checkForUpdates();
    return updateStatus;
  });

  ipcMain.handle("updater:install", event => {
    assertTrustedSender(event);
    if (updateStatus.status !== "downloaded") {
      throw new Error("更新ファイルのダウンロードが完了していません。");
    }
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle("kick:get-credentials-status", event => {
    assertTrustedSender(event);
    return getKickCredentialsStatus();
  });

  ipcMain.handle("kick:save-credentials", (event, credentials: unknown) => {
    assertTrustedSender(event);
    const result = saveKickCredentials(credentials);
    configureBackgroundServices();
    return result;
  });

  ipcMain.handle("kick:test-connection", async event => {
    assertTrustedSender(event);
    // Client CredentialsでApp Access Tokenを取得できるか確認する。
    await getKickAccessToken();
    return {
      ok: true,
      message: "Kick APIの認証に成功しました。App Access Tokenを取得できました。"
    };
  });

  ipcMain.handle("kick:clear-credentials", event => {
    assertTrustedSender(event);
    const result = clearKickCredentials();
    configureBackgroundServices();
    return result;
  });

  ipcMain.handle("kick:check-channels", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return checkKickChannels(slugs);
  });

  ipcMain.handle("monitor:get-status", event => {
    assertTrustedSender(event);
    return backgroundMonitorStatus;
  });

  ipcMain.handle("chat:start", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return chatReceiver.start(slugs);
  });

  ipcMain.handle("chat:stop", async event => {
    assertTrustedSender(event);
    return chatReceiver.stop();
  });

  ipcMain.handle("chat:get-status", event => {
    assertTrustedSender(event);
    return chatReceiver.getStatus();
  });

  ipcMain.handle("chat:list", (event, limit: unknown) => {
    assertTrustedSender(event);
    const boundedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : 100;
    return chatReceiver.listRecentMessages(boundedLimit);
  });

  ipcMain.handle("vod-chat:start", (event, url: unknown) => {
    assertTrustedSender(event);
    return vodChatDownloader.start(url, getRecordingOutputDirectory());
  });

  ipcMain.handle("vod-chat:stop", event => {
    assertTrustedSender(event);
    return vodChatDownloader.stop();
  });

  

  ipcMain.handle("app:copy-text", (event, value: unknown) => {
    assertTrustedSender(event);
    if (typeof value !== "string" || value.length > 4096) throw new Error("コピーするテキストが不正です。");
    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle("recording:start", (event, slug: unknown, sourceUrl?: unknown) => {
    assertTrustedSender(event);
    const settings = readState().settings;
    return recordingManager.start(slug, getRecordingOutputDirectory(), {
      retryCount: settings.recordingRetryCount,
      retryDelaySeconds: settings.recordingRetryDelaySeconds
    }, sourceUrl);
  });

  ipcMain.handle("recording:stop", (event, slug: unknown, isVod?: unknown) => {
    assertTrustedSender(event);
    return recordingManager.stop(slug, isVod ?? false);
  });

  ipcMain.handle("recording:list", event => {
    assertTrustedSender(event);
    return listRecordingFiles(getRecordingOutputDirectory());
  });

  ipcMain.handle("comment-video:list-logs", event => {
    assertTrustedSender(event);
    return listCommentLogFiles(getRecordingOutputDirectory());
  });

  ipcMain.handle("comment-video:start", (event, input: unknown) => {
    assertTrustedSender(event);
    return commentVideoGenerator.start(input, getRecordingOutputDirectory(), filePath => recordingManager.isFileActive(filePath));
  });

  ipcMain.handle("comment-video:stop", event => {
    assertTrustedSender(event);
    return commentVideoGenerator.stop();
  });

  ipcMain.handle("recording:delete", (event, filePath: unknown) => {
    assertTrustedSender(event);
    if (typeof filePath !== "string" || filePath.length > 4096) {
      throw new Error("削除する録画ファイルの場所が不正です。");
    }
    return deleteRecordingFile(
      getRecordingOutputDirectory(),
      filePath,
      target => recordingManager.isFileActive(target)
    );
  });

  ipcMain.handle("recording:open", async (event, filePath: unknown) => {
    assertTrustedSender(event);
    const directory = getRecordingOutputDirectory();
    if (typeof filePath !== "string" || !isPathInsideDirectory(filePath, directory) || !existsSync(filePath)) {
      throw new Error("録画ファイルの場所が不正か、すでに削除されています。");
    }
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`録画ファイルを開けませんでした：${error}`);
    return { ok: true };
  });

  ipcMain.handle("recording:reveal", (event, filePath: unknown) => {
    assertTrustedSender(event);
    const directory = getRecordingOutputDirectory();
    if (typeof filePath !== "string" || !isPathInsideDirectory(filePath, directory) || !existsSync(filePath)) {
      throw new Error("録画ファイルの場所が不正か、すでに削除されています。");
    }
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
}


function createJapaneseApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "ファイル",
      submenu: [
        { label: "ウィンドウを閉じる", role: "close" },
        { type: "separator" },
        { label: "Kick Live Message Recorderを終了", role: "quit" }
      ]
    },
    {
      label: "編集",
      submenu: [
        { label: "元に戻す", role: "undo" },
        { label: "やり直す", role: "redo" },
        { type: "separator" },
        { label: "切り取り", role: "cut" },
        { label: "コピー", role: "copy" },
        { label: "貼り付け", role: "paste" },
        { label: "削除", role: "delete" },
        { type: "separator" },
        { label: "すべて選択", role: "selectAll" }
      ]
    },
    {
      label: "表示",
      submenu: [
        { label: "再読み込み", role: "reload" },
        { label: "強制再読み込み", role: "forceReload" },
        {
          label: "開発者ツール",
          role: "toggleDevTools",
          enabled: !app.isPackaged
        },
        { type: "separator" },
        { label: "拡大", role: "zoomIn" },
        { label: "縮小", role: "zoomOut" },
        { label: "標準サイズに戻す", role: "resetZoom" },
        { type: "separator" },
        { label: "全画面表示", role: "togglefullscreen" }
      ]
    },
    {
      label: "ウィンドウ",
      submenu: [
        { label: "最小化", role: "minimize" },
        { label: "ズーム", role: "zoom" },
        { label: "閉じる", role: "close" }
      ]
    },
    {
      label: "ヘルプ",
      submenu: [
        {
          label: "GitHubリポジトリを開く",
          click: () => { void shell.openExternal("https://github.com/kanenao/Kick-Live-Message-Recorder"); }
        },
        {
          label: "不具合・改善案を報告",
          click: () => { void shell.openExternal("https://github.com/kanenao/Kick-Live-Message-Recorder/issues"); }
        },
        {
          label: "更新を確認",
          enabled: app.isPackaged && process.platform === "win32",
          click: () => {
            void autoUpdater.checkForUpdates().catch(error => {
              dialog.showErrorBox(
                "更新の確認に失敗しました",
                error instanceof Error ? error.message : String(error)
              );
            });
          }
        },
        { type: "separator" },
        {
          label: "バージョン情報",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "Kick Live Message Recorderについて",
              message: "Kick Live Message Recorder",
              detail: `バージョン：${app.getVersion()}\nKick配信の監視・録画・チャット保存ツール`
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(showImmediately = true): void {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#111318",
    title: "Kick Live Message Recorder - 配信録画・チャット保存",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.on("context-menu", (event, params) => {
    if (!mainWindow) return;

    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { label: "元に戻す", role: "undo" },
        { label: "やり直す", role: "redo" },
        { type: "separator" },
        { label: "切り取り", role: "cut" },
        { label: "コピー", role: "copy" },
        { label: "貼り付け", role: "paste" },
        { type: "separator" },
        { label: "すべて選択", role: "selectAll" }
      );
    } else if (params.selectionText.trim()) {
      items.push({ label: "選択した文字をコピー", role: "copy" });
    }

    if (params.linkURL) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push(
        {
          label: "リンクを開く",
          click: () => { void shell.openExternal(params.linkURL); }
        },
        {
          label: "リンクアドレスをコピー",
          click: () => clipboard.writeText(params.linkURL)
        }
      );
    }

    if (items.length > 0) {
      event.preventDefault();
      Menu.buildFromTemplate(items).popup({ window: mainWindow });
    }
  });

  mainWindow.on("close", event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.once("ready-to-show", () => {
    if (showImmediately) mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const devUrl = process.env.KICK_RECORDER_DEV_SERVER_URL;
    const allowed = devUrl
      ? navigationUrl.startsWith(devUrl)
      : navigationUrl.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  const devUrl = process.env.KICK_RECORDER_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(() => {
    registerIpcHandlers();
    app.setAppUserModelId("jp.kanenao.kickrecorder");
    createJapaneseApplicationMenu();
    createTray();
    configureBackgroundServices();
    initializeAutoUpdater();
    const startedInBackground = process.argv.includes("--background") ||
      app.getLoginItemSettings().wasOpenedAtLogin;
    createWindow(!startedInBackground);
    app.on("activate", () => showMainWindow());
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  if (backgroundMonitorTimer) clearTimeout(backgroundMonitorTimer);
  backgroundMonitorTimer = null;
  updateSleepBlocker(false);
  tray?.destroy();
  tray = null;
  recordingManager.stopAll();
  void chatReceiver.stop();
  vodChatDownloader.stopAll();
  commentVideoGenerator.stopAll();
});
