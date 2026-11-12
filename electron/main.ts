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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";
import { isPathInsideDirectory, KickRecordingManager, listRecordingFiles } from "./recording";
import { getOllamaStatus, generateKickBroadcastArticle } from "./ollama";
import { KickChatReceiver } from "./chat";

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
  saveChat: boolean;
  outputDirectory: string;
  autoMonitorEnabled: boolean;
  monitorIntervalSeconds: number;
  notifyOnLive: boolean;
  autoGenerateArticles: boolean;
};

type AppState = {
  channels: Channel[];
  settings: AppSettings;
};

const DEFAULT_STATE: AppState = {
  channels: [],
  settings: {
    autoRecordOnStreamStart: true,
    saveChat: true,
    outputDirectory: "",
    autoMonitorEnabled: true,
    monitorIntervalSeconds: 60,
    notifyOnLive: true,
    autoGenerateArticles: true
  }
};


type StoredKickCredentials = {
  clientId: string;
  encryptedClientSecret: string;
};

type KickChannelCheck = {
  slug: string;
  broadcasterUserId: number | null;
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
    broadcaster_user_id?: number | string;
    stream_title?: string;
    stream?: {
      is_live?: boolean;
      viewer_count?: number;
      start_time?: string;
    } | null;
  }>;
};

let cachedKickToken: { value: string; expiresAt: number } | null = null;

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
        broadcasterUserId: Number.isSafeInteger(Number(channel.broadcaster_user_id)) ? Number(channel.broadcaster_user_id) : null,
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
    broadcasterUserId: null,
    found: false,
    isLive: false,
    streamTitle: "",
    viewerCount: 0,
    startedAt: null
  });
}


