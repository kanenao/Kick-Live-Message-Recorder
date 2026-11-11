import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

export type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
};

export type RecordingFile = {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
};

export type RecordingOptions = {
  retryCount?: number;
  retryDelaySeconds?: number;
};

type ActiveRecording = {
  child: ChildProcessWithoutNullStreams | null;
  stopRequested: boolean;
  filePath: string;
  basePrefix: string;
  outputDirectory: string;
  stderrTail: string;
  retriesUsed: number;
  maxRetries: number;
  retryDelayMs: number;
  attempt: number;
  retryTimer: NodeJS.Timeout | null;
};

function validateSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(value)) {
    throw new Error("Kickチャンネル名が不正です。");
  }
  return value.toLowerCase();
}

function findYtDlp(): string {
  const executable = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [
    join(process.resourcesPath, "tools", executable),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable)
  ];
  const bundled = candidates.find(candidate => existsSync(candidate));
  return bundled ?? executable;
}

function findFfmpeg(): string | undefined {
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    join(process.resourcesPath, "tools", executable),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable)
  ];
  return candidates.find(candidate => existsSync(candidate));
}

function timestampForFilename(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export class KickRecordingManager {
  private readonly active = new Map<string, ActiveRecording>();

  constructor(private readonly onEvent: (event: RecordingEvent) => void) {}

  isRecording(slug: string): boolean {
    return this.active.has(slug.toLowerCase());
  }

  start(
    inputSlug: unknown,
    inputDirectory: unknown,
    options: RecordingOptions = {}
  ): { ok: true; outputDirectory: string } {
    const slug = validateSlug(inputSlug);
    if (this.active.has(slug)) {
      throw new Error(`${slug} はすでに録画中です。`);
    }

    const outputDirectory = typeof inputDirectory === "string" && inputDirectory.trim()
      ? resolve(inputDirectory)
      : "";
    if (!outputDirectory) throw new Error("録画の保存先が設定されていません。");

    mkdirSync(outputDirectory, { recursive: true });
    const basePrefix = join(outputDirectory, `${slug}_${timestampForFilename(new Date())}`);
    const session: ActiveRecording = {
      child: null,
      stopRequested: false,
      filePath: basePrefix,
      basePrefix,
      outputDirectory,
      stderrTail: "",
      retriesUsed: 0,
      maxRetries: boundedInteger(options.retryCount, 5, 0, 10),
      retryDelayMs: boundedInteger(options.retryDelaySeconds, 10, 5, 60) * 1000,
      attempt: 0,
      retryTimer: null
    };

    this.active.set(slug, session);
    this.onEvent({ slug, status: "starting", filePath: basePrefix, message: "録画プロセスを起動しています。" });
    this.launch(slug, session);

    return { ok: true, outputDirectory };
  }

  private launch(slug: string, session: ActiveRecording): void {
    if (session.stopRequested || this.active.get(slug) !== session) return;

    session.attempt += 1;
    session.stderrTail = "";
    const suffix = session.attempt === 1
      ? ""
      : `_retry${String(session.attempt).padStart(2, "0")}`;
    const prefix = `${session.basePrefix}${suffix}`;
    session.filePath = prefix;

    const ffmpegPath = findFfmpeg();
    const args = [
      "--no-warnings",
      "--no-color",
      "--newline",
      "--no-playlist",
      "--no-part",
      "--hls-use-mpegts",
      "--no-overwrites",
      "--socket-timeout", "30",
      "--retries", "10",
      "--fragment-retries", "10",
      "--retry-sleep", "linear=1::5",
      "--format", "best",
      "--output", `${prefix}.%(ext)s`,
      "--print", "after_move:filepath",
      ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
      `https://kick.com/${slug}`
    ];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(findYtDlp(), args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.finishAttempt(slug, session, null, null, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    session.child = child;
    let attemptSettled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (attemptSettled) return;
      attemptSettled = true;
      this.finishAttempt(slug, session, code, signal, error);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const output = String(chunk);
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("[") && (trimmed.includes("/") || trimmed.includes("\\"))) {
          session.filePath = trimmed;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      session.stderrTail = (session.stderrTail + String(chunk)).slice(-5000);
    });

    child.once("spawn", () => {
      if (session.stopRequested) {
        child.kill();
        return;
      }
      this.onEvent({
        slug,
        status: "recording",
        filePath: prefix,
        message: session.attempt === 1
          ? "録画を開始しました。"
          : `再接続に成功しました（${session.attempt - 1}/${session.maxRetries}回目）。`
      });
    });

    child.once("error", error => settle(null, null, error));
    child.once("close", (code, signal) => settle(code, signal));
  }

  private finishAttempt(
    slug: string,
    session: ActiveRecording,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: Error
  ): void {
    session.child = null;
    if (session.stopRequested || this.active.get(slug) !== session) {
      this.active.delete(slug);
      this.onEvent({ slug, status: "stopped", filePath: session.filePath, message: "録画を停止しました。" });
      return;
    }

    if (!spawnError && code === 0) {
      this.active.delete(slug);
      this.onEvent({
        slug,
        status: "stopped",
        filePath: session.filePath,
        message: "配信が終了し、録画を完了しました。"
      });
      return;
    }

    const stderr = session.stderrTail.trim();
    const lowerStderr = stderr.toLowerCase();
    const spawnCode = spawnError && "code" in spawnError ? String(spawnError.code) : "";
    const missingExecutable = spawnCode === "ENOENT";
    const missingFfmpeg = lowerStderr.includes("ffmpeg could not be found")
      || lowerStderr.includes("ffmpeg not found");
    const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
    const terminalMessage = missingExecutable
      ? "yt-dlp.exe が見つかりません。同梱ファイルまたはPATHを確認してください。"
      : missingFfmpeg
        ? "ffmpeg.exe が見つかりません。アプリを最新版に更新して再インストールしてください。"
        : detail || (spawnError
          ? `録画プロセスを起動できませんでした：${spawnError.message}`
          : `録画が異常終了しました（終了コード：${String(code)}、signal：${String(signal)}）。`);

    if (!missingExecutable && !missingFfmpeg && session.retriesUsed < session.maxRetries) {
      session.retriesUsed += 1;
      const retryNumber = session.retriesUsed;
      const delaySeconds = Math.round(session.retryDelayMs / 1000);
      this.onEvent({
        slug,
        status: "starting",
        filePath: session.filePath,
        message: `録画接続が切れました。${delaySeconds}秒後に再接続します（${retryNumber}/${session.maxRetries}回目）。`
      });
      session.retryTimer = setTimeout(() => {
        session.retryTimer = null;
        this.launch(slug, session);
      }, session.retryDelayMs);
      return;
    }

    this.active.delete(slug);
    this.onEvent({ slug, status: "error", filePath: session.filePath, message: terminalMessage });
  }

  stop(inputSlug: unknown): { ok: true } {
    const slug = validateSlug(inputSlug);
    const session = this.active.get(slug);
    if (!session) throw new Error(`${slug} は録画中ではありません。`);

    session.stopRequested = true;
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }

    if (session.child) {
      try {
        session.child.kill("SIGINT");
      } catch {
        session.child.kill();
      }
    } else {
      this.active.delete(slug);
      this.onEvent({ slug, status: "stopped", filePath: session.filePath, message: "再接続待ちを取り消し、録画を停止しました。" });
    }
    return { ok: true };
  }

  stopAll(): void {
    for (const [slug, session] of this.active) {
      session.stopRequested = true;
      if (session.retryTimer) {
        clearTimeout(session.retryTimer);
        session.retryTimer = null;
      }
      if (session.child) {
        try {
          session.child.kill("SIGINT");
        } catch {
          session.child.kill();
        }
      } else {
        this.active.delete(slug);
      }
    }
  }
}

export function listRecordingFiles(outputDirectory: string): RecordingFile[] {
  const directory = resolve(outputDirectory);
  if (!existsSync(directory)) return [];

  const supportedExtensions = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
  const files: RecordingFile[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fullPath = join(directory, entry.name);
    const extension = extname(entry.name).toLowerCase();
    if (!supportedExtensions.has(extension)) continue;

    try {
      const stats = statSync(fullPath);
      files.push({
        path: fullPath,
        name: basename(entry.name),
        extension: extension.slice(1).toUpperCase(),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      });
    } catch {
      // 録画一覧の取得中にファイルが削除された場合はスキップする。
    }
  }

  return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

export function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const target = resolve(filePath);
  const root = resolve(directory);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
