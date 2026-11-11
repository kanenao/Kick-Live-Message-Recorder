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

type ActiveRecording = {
  child: ChildProcessWithoutNullStreams;
  stopRequested: boolean;
  filePath: string;
  stderrTail: string;
  settled: boolean;
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

export class KickRecordingManager {
  private readonly active = new Map<string, ActiveRecording>();

  constructor(private readonly onEvent: (event: RecordingEvent) => void) {}

  isRecording(slug: string): boolean {
    return this.active.has(slug.toLowerCase());
  }

  start(inputSlug: unknown, inputDirectory: unknown): { ok: true; outputDirectory: string } {
    const slug = validateSlug(inputSlug);
    if (this.active.has(slug)) {
      throw new Error(`${slug} はすでに録画中です。`);
    }

    const outputDirectory = typeof inputDirectory === "string" && inputDirectory.trim()
      ? resolve(inputDirectory)
      : "";
    if (!outputDirectory) throw new Error("録画の保存先が設定されていません。");

    mkdirSync(outputDirectory, { recursive: true });
    const prefix = join(outputDirectory, `${slug}_${timestampForFilename(new Date())}`);
    const outputTemplate = `${prefix}.%(ext)s`;
    const url = `https://kick.com/${slug}`;
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
      "--output", outputTemplate,
      "--print", "after_move:filepath",
      ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
      url
    ];

    this.onEvent({ slug, status: "starting", message: "録画プロセスを起動しています。" });

    const child = spawn(findYtDlp(), args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const session: ActiveRecording = {
      child,
      stopRequested: false,
      filePath: prefix,
      stderrTail: "",
      settled: false
    };
    this.active.set(slug, session);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("[") && (trimmed.includes("/") || trimmed.includes("\\\\"))) {
          session.filePath = trimmed;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      session.stderrTail = (session.stderrTail + String(chunk)).slice(-5000);
    });

    child.once("spawn", () => {
      this.onEvent({ slug, status: "recording", filePath: prefix, message: "録画を開始しました。" });
    });

    child.once("error", error => {
      session.settled = true;
      this.active.delete(slug);
      this.onEvent({
        slug,
        status: "error",
        filePath: session.filePath,
        message: error.message.includes("ENOENT")
          ? "yt-dlp.exe が見つかりません。同梱ファイルまたはPATHを確認してください。"
          : `録画プロセスを起動できませんでした：${error.message}`
      });
    });

    child.once("close", (code, signal) => {
      if (session.settled) return;
      session.settled = true;
      this.active.delete(slug);
      if (session.stopRequested || code === 0) {
        this.onEvent({
          slug,
          status: "stopped",
          filePath: session.filePath,
          message: session.stopRequested ? "録画を停止しました。" : "配信が終了し、録画を完了しました。"
        });
        return;
      }
      const stderr = session.stderrTail.trim();
      const lowerStderr = stderr.toLowerCase();
      const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
      const message = lowerStderr.includes("ffmpeg could not be found")
        || lowerStderr.includes("ffmpeg not found")
        ? "ffmpeg.exe が見つかりません。アプリを最新版に更新して再インストールしてください。"
        : detail || `録画が異常終了しました（終了コード：${String(code)}、signal：${String(signal)}）。`;
      this.onEvent({
        slug,
        status: "error",
        filePath: session.filePath,
        message
      });
    });

    return { ok: true, outputDirectory };
  }

  stop(inputSlug: unknown): { ok: true } {
    const slug = validateSlug(inputSlug);
    const session = this.active.get(slug);
    if (!session) throw new Error(`${slug} は録画中ではありません。`);

    session.stopRequested = true;
    try {
      session.child.kill("SIGINT");
    } catch {
      session.child.kill();
    }
    return { ok: true };
  }

  stopAll(): void {
    for (const session of this.active.values()) {
      session.stopRequested = true;
      try {
        session.child.kill("SIGINT");
      } catch {
        session.child.kill();
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
      // ファイルが一覧取得中に削除された場合はスキップする。
    }
  }

  return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

export function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const target = resolve(filePath);
  const root = resolve(directory);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