async function subscribeToKickChat(input: unknown): Promise<Array<{ slug: string; ok: boolean; message: string }>> {
  if (!Array.isArray(input)) throw new Error("購読チャンネル一覧が不正です。");
  const slugs = [...new Set(input.filter((value): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value)
  ).map(value => value.toLowerCase()))].slice(0, 200);
  if (slugs.length === 0) throw new Error("先にチャンネルを登録してください。");

  const accessToken = await getKickAccessToken();
  const results: Array<{ slug: string; ok: boolean; message: string }> = [];
  for (const slug of slugs) {
    try {
      const url = new URL("https://api.kick.com/public/v1/channels");
      url.searchParams.set("slug", slug);
      const channelResponse = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15000)
      });
      if (!channelResponse.ok) throw new Error(`チャンネル情報取得 HTTP ${channelResponse.status}`);
      const channelPayload = await channelResponse.json() as { data?: Array<{ broadcaster_user_id?: number | string; slug?: string }> };
      const channel = channelPayload.data?.find(item => item.slug?.toLowerCase() === slug);
      const broadcasterUserId = Number(channel?.broadcaster_user_id);
      if (!Number.isSafeInteger(broadcasterUserId) || broadcasterUserId <= 0) {
        throw new Error("配信者IDを取得できませんでした。チャンネル名を確認してください。");
      }
      const response = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          broadcaster_user_id: broadcasterUserId,
          method: "webhook",
          events: [{ name: "chat.message.sent", version: 1 }]
        }),
        signal: AbortSignal.timeout(15000)
      });
      const payload = await response.json().catch(() => ({})) as {
        message?: string;
        data?: Array<{ name?: string; version?: number; subscription_id?: string; error?: string }>;
      };
      if (!response.ok) throw new Error(payload.message || `購読登録 HTTP ${response.status}`);
      const eventResult = payload.data?.find(item => item.name === "chat.message.sent" && item.version === 1);
      if (!eventResult) {
        throw new Error("Kick APIの応答に chat.message.sent の登録結果がありません。購読状態を確認してください。");
      }
      if (eventResult.error) {
        throw new Error(`Kick APIのイベント登録エラー：${eventResult.error}`);
      }
      results.push({
        slug,
        ok: true,
        message: eventResult.subscription_id
          ? `購読要求を受け付けました（ID: ${eventResult.subscription_id}）。実際のWebhook到着は受信件数で確認してください。`
          : "購読要求を受け付けました。実際のWebhook到着は受信件数で確認してください。"
      });
    } catch (error) {
      results.push({ slug, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
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

const chatReceiver = new KickChatReceiver(event => {
  mainWindow?.webContents.send("chat:event", event);
});

type SavedKickArticle = {
  id: string;
  slug: string;
  broadcaster: string;
  streamTitle: string;
  startedAt: string | null;
  generatedAt: string;
  commentCount: number;
  isFinal: boolean;
  title: string;
  summary: string;
  paragraphs: string[];
  topics: string[];
  provider: string;
  model: string;
};

let articleTimer: NodeJS.Timeout | null = null;
let articleCycleRunning = false;
const liveArticleChannels = new Set<string>();
const liveArticleMetadata = new Map<string, KickChannelCheck>();
const lastArticleMessageIds = new Map<string, string>();

function getArticleDirectory(): string {
  const directory = join(chatReceiver.getOutputDirectory() || getRecordingOutputDirectory(), "Articles");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function listSavedArticles(): SavedKickArticle[] {
  const directory = getArticleDirectory();
  return readdirSync(directory)
    .filter(name => name.toLowerCase().endsWith(".json"))
    .map(name => {
      try {
        const article = JSON.parse(readFileSync(join(directory, name), "utf8")) as SavedKickArticle;
        return article && typeof article.id === "string" && typeof article.slug === "string" ? article : null;
      } catch {
        return null;
      }
    })
    .filter((article): article is SavedKickArticle => article !== null)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))
    .slice(0, 100);
}

async function createKickArticle(slugInput: unknown, metadata?: KickChannelCheck, isFinal = false): Promise<SavedKickArticle> {
  if (typeof slugInput !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(slugInput)) {
    throw new Error("記事生成対象のチャンネル名が不正です。");
  }
  const slug = slugInput.toLowerCase();
  const allMessages = chatReceiver.listMessages(slug, 5000, chatReceiver.getOutputDirectory() || getRecordingOutputDirectory());
  const streamStart = metadata?.startedAt ? Date.parse(metadata.startedAt) : Number.NaN;
  const messages = Number.isFinite(streamStart) && streamStart > Date.UTC(2000, 0, 1)
    ? allMessages.filter(message => {
        const timestamp = Date.parse(message.timestamp);
        return !Number.isFinite(timestamp) || timestamp >= streamStart;
      })
    : allMessages;
  if (messages.length === 0) throw new Error(`${slug} の今回の配信に該当する保存済みチャットがありません。`);

  const ollamaStatus = await getOllamaStatus();
  if (!ollamaStatus.connected) {
    throw new Error(ollamaStatus.message || "Ollamaに接続できません。Ollamaを起動してください。");
  }
  if (ollamaStatus.models.length === 0) {
    throw new Error("Ollamaにモデルがありません。PowerShellで ollama pull qwen2.5:3b を実行してください。");
  }
  const preferredModel = ollamaStatus.models.find(model => model.name === "qwen2.5:3b") ?? ollamaStatus.models[0];
  const generated = await generateKickBroadcastArticle({
    model: preferredModel.name,
    title: metadata?.streamTitle || slug,
    broadcaster: slug,
    startedAt: metadata?.startedAt || undefined,
    comments: messages.map(message => ({
      user: message.user,
      text: message.text,
      timestamp: message.timestamp
    }))
  });

  const generatedAt = new Date().toISOString();
  const id = `${slug}-${generatedAt.replace(/[:.]/g, "-")}`;
  const article: SavedKickArticle = {
    id,
    slug,
    broadcaster: slug,
    streamTitle: metadata?.streamTitle || slug,
    startedAt: metadata?.startedAt ?? null,
    generatedAt,
    commentCount: messages.length,
    isFinal,
    ...generated
  };
  writeFileSync(join(getArticleDirectory(), `${id}.json`), JSON.stringify(article, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) lastArticleMessageIds.set(slug, lastMessage.messageId);
  mainWindow?.webContents.send("articles:new", article);
  return article;
}

async function runLiveArticleCycle(): Promise<void> {
  if (articleCycleRunning || !chatReceiver.getStatus().serverRunning) return;
  articleCycleRunning = true;
  try {
    const state = readState();
    if (!state.settings.autoGenerateArticles || state.channels.length === 0) return;
    const results = await checkKickChannels(state.channels.map(channel => channel.name));
    for (const result of results) {
      if (result.isLive) {
        liveArticleChannels.add(result.slug);
        liveArticleMetadata.set(result.slug, result);
        const messages = chatReceiver.listMessages(result.slug, 5000, chatReceiver.getOutputDirectory() || getRecordingOutputDirectory());
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || lastArticleMessageIds.get(result.slug) === lastMessage.messageId) continue;
        try {
          await createKickArticle(result.slug, result, false);
        } catch (error) {
          mainWindow?.webContents.send("articles:status", {
            slug: result.slug,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } else if (result.found && liveArticleChannels.has(result.slug)) {
        liveArticleChannels.delete(result.slug);
        const finalMetadata = liveArticleMetadata.get(result.slug) ?? result;
        liveArticleMetadata.delete(result.slug);
        try {
          await createKickArticle(result.slug, finalMetadata, true);
        } catch (error) {
          mainWindow?.webContents.send("articles:status", {
            slug: result.slug,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  } catch (error) {
    mainWindow?.webContents.send("articles:status", {
      slug: "",
      message: error instanceof Error ? error.message : "配信記事の自動生成を確認できませんでした。"
    });
  } finally {
    articleCycleRunning = false;
  }
}

function startLiveArticleTimer(): void {
  if (articleTimer) clearInterval(articleTimer);
  void runLiveArticleCycle();
  articleTimer = setInterval(() => { void runLiveArticleCycle(); }, 3 * 60 * 1000);
  articleTimer.unref();
}

function stopLiveArticleTimer(): void {
  if (articleTimer) clearInterval(articleTimer);
  articleTimer = null;
  liveArticleChannels.clear();
  liveArticleMetadata.clear();
}


app.on("before-quit", () => {
  stopLiveArticleTimer();
  chatReceiver.stop();
  recordingManager.stopAll();
});

function getRecordingOutputDirectory(): string {
  const configured = readState().settings.outputDirectory.trim();
  return configured || join(app.getPath("videos"), "Kick Live Message Recorder");
}

function normalizeState(input: unknown): AppState {
  if (!input || typeof input !== "object") return DEFAULT_STATE;
  const candidate = input as Partial<AppState>;

  const channels = Array.isArray(candidate.channels)
    ? candidate.channels.slice(0, 200).flatMap((item): Channel[] => {
        if (!item || typeof item !== "object") return [];
        const channel = item as Partial<Channel>;
        if (
          typeof channel.id !== "number" ||
          !Number.isFinite(channel.id) ||
          typeof channel.name !== "string" ||
          !/^[a-zA-Z0-9_]{1,25}$/.test(channel.name) ||
          (channel.mode !== "auto" && channel.mode !== "manual")
        ) return [];

        return [{
          id: channel.id,
          name: channel.name,
          url: `https://kick.com/${channel.name}`,
          mode: channel.mode,
          status: "待機中",
          recording: false
        }];
      })
    : [];

  const settings = candidate.settings && typeof candidate.settings === "object"
    ? candidate.settings
    : DEFAULT_STATE.settings;

  return {
    channels,
    settings: {
      autoRecordOnStreamStart: settings.autoRecordOnStreamStart !== false,
      saveChat: settings.saveChat !== false,
      outputDirectory: typeof settings.outputDirectory === "string"
        ? settings.outputDirectory.slice(0, 4096)
        : "",
      autoMonitorEnabled: settings.autoMonitorEnabled !== false,
      monitorIntervalSeconds: typeof settings.monitorIntervalSeconds === "number" &&
        Number.isFinite(settings.monitorIntervalSeconds)
        ? Math.max(30, Math.min(3600, Math.round(settings.monitorIntervalSeconds)))
        : 60,
      notifyOnLive: settings.notifyOnLive !== false,
      autoGenerateArticles: settings.autoGenerateArticles !== false
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

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, `""`)}"`;
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

  ipcMain.handle("ollama:get-status", async event => {
    assertTrustedSender(event);
    return getOllamaStatus();
  });

  ipcMain.handle("ollama:generate-article", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== "object") throw new Error("記事生成データが不正です。");
    const value = input as Record<string, unknown>;
    const comments = Array.isArray(value.comments) ? value.comments : [];
    if (comments.length > 5000) throw new Error("記事生成に渡せるコメントは5000件までです。");
    return generateKickBroadcastArticle({
      title: typeof value.title === "string" ? value.title.slice(0, 300) : "",
      broadcaster: typeof value.broadcaster === "string" ? value.broadcaster.slice(0, 100) : "",
      startedAt: typeof value.startedAt === "string" ? value.startedAt.slice(0, 60) : "",
      comments: comments.filter(item => item && typeof item === "object").map(item => {
        const row = item as Record<string, unknown>;
        return {
          user: typeof row.user === "string" ? row.user.slice(0, 40) : "",
          timestamp: typeof row.timestamp === "string" ? row.timestamp.slice(0, 60) : "",
          text: typeof row.text === "string" ? row.text.slice(0, 500) : ""
        };
      })
    });
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

  ipcMain.handle("kick:clear-credentials", event => {
    assertTrustedSender(event);
    return clearKickCredentials();
  });

  ipcMain.handle("kick:check-channels", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return checkKickChannels(slugs);
  });

  ipcMain.handle("chat:get-status", event => {
    assertTrustedSender(event);
    return chatReceiver.getStatus();
  });

  ipcMain.handle("chat:start", async event => {
    assertTrustedSender(event);
    await chatReceiver.startServer(getRecordingOutputDirectory());
    const status = await chatReceiver.startTunnel(app.getPath("userData"));
    startLiveArticleTimer();
    return status;
  });

  ipcMain.handle("chat:stop", event => {
    assertTrustedSender(event);
    stopLiveArticleTimer();
    return chatReceiver.stop();
  });

  ipcMain.handle("chat:subscribe", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return subscribeToKickChat(slugs);
  });

  ipcMain.handle("chat:list", (event, slug: unknown) => {
    assertTrustedSender(event);
    return chatReceiver.listMessages(slug, 500, getRecordingOutputDirectory());
  });

  ipcMain.handle("chat:export", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== "object") throw new Error("チャット書き出しの指定が不正です。");
    const value = input as { slug?: unknown; format?: unknown };
    if (typeof value.slug !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(value.slug)) {
      throw new Error("書き出すチャンネル名が不正です。");
    }
    if (value.format !== "csv" && value.format !== "jsonl") {
      throw new Error("書き出し形式はCSVまたはJSONLを指定してください。");
    }
    if (!mainWindow) throw new Error("アプリ画面が利用できません。");
    const slug = value.slug.toLowerCase();
    const messages = chatReceiver.listMessages(slug, 5000, getRecordingOutputDirectory());
    if (messages.length === 0) throw new Error(`${slug} の保存済みコメントがありません。`);
    const extension = value.format;
    const defaultPath = join(getRecordingOutputDirectory(), `${slug}_chat_export.${extension}`);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "チャットログを書き出す",
      defaultPath,
      buttonLabel: "書き出す",
      filters: value.format === "csv"
        ? [{ name: "CSVファイル", extensions: ["csv"] }]
        : [{ name: "JSONLファイル", extensions: ["jsonl"] }]
    });
    if (result.canceled || !result.filePath) return { saved: false, count: messages.length };
    const content = value.format === "jsonl"
      ? messages.map(message => JSON.stringify(message)).join("\n") + "\n"
      : [
          ["messageId", "channel", "user", "timestamp", "receivedAt", "text", "badges"].map(escapeCsvCell).join(","),
          ...messages.map(message => [
            message.messageId,
            message.slug,
            message.user,
            message.timestamp,
            message.receivedAt,
            message.text,
            message.badges.join(" / ")
          ].map(escapeCsvCell).join(","))
        ].join("\r\n");
    writeFileSync(result.filePath, value.format === "csv" ? "\uFEFF" + content : content, "utf8");
    return { saved: true, path: result.filePath, count: messages.length };
  });

  ipcMain.handle("articles:list", event => {
    assertTrustedSender(event);
    return listSavedArticles();
  });

  ipcMain.handle("articles:generate", async (event, slug: unknown) => {
    assertTrustedSender(event);
    const results = await checkKickChannels([slug]);
    return createKickArticle(slug, results[0], false);
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
