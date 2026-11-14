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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { autoUpdater } from "electron-updater";
import { isPathInsideDirectory, KickRecordingManager, listRecordingFiles } from "./recording";
import { getOllamaStatus, generateKickBroadcastArticle, describeKickFrame } from "./ollama";
import { KickChatReceiver, type SavedKickChatMessage } from "./chat";
import { analyzeLiveRecordingMedia, getMediaToolStatus } from "./media-analysis";

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
  ffmpegPath: string;
  whisperCliPath: string;
  whisperModelPath: string;
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
    autoGenerateArticles: true,
    ffmpegPath: "",
    whisperCliPath: "",
    whisperModelPath: ""
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



type KickChatSubscriptionStatus = {
  slug: string;
  broadcasterUserId: number | null;
  subscribed: boolean;
  subscriptionId: string | null;
  createdAt: string | null;
};

type KickEventSubscription = {
  id?: string;
  broadcaster_user_id?: number | string;
  event?: string;
  version?: number;
  method?: string;
  created_at?: string;
};

async function getKickChatSubscriptionStatuses(input: unknown): Promise<KickChatSubscriptionStatus[]> {
  if (!Array.isArray(input)) throw new Error("購読状態を確認するチャンネル一覧が不正です。");
  const slugs = [...new Set(input.filter((value): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value)
  ).map(value => value.toLowerCase()))].slice(0, 200);
  if (slugs.length === 0) return [];

  const accessToken = await getKickAccessToken();
  const broadcasterIds = new Map<string, number>();

  // KickのChannels APIはslugを最大50件まとめて指定できます。
  for (let offset = 0; offset < slugs.length; offset += 50) {
    const batch = slugs.slice(offset, offset + 50);
    const url = new URL("https://api.kick.com/public/v1/channels");
    for (const slug of batch) url.searchParams.append("slug", slug);
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("チャンネル情報取得 HTTP " + response.status);
    const payload = await response.json() as { data?: Array<{ slug?: string; broadcaster_user_id?: number | string }> };
    if (!Array.isArray(payload.data)) throw new Error("Kick APIからチャンネル情報を取得できませんでした。");
    for (const channel of payload.data) {
      const slug = typeof channel.slug === "string" ? channel.slug.toLowerCase() : "";
      const id = Number(channel.broadcaster_user_id);
      if (slug && Number.isSafeInteger(id) && id > 0) broadcasterIds.set(slug, id);
    }
  }

  const subscriptionsResponse = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const subscriptionsPayload = await subscriptionsResponse.json().catch(() => ({})) as {
    message?: string;
    data?: KickEventSubscription[];
  };
  if (!subscriptionsResponse.ok) {
    throw new Error(subscriptionsPayload.message || "購読状態の取得 HTTP " + subscriptionsResponse.status);
  }
  if (!Array.isArray(subscriptionsPayload.data)) {
    throw new Error("Kick APIから購読一覧を取得できませんでした。");
  }

  const activeByBroadcaster = new Map<number, KickEventSubscription>();
  for (const subscription of subscriptionsPayload.data) {
    const broadcasterId = Number(subscription.broadcaster_user_id);
    if (
      Number.isSafeInteger(broadcasterId) &&
      broadcasterId > 0 &&
      subscription.event === "chat.message.sent" &&
      Number(subscription.version) === 1 &&
      (!subscription.method || subscription.method === "webhook")
    ) {
      activeByBroadcaster.set(broadcasterId, subscription);
    }
  }

  return slugs.map(slug => {
    const broadcasterUserId = broadcasterIds.get(slug) ?? null;
    const subscription = broadcasterUserId ? activeByBroadcaster.get(broadcasterUserId) : undefined;
    return {
      slug,
      broadcasterUserId,
      subscribed: Boolean(subscription),
      subscriptionId: typeof subscription?.id === "string" ? subscription.id : null,
      createdAt: typeof subscription?.created_at === "string" ? subscription.created_at : null
    };
  });
}

