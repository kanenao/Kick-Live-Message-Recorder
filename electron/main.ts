import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";
import { KickChatReceiver } from "./chat";
import { isPathInsideDirectory, KickRecordingManager, listRecordingFiles } from "./recording";

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
  notifyOnLive: boolean;
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
    monitorIntervalSeconds: 60,
    notifyOnLive: true
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
  streamTitle: string;
  viewerCount: number;
  startedAt: string | null;
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
    stream?: {
      is_live?: boolean;
      viewer_count?: number;
      start_time?: string;
    } | null;
  }>;
};

let cachedKickToken: { value: string; expiresAt: number } | null = null;
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

async function checkKickChannels(input: unknown): Promise<KickChannelCheck[]> {
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
      resultBySlug.set(channel.slug.toLowerCase(), {
        slug: channel.slug.toLowerCase(),
        found: true,
        isLive: stream?.is_live === true,
        streamTitle: typeof channel.stream_title === "string" ? channel.stream_title : "",
        viewerCount: typeof stream?.viewer_count === "number" ? stream.viewer_count : 0,
        startedAt: typeof stream?.start_time === "string" ? stream.start_time : null
      });
    }
  }

  return slugs.map(slug => resultBySlug.get(slug) ?? {
    slug,
    found: false,
    isLive: false,
    streamTitle: "",
    viewerCount: 0,
    startedAt: null
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

const recordingManager = new KickRecordingManager(event => {
  mainWindow?.webContents.send("recording:status", event);
});

const chatReceiver = new KickChatReceiver(
  getRecordingOutputDirectory,
  () => readState().settings.saveChat,
  message => mainWindow?.webContents.send("chat:message", message),
  status => mainWindow?.webContents.send("chat:status", status)
);

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
        : 60,
      notifyOnLive: settings.notifyOnLive !== false
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
  return { ok: true };
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

  ipcMain.handle("app:notify-live", (event, slug: unknown) => {
    assertTrustedSender(event);
    if (typeof slug !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(slug)) {
      throw new Error("通知対象のチャンネル名が不正です。");
    }
    if (!Notification.isSupported()) return { ok: false };
    new Notification({
      title: "Kick Recorder - 配信開始",
      body: `${slug} が配信を開始しました。`
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
    return saveKickCredentials(credentials);
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
    return clearKickCredentials();
  });

  ipcMain.handle("kick:check-channels", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return checkKickChannels(slugs);
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

  

  ipcMain.handle("app:copy-text", (event, value: unknown) => {
    assertTrustedSender(event);
    if (typeof value !== "string" || value.length > 4096) throw new Error("コピーするテキストが不正です。");
    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle("recording:start", (event, slug: unknown) => {
    assertTrustedSender(event);
    return recordingManager.start(slug, getRecordingOutputDirectory());
  });

  ipcMain.handle("recording:stop", (event, slug: unknown) => {
    assertTrustedSender(event);
    return recordingManager.stop(slug);
  });

  ipcMain.handle("recording:list", event => {
    assertTrustedSender(event);
    return listRecordingFiles(getRecordingOutputDirectory());
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    app.setAppUserModelId("jp.kanenao.kickrecorder");
    createJapaneseApplicationMenu();
    createWindow();
    initializeAutoUpdater();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  recordingManager.stopAll();
  void chatReceiver.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
