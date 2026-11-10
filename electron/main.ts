import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent
} from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    outputDirectory: ""
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

let mainWindow: BrowserWindow | null = null;

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
        : ""
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

  ipcMain.handle("app:get-info", event => {
    assertTrustedSender(event);
    return {
      version: app.getVersion(),
      dataDirectory: app.getPath("userData"),
      isPackaged: app.isPackaged
    };
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
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#111318",
    title: "Kick Recorder",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