async function subscribeToKickChat(input: unknown): Promise<Array<{ slug: string; ok: boolean; message: string }>> {
  if (!Array.isArray(input)) throw new Error("購読チャンネル一覧が不正です。");
  const slugs = [...new Set(input.filter((value): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value)
  ).map(value => value.toLowerCase()))].slice(0, 200);
  if (slugs.length === 0) throw new Error("先にチャンネルを登録してください。");

  const accessToken = await getKickAccessToken();
  let statusCheckFailed = false;
  let knownStatuses: KickChatSubscriptionStatus[];
  try {
    knownStatuses = await getKickChatSubscriptionStatuses(slugs);
  } catch (error) {
    // 購読一覧APIが不安定な場合も、チャンネル情報を取り直して登録要求自体は続行する。
    statusCheckFailed = true;
    const channelChecks = await checkKickChannels(slugs);
    knownStatuses = channelChecks.map(channel => ({
      slug: channel.slug,
      broadcasterUserId: channel.broadcasterUserId,
      subscribed: false,
      subscriptionId: null,
      createdAt: null
    }));
    console.warn("Kick subscription list unavailable; continuing without duplicate check:", error);
  }
  const results: Array<{ slug: string; ok: boolean; message: string }> = [];
  for (const status of knownStatuses) {
    const { slug, broadcasterUserId } = status;
    if (!broadcasterUserId) {
      results.push({ slug, ok: false, message: "配信者IDを取得できません。チャンネル名を確認してください。" });
      continue;
    }
    if (status.subscribed) {
      results.push({ slug, ok: true, message: "Kick APIで購読登録済みと確認できたため、重複登録をスキップしました。" });
      continue;
    }
    try {
      const response = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
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
      if (!response.ok) throw new Error(payload.message || "購読登録 HTTP " + response.status);
      const eventResult = payload.data?.find(item => item.name === "chat.message.sent" && item.version === 1);
      if (!eventResult) {
        throw new Error("Kick APIの応答に chat.message.sent の登録結果がありません。購読状態を確認してください。");
      }
      if (eventResult.error) {
        throw new Error("Kick APIのイベント登録エラー：" + eventResult.error);
      }
      results.push({
        slug,
        ok: true,
        message: (statusCheckFailed ? "購読一覧を取得できなかったため、重複確認なしで登録要求を送信しました。" : "") +
          (eventResult.subscription_id
            ? "購読要求を受け付けました（ID: " + eventResult.subscription_id + "）。実際のWebhook到着は受信件数で確認してください。"
            : "購読要求を受け付けました。実際のWebhook到着は受信件数で確認してください。")
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
  if (event.status === "recording" && readState().settings.autoGenerateArticles) {
    startLiveArticleTimer();
  }
  if (event.status === "stopped" || event.status === "error") {
    setTimeout(() => { void runLiveArticleCycle(); }, 1_000).unref?.();
  }
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
  mediaSources?: string[];
  visualSummary?: string;
  transcript?: string;
  analyzedAt?: string;
  analysis?: {
    frameCount: number;
    transcriptCharacters: number;
    commentCount: number;
    durationMs: number;
    visionAnalyzed: boolean;
    warnings: string[];
  };
};

let articleTimer: NodeJS.Timeout | null = null;
let articleCycleRunning = false;
const liveArticleChannels = new Set<string>();
const liveArticleMetadata = new Map<string, KickChannelCheck>();
const lastArticleMessageIds = new Map<string, string>();
const liveArticleSessionIds = new Map<string, string>();

function getArticleDirectory(): string {
  const directory = join(chatReceiver.getOutputDirectory() || getRecordingOutputDirectory(), "Articles");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function readSavedArticles(): SavedKickArticle[] {
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
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
}

function getArticleSessionKey(article: SavedKickArticle): string {
  const startedAt = article.startedAt ? Date.parse(article.startedAt) : Number.NaN;
  return Number.isFinite(startedAt) ? article.slug + "|" + startedAt : article.id;
}

function listSavedArticles(): SavedKickArticle[] {
  const seenSessions = new Set<string>();
  return readSavedArticles()
    .filter(article => {
      const key = getArticleSessionKey(article);
      if (seenSessions.has(key)) return false;
      seenSessions.add(key);
      return true;
    })
    .slice(0, 100);
}

function getArticleIdentity(
  slug: string,
  metadata: KickChannelCheck | undefined,
  isFinal: boolean
): { id: string; duplicateIds: string[] } {
  const startedAt = metadata?.startedAt ? Date.parse(metadata.startedAt) : Number.NaN;
  if (Number.isFinite(startedAt)) {
    const matching = readSavedArticles().filter(article =>
      article.slug === slug &&
      article.startedAt !== null &&
      Number.isFinite(Date.parse(article.startedAt)) &&
      Date.parse(article.startedAt) === startedAt
    );
    const id = matching[0]?.id ?? `${slug}-${startedAt.toString(36)}`;
    return { id, duplicateIds: matching.filter(article => article.id !== id).map(article => article.id) };
  }

  const isLiveSession = metadata?.isLive === true || recordingManager.isRecording(slug) || isFinal;
  if (!isLiveSession) {
    return { id: `${slug}-${Date.now().toString(36)}`, duplicateIds: [] };
  }

  let id = liveArticleSessionIds.get(slug);
  if (!id) {
    const recentUnfinished = readSavedArticles().find(article =>
      article.slug === slug &&
      article.startedAt === null &&
      !article.isFinal &&
      Date.now() - Date.parse(article.generatedAt) >= 0 &&
      Date.now() - Date.parse(article.generatedAt) < 12 * 60 * 60 * 1000
    );
    id = recentUnfinished?.id ?? `${slug}-${Date.now().toString(36)}`;
    liveArticleSessionIds.set(slug, id);
  }
  return { id, duplicateIds: [] };
}

function writeArticleAnalysisLog(entry: {
  slug: string;
  status: "saved" | "error";
  articleId?: string;
  commentCount?: number;
  frameCount?: number;
  transcriptCharacters?: number;
  durationMs?: number;
  visionAnalyzed?: boolean;
  message?: string;
  warnings?: string[];
}): void {
  if (!/^[a-zA-Z0-9_]{1,25}$/.test(entry.slug)) return;
  try {
    const directory = join(getArticleDirectory(), "AnalysisLogs");
    mkdirSync(directory, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
      message: entry.message?.slice(0, 1200),
      warnings: entry.warnings?.slice(0, 10).map(warning => warning.slice(0, 500))
    };
    appendFileSync(join(directory, entry.slug.toLowerCase() + ".jsonl"), JSON.stringify(record) + "\n", {
      encoding: "utf8",
      mode: 0o600
    });
  } catch (error) {
    console.error("Failed to write AI article analysis log:", error);
  }
}

async function createKickArticle(slugInput: unknown, metadata?: KickChannelCheck, isFinal = false): Promise<SavedKickArticle> {
  if (typeof slugInput !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(slugInput)) {
    throw new Error("記事生成対象のチャンネル名が不正です。");
  }
  const slug = slugInput.toLowerCase();
  const analysisStartedAt = Date.now();
  const outputDirectory = chatReceiver.getOutputDirectory() || getRecordingOutputDirectory();
  const allMessages = chatReceiver.listMessages(slug, 5000, outputDirectory);
  const streamStart = metadata?.startedAt ? Date.parse(metadata.startedAt) : Number.NaN;
  const messages = Number.isFinite(streamStart) && streamStart > Date.UTC(2000, 0, 1)
    ? allMessages.filter(message => {
        const timestamp = Date.parse(message.timestamp);
        return !Number.isFinite(timestamp) || timestamp >= streamStart;
      })
    : allMessages;

  const state = readState();
  const activeVideoPath = recordingManager.getActiveRecordingPath(slug);
  const media = activeVideoPath
    ? await analyzeLiveRecordingMedia({
        slug,
        videoPath: activeVideoPath,
        outputDirectory: getArticleDirectory(),
        tools: state.settings,
        userDataDirectory: app.getPath("userData"),
        resourcesDirectory: process.resourcesPath
      })
    : { analyzedAt: new Date().toISOString(), frameBase64s: [], transcript: "", warnings: [] as string[] };

  const ollamaStatus = await getOllamaStatus();
  if (!ollamaStatus.connected) {
    throw new Error(ollamaStatus.message || "Ollamaに接続できません。Ollamaを起動してください。");
  }
  if (ollamaStatus.models.length === 0) {
    throw new Error("Ollamaにモデルがありません。PowerShellで ollama pull qwen2.5:3b を実行してください。");
  }

  let visualSummary = "";
  const visionModel = ollamaStatus.models.find(model => /^qwen2\.5vl(?::3b)?$/i.test(model.name));
  if (media.frameBase64s.length > 0 && visionModel) {
    try {
      visualSummary = await describeKickFrame({
        model: visionModel.name,
        title: metadata?.streamTitle || slug,
        imageBase64: media.frameBase64s
      });
    } catch (error) {
      media.warnings.push("映像のAI解析に失敗しました：" + (error instanceof Error ? error.message : String(error)));
    }
  } else if (media.frameBase64s.length > 0 && !visionModel) {
    media.warnings.push("映像フレームは取得しましたが、qwen2.5vl:3bが未導入のためAI解析をスキップしました。");
  }

  if (messages.length === 0 && !media.transcript && !visualSummary) {
    const detail = media.warnings.length ? " " + media.warnings.join(" ") : "";
    throw new Error(`${slug} の記事材料がありません。チャット受信または録画・メディア解析の設定を確認してください。${detail}`);
  }

  const preferredModel = ollamaStatus.models.find(model => model.name === "qwen2.5:3b") ?? ollamaStatus.models[0];
  const mediaSources = [
    ...(messages.length ? ["Kickチャット"] : []),
    ...(media.transcript ? ["音声文字起こし（Whisper.cpp）"] : []),
    ...(visualSummary ? ["映像解析（Ollama Vision）"] : [])
  ];
  const generated = await generateKickBroadcastArticle({
    model: preferredModel.name,
    title: metadata?.streamTitle || slug,
    broadcaster: slug,
    startedAt: metadata?.startedAt || undefined,
    comments: messages.map(message => ({
      user: message.user,
      text: message.text,
      timestamp: message.timestamp
    })),
    audioTranscript: media.transcript,
    visualSummary,
    mediaSources
  });

  const generatedAt = new Date().toISOString();
  const identity = getArticleIdentity(slug, metadata, isFinal);
  const id = identity.id;
  const diagnostics = {
    frameCount: media.frameBase64s.length,
    transcriptCharacters: media.transcript.length,
    commentCount: messages.length,
    durationMs: Date.now() - analysisStartedAt,
    visionAnalyzed: Boolean(visualSummary),
    warnings: media.warnings.slice(0, 10)
  };
  const article: SavedKickArticle = {
    id,
    slug,
    broadcaster: slug,
    streamTitle: metadata?.streamTitle || slug,
    startedAt: metadata?.startedAt ?? null,
    generatedAt,
    commentCount: messages.length,
    isFinal,
    mediaSources,
    visualSummary,
    transcript: media.transcript,
    analyzedAt: media.analyzedAt,
    analysis: diagnostics,
    ...generated
  };
  writeFileSync(join(getArticleDirectory(), `${id}.json`), JSON.stringify(article, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  for (const duplicateId of identity.duplicateIds) {
    try {
      const duplicatePath = join(getArticleDirectory(), `${duplicateId}.json`);
      if (existsSync(duplicatePath)) unlinkSync(duplicatePath);
    } catch (error) {
      console.warn("Failed to remove superseded live article snapshot:", error);
    }
  }
  writeArticleAnalysisLog({
    slug,
    status: "saved",
    articleId: id,
    commentCount: diagnostics.commentCount,
    frameCount: diagnostics.frameCount,
    transcriptCharacters: diagnostics.transcriptCharacters,
    durationMs: diagnostics.durationMs,
    visionAnalyzed: diagnostics.visionAnalyzed,
    warnings: diagnostics.warnings
  });
  if (isFinal) liveArticleSessionIds.delete(slug);
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) lastArticleMessageIds.set(slug, lastMessage.messageId);
  mainWindow?.webContents.send("articles:new", article);
  if (media.warnings.length) {
    mainWindow?.webContents.send("articles:status", {
      slug,
      message: "記事を保存しました。メディア解析の注意： " + media.warnings.join(" ")
    });
  }
  return article;
}
async function runLiveArticleCycle(): Promise<void> {
  if (articleCycleRunning) return;
  articleCycleRunning = true;
  try {
    const state = readState();
    if (!state.settings.autoGenerateArticles || state.channels.length === 0) return;
    const activeRecordingChannels = state.channels.filter(channel => recordingManager.isRecording(channel.name));
    let results: KickChannelCheck[];
    try {
      results = await checkKickChannels(state.channels.map(channel => channel.name));
    } catch (error) {
      if (activeRecordingChannels.length === 0) throw error;
      // 録画プロセスが継続している場合は、その状態を生放送中の根拠として使用する。
      // Kick APIが一時的に停止していても、ローカル録画の映像・音声解析を止めない。
      results = activeRecordingChannels.map(channel => {
        const slug = channel.name.toLowerCase();
        return liveArticleMetadata.get(slug) ?? {
          slug,
          broadcasterUserId: null,
          found: true,
          isLive: true,
          streamTitle: channel.name,
          viewerCount: 0,
          startedAt: null
        };
      });
      mainWindow?.webContents.send("articles:status", {
        slug: "",
        message: "Kick APIに接続できないため、録画中チャンネルはローカル録画の状態でAI記事を継続します。"
      });
    }
    const liveResults = results.map(result =>
      recordingManager.isRecording(result.slug) && !result.isLive
        ? { ...result, found: true, isLive: true }
        : result
    );
    for (const result of liveResults) {
      if (result.isLive) {
        liveArticleChannels.add(result.slug);
        liveArticleMetadata.set(result.slug, result);
        const messages = chatReceiver.listMessages(result.slug, 5000, chatReceiver.getOutputDirectory() || getRecordingOutputDirectory());
        const lastMessage = messages[messages.length - 1];
        const activeVideoPath = recordingManager.getActiveRecordingPath(result.slug);
        const commentsUnchanged = !lastMessage || lastArticleMessageIds.get(result.slug) === lastMessage.messageId;
        if (commentsUnchanged && !activeVideoPath) continue;
        try {
          await createKickArticle(result.slug, result, false);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeArticleAnalysisLog({ slug: result.slug, status: "error", message });
          mainWindow?.webContents.send("articles:status", {
            slug: result.slug,
            message
          });
        }
      } else if (result.found && liveArticleChannels.has(result.slug)) {
        liveArticleChannels.delete(result.slug);
        const finalMetadata = liveArticleMetadata.get(result.slug) ?? result;
        liveArticleMetadata.delete(result.slug);
        try {
          await createKickArticle(result.slug, finalMetadata, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeArticleAnalysisLog({ slug: result.slug, status: "error", message });
          mainWindow?.webContents.send("articles:status", {
            slug: result.slug,
            message
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
    if (!chatReceiver.getStatus().serverRunning &&
        !recordingManager.hasActiveRecordings() &&
        liveArticleChannels.size === 0) {
      stopLiveArticleTimer();
    }
  }
}

function startLiveArticleTimer(): void {
  if (articleTimer) clearInterval(articleTimer);
  void runLiveArticleCycle();
  articleTimer = setInterval(() => { void runLiveArticleCycle(); }, 60 * 1000);
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
      autoGenerateArticles: settings.autoGenerateArticles !== false,
      ffmpegPath: typeof settings.ffmpegPath === "string" ? settings.ffmpegPath.slice(0, 4096) : "",
      whisperCliPath: typeof settings.whisperCliPath === "string" ? settings.whisperCliPath.slice(0, 4096) : "",
      whisperModelPath: typeof settings.whisperModelPath === "string" ? settings.whisperModelPath.slice(0, 4096) : ""
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
  // Prevent untrusted chat text from being interpreted as an Excel formula.
  const safeText = /^\s*[=+@-]/.test(text) ? "'" + text : text;
  return `"${safeText.replace(/"/g, `""`)}"`;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || BrowserWindow.fromWebContents(event.sender) !== mainWindow) {
    throw new Error("Untrusted IPC sender");
  }
}


type RecordingTimeline = {
  slug: string;
  startedAt: string;
  endedAt: string;
  startReference: string;
};

function getRecordingTimeline(videoPath: string): RecordingTimeline {
  let fileStats: ReturnType<typeof statSync>;
  try {
    fileStats = statSync(videoPath);
  } catch {
    throw new Error("録画ファイルの情報を取得できませんでした。");
  }
  if (!fileStats.isFile()) throw new Error("指定されたパスは動画ファイルではありません。");

  const metadataPath = videoPath + ".recording.json";
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
        version?: unknown; slug?: unknown; startedAt?: unknown; endedAt?: unknown; startReference?: unknown;
      };
      const startedMs = typeof metadata.startedAt === "string" ? Date.parse(metadata.startedAt) : Number.NaN;
      const endedMs = typeof metadata.endedAt === "string" ? Date.parse(metadata.endedAt) : Number.NaN;
      if (
        metadata.version === 1 &&
        typeof metadata.slug === "string" &&
        /^[a-zA-Z0-9_]{1,25}$/.test(metadata.slug) &&
        Number.isFinite(startedMs) &&
        Number.isFinite(endedMs) &&
        endedMs > startedMs
      ) {
        return {
          slug: metadata.slug.toLowerCase(),
          startedAt: new Date(startedMs).toISOString(),
          endedAt: new Date(endedMs).toISOString(),
          startReference: typeof metadata.startReference === "string" ? metadata.startReference : "recording-metadata"
        };
      }
    } catch {
      // 破損・古いサイドカーファイルはファイル名からの推定へ切り替える。
    }
  }

  // β14以前の録画はファイル名の開始時刻とファイル更新時刻を使って補完する。
  const stem = basename(videoPath).replace(/\.[^.]+$/, "");
  const match = stem.match(/^([a-zA-Z0-9_]+)_(\d{8})_(\d{6})$/);
  if (!match) {
    throw new Error("録画時刻情報がありません。チャンネル名_YYYYMMDD_HHMMSS 形式の録画ファイルが必要です。");
  }
  const slug = match[1];
  const datePart = match[2];
  const timePart = match[3];
  const startedAt = new Date(
    Number(datePart.slice(0, 4)),
    Number(datePart.slice(4, 6)) - 1,
    Number(datePart.slice(6, 8)),
    Number(timePart.slice(0, 2)),
    Number(timePart.slice(2, 4)),
    Number(timePart.slice(4, 6))
  );
  const endedAt = fileStats.mtime;
  if (!Number.isFinite(startedAt.getTime()) || endedAt.getTime() <= startedAt.getTime()) {
    throw new Error("録画の開始・終了時刻を正しく推定できませんでした。");
  }
  return {
    slug: slug.toLowerCase(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    startReference: "filename-and-file-modified-time"
  };
}

function formatAssTime(milliseconds: number): string {
  const centiseconds = Math.max(0, Math.floor(milliseconds / 10));
  const totalSeconds = Math.floor(centiseconds / 100);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return Math.floor(totalSeconds / 3600) + ":" +
    pad(Math.floor(totalSeconds / 60) % 60) + ":" +
    pad(totalSeconds % 60) + "." + pad(centiseconds % 100);
}

function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, "＼")
    .replace(/{/g, "｛")
    .replace(/}/g, "｝")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 140);
}

function createCommentAss(
  messages: SavedKickChatMessage[],
  timeline: RecordingTimeline
): { content: string; count: number } {
  const startMs = Date.parse(timeline.startedAt);
  const endMs = Date.parse(timeline.endedAt);
  const laneCount = 14;
  const laneHeight = 70;
  const laneFreeAt = Array.from({ length: laneCount }, () => 0);
  const dialogue: string[] = [];
  const ordered = messages
    .map(message => {
      const primaryTimestamp = Date.parse(message.timestamp);
      const timestampMs = Number.isFinite(primaryTimestamp) ? primaryTimestamp : Date.parse(message.receivedAt);
      return { message, timestampMs };
    })
    .filter(item => Number.isFinite(item.timestampMs) && item.timestampMs >= startMs && item.timestampMs <= endMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  for (const item of ordered) {
    const text = escapeAssText(item.message.text);
    if (!text) continue;
    const offset = item.timestampMs - startMs;
    const travelDuration = Math.max(7500, Math.min(20000, Math.round((1920 + text.length * 42) / 240 * 1000)));
    let lane = laneFreeAt.findIndex(availableAt => availableAt <= offset);
    if (lane < 0) {
      lane = laneFreeAt.indexOf(Math.min(...laneFreeAt));
    }
    laneFreeAt[lane] = offset + travelDuration;
    const y = 38 + lane * laneHeight;
    const end = offset + travelDuration;
    const finalX = -Math.max(120, text.length * 42);
    const effect = "{\\move(1960," + y + "," + finalX + "," + y + ",0," + travelDuration + ")\\fad(150,250)}";
    dialogue.push("Dialogue: 0," + formatAssTime(offset) + "," + formatAssTime(end) + ",Default,,0,0,0,," + effect + text);
  }

  const header = [
    "[Script Info]",
    "Title: Kick Live Message Recorder - Chat Overlay",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Meiryo,42,&H00FFFFFF,&H0000FFFF,&H00101010,&H64000000,1,0,0,0,100,100,0,0,1,3,1,7,20,20,20,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  return { content: header.concat(dialogue).join("\r\n") + "\r\n", count: dialogue.length };
}

function registerIpcHandlers(): void {
  ipcMain.handle("app:load-state", event => {
    assertTrustedSender(event);
    return readState();
  });

  ipcMain.handle("app:save-state", (event, state: unknown) => {
    assertTrustedSender(event);
    const result = writeState(state);
    if (readState().settings.autoGenerateArticles &&
        (recordingManager.hasActiveRecordings() || chatReceiver.getStatus().serverRunning)) {
      startLiveArticleTimer();
    } else if (!readState().settings.autoGenerateArticles) {
      stopLiveArticleTimer();
    }
    return result;
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

  ipcMain.handle("media:get-status", event => {
    assertTrustedSender(event);
    return getMediaToolStatus(readState().settings, app.getPath("userData"), process.resourcesPath);
  });

  ipcMain.handle("media:select-tool", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!mainWindow) return null;
    if (input !== "ffmpeg" && input !== "whisperCli" && input !== "whisperModel") {
      throw new Error("選択するメディア解析ツールの種類が不正です。");
    }
    const isModel = input === "whisperModel";
    const result = await dialog.showOpenDialog(mainWindow, {
      title: isModel ? "Whisper.cppの日本語モデルを選択" : (input === "ffmpeg" ? "FFmpegを選択" : "Whisper.cpp CLIを選択"),
      properties: ["openFile"],
      filters: isModel
        ? [{ name: "Whisperモデル", extensions: ["bin"] }, { name: "すべてのファイル", extensions: ["*"] }]
        : [{ name: "Windows実行ファイル", extensions: ["exe"] }, { name: "すべてのファイル", extensions: ["*"] }]
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
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
    if (readState().settings.autoGenerateArticles) startLiveArticleTimer();
    return status;
  });

  ipcMain.handle("chat:stop", event => {
    assertTrustedSender(event);
    const status = chatReceiver.stop();
    if (!recordingManager.hasActiveRecordings() && liveArticleChannels.size === 0) {
      stopLiveArticleTimer();
    }
    return status;
  });

  ipcMain.handle("chat:subscribe", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return subscribeToKickChat(slugs);
  });

  ipcMain.handle("chat:subscription-status", async (event, slugs: unknown) => {
    assertTrustedSender(event);
    return getKickChatSubscriptionStatuses(slugs);
  });

  ipcMain.handle("chat:list", (event, slug: unknown) => {
    assertTrustedSender(event);
    return chatReceiver.listMessages(slug, 500, getRecordingOutputDirectory());
  });


  ipcMain.handle("recording:export-chat-ass", async (event, inputPath: unknown) => {
    assertTrustedSender(event);
    const directory = getRecordingOutputDirectory();
    if (
      typeof inputPath !== "string" ||
      !isPathInsideDirectory(inputPath, directory) ||
      !existsSync(inputPath) ||
      ![".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"].includes(extname(inputPath).toLowerCase())
    ) {
      throw new Error("対象の録画ファイルが見つからないか、保存先フォルダー外です。");
    }

    const timeline = getRecordingTimeline(inputPath);
    const messages = chatReceiver.listMessages(timeline.slug, 50000, directory);
    if (messages.length === 0) {
      throw new Error(timeline.slug + " の保存済みコメントがありません。チャット受信ログを確認してください。");
    }
    const generated = createCommentAss(messages, timeline);
    if (generated.count === 0) {
      throw new Error("この録画時間内のコメントが見つかりません。配信開始時刻とコメント時刻を確認してください。");
    }
    if (!mainWindow) throw new Error("アプリ画面が利用できません。");
    const defaultPath = inputPath.replace(/\.[^.]+$/, "") + ".ass";
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "コメント字幕（ASS）を書き出す",
      defaultPath,
      buttonLabel: "字幕を保存",
      filters: [{ name: "ASS字幕ファイル", extensions: ["ass"] }]
    });
    if (result.canceled || !result.filePath) return { saved: false, count: generated.count };
    writeFileSync(result.filePath, generated.content, { encoding: "utf8", mode: 0o600 });
    return {
      saved: true,
      path: result.filePath,
      count: generated.count,
      slug: timeline.slug,
      startedAt: timeline.startedAt,
      endedAt: timeline.endedAt,
      durationMs: Date.parse(timeline.endedAt) - Date.parse(timeline.startedAt),
      startReference: timeline.startReference
    };
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
    try {
      const results = await checkKickChannels([slug]);
      return await createKickArticle(slug, results[0], false);
    } catch (error) {
      if (typeof slug === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(slug)) {
        writeArticleAnalysisLog({
          slug,
          status: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
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
