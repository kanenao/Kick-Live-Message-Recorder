import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type RecordingStatus = {
  slug: string;
  status: "starting" | "recording" | "reconnecting" | "stopping" | "stopped" | "error";
  startedAt: string;
  filePath: string;
  progress: string;
  message: string;
  reconnectCount: number;
  exitCode?: number | null;
};

export type RecorderConfig = {
  ytDlpPath: string;
  ffmpegPath: string;
  outputDirectory: string;
};

type Session = {
  info: RecordingStatus;
  config: RecorderConfig;
  child: ChildProcess | null;
  stopping: boolean;
  fatalError?: string;
  restartTimer?: NodeJS.Timeout;
};

const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 5_000;

export class RecorderManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly onUpdate: (status: RecordingStatus) => void) {}

  getStatus(slug: string): RecordingStatus | null {
    const session = this.sessions.get(slug.toLowerCase());
    return session ? { ...session.info } : null;
  }

  getAllStatuses(): RecordingStatus[] {
    return [...this.sessions.values()].map(session => ({ ...session.info }));
  }

  start(slugInput: string, config: RecorderConfig): RecordingStatus {
    const slug = slugInput.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(slug)) {
      throw new Error("チャンネル名が正しくありません。");
    }
    const existing = this.sessions.get(slug);
    if (existing && ["starting", "recording", "reconnecting", "stopping"].includes(existing.info.status)) {
      throw new Error("このチャンネルはすでに録画中、または録画処理の準備中です。");
    }

    const executable = config.ytDlpPath.trim();
    if (!executable) {
      throw new Error("設定画面で yt-dlp.exe の場所を指定してください。");
    }
    if ((executable.includes("\\") || executable.includes("/")) && !existsSync(executable)) {
      throw new Error("指定された yt-dlp.exe が見つかりません。設定画面で場所を選び直してください。");
    }
    if (config.ffmpegPath && !existsSync(config.ffmpegPath)) {
      throw new Error("指定された FFmpeg が見つかりません。設定画面で場所を選び直してください。");
    }
    if (!config.outputDirectory.trim()) {
      throw new Error("録画の保存先フォルダーを設定してください。");
    }

    const channelDirectory = join(config.outputDirectory, slug);
    mkdirSync(channelDirectory, { recursive: true });
    const filePath = join(channelDirectory, "%(upload_date)s_%(title).120s_%(id)s.%(ext)s");
    const info: RecordingStatus = {
      slug,
      status: "starting",
      startedAt: new Date().toISOString(),
      filePath,
      progress: "",
      message: "録画プロセスを起動しています。",
      reconnectCount: 0
    };
    const session: Session = {
      info,
      config: { ...config },
      child: null,
      stopping: false
    };
    this.sessions.set(slug, session);
    this.publish(session);
    this.startProcess(session);
    return { ...session.info };
  }

  stop(slugInput: string): RecordingStatus | null {
    const session = this.sessions.get(slugInput.toLowerCase());
    if (!session) return null;
    if (!session.child) {
      if (session.restartTimer) clearTimeout(session.restartTimer);
      session.stopping = true;
      session.info.status = "stopped";
      session.info.message = "録画を停止しました。";
      this.publish(session);
      return { ...session.info };
    }
    session.stopping = true;
    if (session.restartTimer) clearTimeout(session.restartTimer);
    session.info.status = "stopping";
    session.info.message = "録画を停止しています。";
    this.publish(session);
    session.child.kill();
    return { ...session.info };
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stopping = true;
      if (session.restartTimer) clearTimeout(session.restartTimer);
      session.child?.kill();
    }
  }

  private publish(session: Session): void {
    this.onUpdate({ ...session.info });
  }

  private startProcess(session: Session): void {
    if (session.stopping) return;
    const slug = session.info.slug;
    const config = session.config;
    const args = [
      "--no-warnings",
      "--newline",
      "--no-playlist",
      "--windows-filenames",
      "--no-overwrites",
      "--retries", "infinite",
      "--fragment-retries", "infinite",
      "--retry-sleep", "fragment:exp=1:20",
      "--merge-output-format", "mp4",
      "--output", session.info.filePath,
      "--progress-template", "download:進捗 %(progress._percent_str)s / %(progress._speed_str)s / 残り %(progress._eta_str)s"
    ];
    if (config.ffmpegPath) args.push("--ffmpeg-location", config.ffmpegPath);
    args.push(`https://kick.com/${slug}`);

    let child: ChildProcess;
    try {
      child = spawn(config.ytDlpPath, args, {
        cwd: config.outputDirectory,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      session.fatalError = error instanceof Error ? error.message : String(error);
      session.info.status = "error";
      session.info.message = `録画プロセスを起動できませんでした：${session.fatalError}`;
      this.publish(session);
      return;
    }
    session.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const lastLine = lines.at(-1);
      if (!lastLine) return;
      if (lastLine.includes("進捗") || lastLine.includes("[download]") || lastLine.includes("Destination:")) {
        session.info.status = "recording";
        session.info.progress = lastLine.slice(0, 240);
        session.info.message = "Kick配信を録画しています。";
        this.publish(session);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      const lastLine = text.split(/\r?\n/).at(-1)?.trim();
      if (!lastLine) return;
      if (/error|failed|unable|HTTP Error/i.test(lastLine)) {
        session.info.message = lastLine.slice(0, 240);
        this.publish(session);
      }
    });

    child.on("error", error => {
      session.fatalError = error.message;
      session.child = null;
      session.info.status = "error";
      session.info.message = `録画ツールを起動できませんでした：${error.message}`;
      this.publish(session);
    });

    child.on("close", code => {
      session.child = null;
      session.info.exitCode = code;
      if (session.fatalError) {
        session.info.status = "error";
        session.info.message = `録画に失敗しました：${session.fatalError}`;
        this.publish(session);
        return;
      }
      if (session.stopping) {
        session.info.status = "stopped";
        session.info.message = "録画を停止しました。";
        this.publish(session);
        return;
      }
      if (code === 0) {
        session.info.status = "stopped";
        session.info.message = "配信または録画処理が終了しました。";
        this.publish(session);
        return;
      }
      if (session.info.reconnectCount < MAX_RECONNECTS) {
        session.info.reconnectCount += 1;
        session.info.status = "reconnecting";
        session.info.message = `通信が切れました。再接続を試みます（${session.info.reconnectCount}/${MAX_RECONNECTS}）。`;
        this.publish(session);
        session.restartTimer = setTimeout(() => this.startProcess(session), RECONNECT_DELAY_MS);
        session.restartTimer.unref();
        return;
      }
      session.info.status = "error";
      session.info.message = `録画が異常終了しました（終了コード：${code ?? "不明"}）。再接続上限に達しました。`;
      this.publish(session);
    });
  }
}
