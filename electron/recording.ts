import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

export type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
  startedAt?: string;
  endedAt?: string;
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
  outputDirectory: string;
  startedAt: string | null;
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


function findCompletedVideoPath(session: ActiveRecording): string | null {
  const candidate = resolve(session.filePath);
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile() && extname(candidate)) return candidate;
    } catch { /* 録画ファイルが確定する直前なら候補一覧へ */ }
  }

  const prefix = basename(session.filePath).replace(/\.[^.]+$/, "");
  try {
    const candidates = readdirSync(session.outputDirectory)
      .filter(name => name.startsWith(prefix) && [".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"].includes(extname(name).toLowerCase()))
      .map(name => join(session.outputDirectory, name))
      .filter(path => {
        try { return statSync(path).isFile() && statSync(path).size > 0; } catch { return false; }
      })
      .sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
      });
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function saveRecordingTimeline(session: ActiveRecording, slug: string, endedAt: string): string | null {
  if (!session.startedAt) return null;
  const videoPath = findCompletedVideoPath(session);
  if (!videoPath) return null;
  const metadata = {
    version: 1,
    slug,
    videoFile: basename(videoPath),
    startedAt: session.startedAt,
    endedAt,
    startReference: "yt-dlp-process-spawn",
    note: "開始時刻は録画プロセスの起動時刻です。映像の最初のフレームとは数秒ずれる場合があります。"
  };
  try {
    writeFileSync(videoPath + ".recording.json", JSON.stringify(metadata, null, 2), { encoding: "utf8", mode: 0o600 });
    return videoPath;
  } catch (error) {
    console.error("Failed to save recording timeline metadata:", error);
    return null;
  }
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
      settled: false,
      outputDirectory,
      startedAt: null
    };
    this.active.set(slug, session);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("[") && [".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"].includes(extname(trimmed).toLowerCase()) && existsSync(trimmed)) {
          session.filePath = resolve(trimmed);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      session.stderrTail = (session.stderrTail + String(chunk)).slice(-5000);
    });

    child.once("spawn", () => {
      session.startedAt = new Date().toISOString();
      this.onEvent({ slug, status: "recording", filePath: prefix, startedAt: session.startedAt, message: "録画を開始しました。" });
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
        const endedAt = new Date().toISOString();
        const timelinePath = saveRecordingTimeline(session, slug, endedAt);
        const videoPath = timelinePath ?? session.filePath;
        const timelineMessage = timelinePath
          ? "コメント同期用の時刻情報を保存しました。"
          : "動画は保存しましたが、時刻情報サイドカーを作成できませんでした。";
        this.onEvent({
          slug,
          status: "stopped",
          filePath: videoPath,
          startedAt: session.startedAt ?? undefined,
          endedAt,
          message: session.stopRequested ? "録画を停止しました。" + timelineMessage : "配信が終了し、録画を完了しました。" + timelineMessage
        });
        return;
      }
      const detail = session.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
      this.onEvent({
        slug,
        status: "error",
        filePath: session.filePath,
        message: detail || `録画が異常終了しました（終了コード：${String(code)}、signal：${String(signal)}）。`
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
