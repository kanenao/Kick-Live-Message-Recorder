import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent
} from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
          !/^[a-zA-Z0-9_]{1,50}$/.test(channel.name) ||
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
