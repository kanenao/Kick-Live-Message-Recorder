import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { broadcastFileStem } from "./recording-filenames";
import { recordingChannelFolder } from "./recording-folders";

export type VodDownloadStatus = "queued" | "downloading" | "completed" | "cancelled" | "error";

export type VodDownloadJob = {
  id: string;
  url: string;
  slug: string;
  videoId: string;
  status: VodDownloadStatus;
  progress: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  estimatedRemainingSeconds?: number;
  filePath?: string;
  message: string;
};

type InternalJob = {
  data: VodDownloadJob;
  outputDirectory: string;
  outputPrefix: string;
  child: ChildProcessWithoutNullStreams | null;
  stderrTail: string;
  stdoutBuffer: string;
  stopRequested: boolean;
  settled: boolean;
  lastProgressEvent: number;
};

export function parseKickVodUrl(input: unknown): { url: string; slug: string; videoId: string } {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("Kickの過去配信URLを入力してください。");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Kickの過去配信URLが正しくありません。");
  }
  if (parsed.protocol !== "https:" || !["kick.com", "www.kick.com"].includes(parsed.hostname.toLowerCase()) ||
      parsed.port || parsed.username || parsed.password) {
    throw new Error("https://kick.com/チャンネル/videos/動画ID のURLを入力してください。");
  }
  const match = parsed.pathname.match(/^\/([a-zA-Z0-9_-]{1,40})\/videos\/([a-f0-9-]{20,40})\/?$/i);
  if (!match) throw new Error("Kickの過去配信URL（チャンネル/videos/動画ID）を入力してください。");
  const slug = match[1].toLowerCase();
  const videoId = match[2].toLowerCase();
  return { slug, videoId, url: `https://kick.com/${slug}/videos/${videoId}` };
}

export function parseVodProgress(line: string): { progress: number; estimatedRemainingSeconds?: number } | null {
  const percentage = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (!percentage) return null;
  const progress = Math.max(0, Math.min(100, Number(percentage[1])));
  const estimate = line.match(/\bETA\s+(\d{1,3}:\d{2}(?::\d{2})?)/);
  let estimatedRemainingSeconds: number | undefined;
  if (estimate) {
    const parts = estimate[1].split(":").map(Number);
    estimatedRemainingSeconds = parts.reduce((total, value) => total * 60 + value, 0);
  }
  return { progress, estimatedRemainingSeconds };
}

function findExecutable(name: "yt-dlp" | "ffmpeg"): string {
  const exe = process.platform === "win32" ? name + ".exe" : name;
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [join(process.resourcesPath, "tools", exe)] : []),
    join(process.cwd(), "vendor", "win-x64", exe),
    join(process.cwd(), "vendor", exe)
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? exe;
}

const MAX_PARALLEL = 3;
const MAX_BATCH_SIZE = 20;
const MAX_HISTORY = 100;

/** Separate from live recording: each VOD has its own process, progress and cancellation. */
export class KickVodDownloadManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly pending: string[] = [];
  private readonly running = new Set<string>();
  private counter = 0;
  private stopping = false;

  private readonly onChange: (job: VodDownloadJob) => void;
  private readonly spawnProcess: typeof spawn;
  private readonly resolveBroadcastInfo?: (url: string) => Promise<{ startedAt: string; displayName: string }>;

  constructor(onChange: (job: VodDownloadJob) => void, spawnProcess: typeof spawn = spawn,
    resolveBroadcastInfo?: (url: string) => Promise<{ startedAt: string; displayName: string }>) {
    this.onChange = onChange;
    this.spawnProcess = spawnProcess;
    this.resolveBroadcastInfo = resolveBroadcastInfo;
  }

  hasActiveDownloads(): boolean {
    return [...this.jobs.values()].some(job => job.data.status === "queued" || job.data.status === "downloading");
  }

  list(): VodDownloadJob[] {
    return [...this.jobs.values()].map(job => ({ ...job.data })).reverse();
  }

  enqueue(inputUrls: unknown, inputDirectory: unknown): VodDownloadJob[] {
    if (this.stopping) throw new Error("アプリを終了中です。");
    if (!Array.isArray(inputUrls) || inputUrls.length < 1 || inputUrls.length > MAX_BATCH_SIZE) {
      throw new Error(`1回に1〜${MAX_BATCH_SIZE}件のURLを指定してください。`);
    }
    const urls = inputUrls.map(parseKickVodUrl);
    const directory = typeof inputDirectory === "string" && inputDirectory.trim() ? resolve(inputDirectory) : "";
    if (!directory) throw new Error("録画の保存先が設定されていません。");

    const existing = new Set([...this.jobs.values()]
      .filter(job => job.data.status === "queued" || job.data.status === "downloading")
      .map(job => job.data.videoId));
    const unique = urls.filter(item => {
      if (existing.has(item.videoId)) return false;
      existing.add(item.videoId);
      return true;
    });
    if (unique.length === 0) throw new Error("指定した番組はすべてダウンロード待ち、または実行中です。");

    mkdirSync(directory, { recursive: true });
    // Keep the active list small without deleting queued/running jobs.
    for (const [id, job] of this.jobs) {
      if (this.jobs.size + unique.length <= MAX_HISTORY) break;
      if (["completed", "cancelled", "error"].includes(job.data.status)) this.jobs.delete(id);
    }
    if (this.jobs.size + unique.length > MAX_HISTORY) {
      throw new Error("ダウンロード履歴が上限です。処理完了後、アプリを再起動してください。");
    }

    const videoDirectories = unique.map(item => recordingChannelFolder(directory, item.slug));
    const created = unique.map((item, index) => {
      const id = `vod-${Date.now()}-${++this.counter}`;
      const data: VodDownloadJob = {
        id, url: item.url, slug: item.slug, videoId: item.videoId,
        status: "queued", progress: 0, createdAt: new Date().toISOString(), message: "順番待ち"
      };
      this.jobs.set(id, {
        data, outputDirectory: videoDirectories[index],
        outputPrefix: join(videoDirectories[index], broadcastFileStem({
          slug: item.slug, displayName: item.slug, startedAt: null, kind: "VOD", videoId: item.videoId
        })),
        child: null, stderrTail: "", stdoutBuffer: "", stopRequested: false,
        settled: false, lastProgressEvent: 0
      });
      this.pending.push(id);
      this.emit(id);
      return { ...data };
    });
    this.pump();
    return created;
  }

  cancel(inputId: unknown): { ok: true } {
    if (typeof inputId !== "string") throw new Error("ダウンロードIDが不正です。");
    const job = this.jobs.get(inputId);
    if (!job || (job.data.status !== "queued" && job.data.status !== "downloading")) {
      throw new Error("対象のダウンロードは実行中ではありません。");
    }
    job.stopRequested = true;
    if (job.data.status === "queued" || !job.child) {
      this.finish(inputId, "cancelled", "ダウンロードを取り消しました。");
    } else {
      job.data.message = "停止中...";
      this.emit(inputId);
      try { job.child.kill("SIGINT"); } catch { job.child.kill(); }
    }
    return { ok: true };
  }

  isFileActive(filePath: string): boolean {
    const target = resolve(filePath);
    return [...this.running].some(id => {
      const job = this.jobs.get(id);
      return job ? target.startsWith(job.outputPrefix) : false;
    });
  }

  stopAll(): void {
    this.stopping = true;
    for (const job of this.jobs.values()) {
      job.stopRequested = true;
      if (job.child) {
        try { job.child.kill("SIGINT"); } catch { job.child.kill(); }
      }
    }
    this.pending.length = 0;
  }

  private emit(id: string): void {
    const job = this.jobs.get(id);
    if (job) this.onChange({ ...job.data });
  }

  private pump(): void {
    while (!this.stopping && this.running.size < MAX_PARALLEL && this.pending.length) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.data.status !== "queued") continue;
      this.running.add(id);
      this.launch(id, job);
    }
  }

  private launch(id: string, job: InternalJob): void {
    if (!this.resolveBroadcastInfo) {
      this.startProcess(id, job);
      return;
    }
    job.data.message = "Kickの配信開始日時を取得しています。";
    this.emit(id);
    void this.resolveBroadcastInfo(job.data.url).then(info => {
      if (job.stopRequested || job.settled || this.stopping) {
        this.finish(id, "cancelled", "ダウンロードを停止しました。");
        return;
      }
      job.outputPrefix = join(job.outputDirectory, broadcastFileStem({
        slug: job.data.slug, displayName: info.displayName,
        startedAt: info.startedAt, kind: "VOD", videoId: job.data.videoId
      }));
      this.startProcess(id, job);
    }).catch(error => {
      if (job.stopRequested || job.settled || this.stopping) {
        this.finish(id, "cancelled", "ダウンロードを停止しました。");
        return;
      }
      // Never invent a broadcast date from the download time.
      job.data.message = "配信日時を取得できなかったため、日時未取得として保存します：" +
        (error instanceof Error ? error.message : String(error));
      this.emit(id);
      this.startProcess(id, job);
    });
  }

  private startProcess(id: string, job: InternalJob): void {
    const stem = job.outputPrefix;
    let target = stem;
    let take = 2;
    while (readdirSync(job.outputDirectory).some(name =>
      name === basename(target) + ".mp4" || name === basename(target) + ".mkv" ||
      name === basename(target) + ".ts" || name === basename(target) + ".webm")) {
      target = stem + "_take" + take++;
    }
    job.outputPrefix = target;
    const args = [
      "--no-warnings", "--no-color", "--newline", "--no-playlist",
      "--no-part", "--no-overwrites", "--socket-timeout", "30",
      "--retries", "10", "--fragment-retries", "10",
      "--format", "best",
      "--output", `${job.outputPrefix}.%(ext)s`,
      "--print", "after_move:filepath",
      ...(existsSync(findExecutable("ffmpeg")) ? ["--ffmpeg-location", findExecutable("ffmpeg")] : []),
      job.data.url
    ];
    job.data.status = "downloading";
    job.data.startedAt = new Date().toISOString();
    job.data.message = "ダウンロードを開始しています。";
    this.emit(id);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(findExecutable("yt-dlp"), args, {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.finish(id, "error", error instanceof Error ? error.message : String(error));
      return;
    }
    job.child = child;
    let settled = false;
    const onExit = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (job.stopRequested) {
        this.finish(id, "cancelled", "ダウンロードを停止しました。");
      } else if (!error && code === 0) {
        job.data.progress = 100;
        this.finish(id, "completed", "ダウンロードが完了しました。");
      } else {
        const detail = job.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
        this.finish(id, "error", detail || (error ? error.message : `yt-dlpが終了コード ${String(code)} で終了しました。`));
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      job.stdoutBuffer = (job.stdoutBuffer + String(chunk)).slice(-10000);
      const lines = job.stdoutBuffer.split(/\r?\n|\r/);
      job.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseVodProgress(line);
        if (progress) {
          job.data.progress = progress.progress;
          job.data.estimatedRemainingSeconds = progress.estimatedRemainingSeconds;
          const now = Date.now();
          if (now - job.lastProgressEvent > 350 || progress.progress >= 100) {
            job.lastProgressEvent = now;
            job.data.message = "ダウンロード中";
            this.emit(id);
          }
        } else {
          const path = line.trim();
          if (path && resolve(path).startsWith(resolve(job.outputDirectory) + sep) &&
              basename(path).startsWith(basename(job.outputPrefix))) {
            job.data.filePath = path;
          }
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      job.stderrTail = (job.stderrTail + String(chunk)).slice(-3500);
    });
    child.once("error", error => onExit(null, error));
    child.once("close", code => onExit(code));
  }

  private finish(id: string, status: "completed" | "cancelled" | "error", message: string): void {
    const job = this.jobs.get(id);
    if (!job || job.settled) return;
    job.settled = true;
    job.child = null;
    if (status === "completed") {
      try {
        const prefix = basename(job.outputPrefix);
        const video = readdirSync(job.outputDirectory)
          .filter(name => name.startsWith(prefix) && [".mp4", ".mkv", ".ts", ".webm", ".mov", ".m4v"].includes(extname(name).toLowerCase()))
          .map(name => join(job.outputDirectory, name))
          .find(path => statSync(path).isFile() && statSync(path).size > 0);
        if (video) job.data.filePath = video;
        else {
          status = "error";
          message = "処理は終了しましたが、動画ファイルが生成されていません。";
        }
      } catch {
        status = "error";
        message = "動画ファイルの保存を確認できませんでした。";
      }
    }
    job.data.status = status;
    job.data.finishedAt = new Date().toISOString();
    job.data.estimatedRemainingSeconds = undefined;
    job.data.durationMs = job.data.startedAt
      ? Math.max(0, Date.parse(job.data.finishedAt) - Date.parse(job.data.startedAt))
      : 0;
    job.data.message = message;
    this.running.delete(id);
    const pos = this.pending.indexOf(id);
    if (pos >= 0) this.pending.splice(pos, 1);
    this.emit(id);
    this.pump();
  }
}
