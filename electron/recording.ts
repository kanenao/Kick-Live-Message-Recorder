import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { broadcastFileStem } from "./recording-filenames";
import { recordingChannelFolder, recordingLibraryDirectories, isRecordingLibraryFileParent } from "./recording-folders";
import { decideLiveRecordingRecovery, hasLiveRecordingStalled, LIVE_RECORDING_WATCHDOG_INTERVAL_MS, LIVE_RECORDING_FORCE_KILL_TIMEOUT_MS, type LiveProbeResult } from "./recording-recovery";

export type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
  isVod?: boolean;
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
  streamStartedAt?: string | null;
  displayName?: string;
  filenameStartedAt?: string;
  chaseFromEarliest?: boolean;
  recoverVodAfterLive?: boolean;
  recoverVodChat?: boolean;
};

type ActiveRecording = {
  child: ChildProcessWithoutNullStreams | null;
  stopRequested: boolean;
  filePath: string;
  attemptPrefix: string;
  basePrefix: string;
  outputDirectory: string;
  videoDirectory: string;
  stderrTail: string;
  retriesUsed: number;
  maxRetries: number;
  retryDelayMs: number;
  attempt: number;
  retryTimer: NodeJS.Timeout | null;
  sourceUrl: string;
  isVod: boolean;
  chaseFromEarliest: boolean;
  recoverVodAfterLive: boolean;
  recoverVodChat: boolean;
  streamStartedAt: string | null;
  watchdogTimer: NodeJS.Timeout | null;
  terminationTimer: NodeJS.Timeout | null;
  bytesAtLastCheck: number;
  lastByteGrowthAt: number;
  attemptStartedAt: number;
  stallDetected: boolean;
};

function validateSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value)) {
    throw new Error("Kickチャンネル名が不正です。");
  }
  return value.toLowerCase();
}

function validateVodUrl(value: unknown, expectedSlug: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("過去配信のURLを入力してください。");
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("Kickの過去配信URLが正しくありません。"); }
  if (parsed.protocol !== "https:" || !["kick.com", "www.kick.com"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Kick公式サイトの過去配信URL（https://kick.com/チャンネル/videos/動画ID）を入力してください。");
  }
  const match = parsed.pathname.match(/^\/([a-zA-Z0-9_-]{1,40})\/videos\/([a-f0-9-]{20,40})\/?$/i);
  if (!match || match[1].toLowerCase() !== expectedSlug.toLowerCase()) throw new Error("URLのチャンネル名が一致しません。https://kick.com/チャンネル/videos/動画ID の形式で入力してください。");
  return `https://kick.com/${match[1]}/videos/${match[2]}`;
}
function findYtDlp(): string {
  const executable = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [join(process.resourcesPath, "tools", executable)] : []),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable)
  ];
  const bundled = candidates.find(candidate => existsSync(candidate));
  return bundled ?? executable;
}

function findFfmpeg(): string | undefined {
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [join(process.resourcesPath, "tools", executable)] : []),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable)
  ];
  return candidates.find(candidate => existsSync(candidate));
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function saveLiveRecordingTimelineMetadata(
  session: ActiveRecording,
  slug: string,
  filePrefix: string
): void {
  if (session.isVod) return;
  const startedAt = new Date();
  const chasing = session.chaseFromEarliest && session.attempt === 1;
  const metadataDirectory = join(session.outputDirectory, "RecordingMetadata");
  const metadataPath = join(metadataDirectory, basename(filePrefix) + ".json");
  const temporaryPath = metadataPath + ".tmp";
  try {
    mkdirSync(metadataDirectory, { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify({
      schemaVersion: 1,
      channelSlug: slug,
      recordingKind: "LIVE",
      filePrefix: basename(filePrefix),
      recordingStartedAt: chasing ? null : startedAt.toISOString(),
      recordingStartedAtEpochMs: chasing ? null : startedAt.getTime(),
      timestampSource: chasing ? "hls-earliest-unknown" : "yt-dlp-process-spawn"
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, metadataPath);
  } catch {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // A missing or unwritable sync sidecar must not stop the recording itself.
    }
  }
}

type SessionCompletion = "recording" | "completed" | "stopped" | "failed";

function savedVideoFiles(session: ActiveRecording): string[] {
  try {
    const prefix = basename(session.basePrefix);
    const allowed = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
    return readdirSync(session.videoDirectory)
      .filter(name => (name.startsWith(prefix + ".") || name.startsWith(prefix + "_retry")) &&
        allowed.has(extname(name).toLowerCase()))
      .map(name => join(session.videoDirectory, name))
      .filter(path => {
        try { return statSync(path).isFile() && statSync(path).size > 0; }
        catch { return false; }
      })
      .sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs; }
        catch { return 0; }
      });
  } catch { return []; }
}

function persistRecordingSession(
  session: ActiveRecording,
  slug: string,
  status: SessionCompletion,
  files: string[] = []
): void {
  const folder = join(session.outputDirectory, "RecordingSessions");
  const id = basename(session.basePrefix);
  const filePath = join(folder, id + ".json");
  const temp = filePath + "." + process.pid + ".tmp";
  try {
    mkdirSync(folder, { recursive: true });
    const previous = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown> : {};
    const startedAt = typeof previous.startedAt === "string" ? previous.startedAt : new Date().toISOString();
    const finishedAt = status !== "recording" ? new Date().toISOString() : undefined;
    writeFileSync(temp, JSON.stringify({
      schemaVersion: 1, id, slug, kind: session.isVod ? "VOD" : "LIVE",
      sourceUrl: session.sourceUrl, startedAt, status, finishedAt,
      files: files.map(file => basename(file)), retriesUsed: session.retriesUsed
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, filePath);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    console.warn("録画セッション情報の保存に失敗しました:", error);
  }
}

function recordingBytes(session: ActiveRecording): number {
  try {
    const prefix = basename(session.basePrefix);
    return readdirSync(session.videoDirectory)
      .filter(name => name.startsWith(prefix + ".") || name.startsWith(prefix + "_retry"))
      .filter(name => !name.endsWith(".json") && !name.endsWith(".tmp"))
      .reduce((total, name) => {
        try { return total + statSync(join(session.videoDirectory, name)).size; }
        catch { return total; }
      }, 0);
  } catch { return 0; }
}

export class KickRecordingManager {
  private readonly active = new Map<string, ActiveRecording>();

  constructor(
    private readonly onEvent: (event: RecordingEvent) => void,
    private readonly probeLive: (slug: string) => Promise<LiveProbeResult> = async () => null,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly onChaseComplete?: (request: {slug:string;startedAt:string|null;outputDirectory:string;recoverVodChat?:boolean}) => void
  ) {}

  private sessionKey(slug: string, isVod: boolean): string {
    return (isVod ? "vod:" : "live:") + slug;
  }

  hasActiveRecordings(): boolean {
    return this.active.size > 0;
  }

  listActiveLiveSlugs(): string[] { return [...this.active.keys()].filter(key=>key.startsWith("live:")).map(key=>key.slice(5)); }

  isRecording(slug: string): boolean {
    return this.active.has(this.sessionKey(slug.toLowerCase(), false));
  }

  isFileActive(filePath: string): boolean {
    const target = resolve(filePath);
    for (const session of this.active.values()) {
      const basePrefix = resolve(session.basePrefix);
      const currentPath = resolve(session.filePath);
      if (
        target === currentPath ||
        target.startsWith(`${basePrefix}.`) ||
        target.startsWith(`${basePrefix}_retry`)
      ) return true;
    }
    return false;
  }

  start(
    inputSlug: unknown,
    inputDirectory: unknown,
    options: RecordingOptions = {},
    inputSourceUrl?: unknown
  ): { ok: true; outputDirectory: string } {
    const slug = validateSlug(inputSlug);
    const sourceUrl = inputSourceUrl === undefined ? `https://kick.com/${slug}` : validateVodUrl(inputSourceUrl, slug);
    const isVod = inputSourceUrl !== undefined;
    if (isVod && options.chaseFromEarliest) throw new Error("追っかけ録画はLIVE専用です。");
    const chaseFromEarliest = !isVod && options.chaseFromEarliest === true;
    const sessionId = this.sessionKey(slug, isVod);
    if (this.active.has(sessionId)) {
      throw new Error(isVod
        ? `${slug} の過去配信はすでにダウンロード中です。`
        : `${slug} はすでにライブ録画中です。`);
    }

    const outputDirectory = typeof inputDirectory === "string" && inputDirectory.trim()
      ? resolve(inputDirectory)
      : "";
    if (!outputDirectory) throw new Error("録画の保存先が設定されていません。");

    mkdirSync(outputDirectory, { recursive: true });
    const videoDirectory = recordingChannelFolder(outputDirectory, slug);
    const videoId = isVod ? sourceUrl.split("/").pop() : undefined;
    const stem = broadcastFileStem({
      slug, displayName: options.displayName ?? slug,
      // A missing LIVE start uses recorder start as a best-effort fallback;
      // VOD unknown time must be labelled explicitly, never as download time.
      startedAt: options.streamStartedAt ?? options.filenameStartedAt ?? (isVod ? null : new Date().toISOString()),
      kind: isVod ? "VOD" : "LIVE", videoId
    });
    const recordingStem = chaseFromEarliest ? stem + "_chase" : stem;
    let prefix = recordingStem;
    let take = 2;
    // Never overwrite an existing broadcast when manually recording it again.
    while (readdirSync(videoDirectory).some(name => name === prefix + ".mp4" ||
      name === prefix + ".mkv" || name === prefix + ".ts" ||
      name.startsWith(prefix + "_retry")) ||
      existsSync(join(outputDirectory, "RecordingSessions", prefix + ".json"))) {
      prefix = recordingStem + "_take" + take++;
    }
    const basePrefix = join(videoDirectory, prefix);
    const session: ActiveRecording = {
      child: null,
      stopRequested: false,
      filePath: basePrefix,
      attemptPrefix: basePrefix,
      basePrefix,
      outputDirectory,
      videoDirectory,
      stderrTail: "",
      retriesUsed: 0,
      maxRetries: isVod ? 0 : boundedInteger(options.retryCount, 5, 0, 10),
      retryDelayMs: boundedInteger(options.retryDelaySeconds, 10, 5, 60) * 1000,
      attempt: 0,
      retryTimer: null,
      sourceUrl,
      isVod,
      chaseFromEarliest,
      recoverVodAfterLive: chaseFromEarliest && options.recoverVodAfterLive === true,
      recoverVodChat: chaseFromEarliest && options.recoverVodAfterLive === true && options.recoverVodChat === true,
      streamStartedAt: typeof options.streamStartedAt === "string" ? options.streamStartedAt : null,
      watchdogTimer: null,
      terminationTimer: null,
      bytesAtLastCheck: 0,
      lastByteGrowthAt: Date.now(),
      attemptStartedAt: 0,
      stallDetected: false
    };

    this.active.set(sessionId, session);
    persistRecordingSession(session, slug, "recording");
    this.onEvent({ slug, status: "starting", filePath: basePrefix, message: isVod ? "過去配信のダウンロードを開始しています。" : chaseFromEarliest ? "追っかけ録画：取得可能な最古のHLS映像から開始を試行しています。" : "録画プロセスを起動しています。", isVod });
    this.launch(sessionId, slug, session);

    return { ok: true, outputDirectory };
  }

  private interruptChild(session: ActiveRecording, child: ChildProcessWithoutNullStreams): void {
    if (session.terminationTimer) return;
    // First request graceful shutdown so yt-dlp / FFmpeg can finalize the video.
    try { child.kill("SIGINT"); } catch { try { child.kill(); } catch { /* already gone */ } }
    session.terminationTimer = setTimeout(() => {
      session.terminationTimer = null;
      if (session.child !== child || typeof child.exitCode === "number" || child.signalCode) return;
      console.warn("録画プロセスが停止要求に応答しません。強制終了を試みます。");
      // Windows: terminate the whole yt-dlp/FFmpeg process tree to avoid orphan
      // encoders that keep the recording file locked.
      if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
        try {
          const terminator = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" });
          terminator.once("error", () => { try { child.kill("SIGKILL"); } catch { /* done */ } });
          return;
        } catch { /* fall through */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, LIVE_RECORDING_FORCE_KILL_TIMEOUT_MS);
  }

  private launch(sessionId: string, slug: string, session: ActiveRecording): void {
    if (session.stopRequested || this.active.get(sessionId) !== session) return;

    session.attempt += 1;
    session.stderrTail = "";
    session.attemptStartedAt = Date.now();
    session.lastByteGrowthAt = Date.now();
    session.bytesAtLastCheck = recordingBytes(session);
    session.stallDetected = false;
    const suffix = session.attempt === 1
      ? ""
      : `_retry${String(session.attempt).padStart(2, "0")}`;
    const prefix = `${session.basePrefix}${suffix}`;
    session.filePath = prefix;
    session.attemptPrefix = prefix;

    const ffmpegPath = findFfmpeg();
    const chasing = session.chaseFromEarliest && session.attempt === 1;
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
      // Kick is not a supported yt-dlp --live-from-start site. Only request
      // the first segment still advertised by the HLS playlist. Retries use
      // ordinary live recording so already saved fragments are not replayed.
      ...(chasing ? ["--downloader", "m3u8:ffmpeg", "--downloader-args", "ffmpeg_i:-live_start_index 0"] : []),
      "--output", `${prefix}.%(ext)s`,
      "--print", "after_move:filepath",
      ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
      session.sourceUrl
    ];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(findYtDlp(), args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.finishAttempt(sessionId, slug, session, null, null, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    session.child = child;
    if (!session.isVod) {
      session.watchdogTimer = setInterval(() => {
        if (session.stopRequested || this.active.get(sessionId) !== session || session.child !== child) return;
        const bytes = recordingBytes(session);
        if (bytes > session.bytesAtLastCheck) {
          session.bytesAtLastCheck = bytes;
          session.lastByteGrowthAt = Date.now();
        }
        if (!session.stallDetected && hasLiveRecordingStalled(session.lastByteGrowthAt, Date.now())) {
          session.stallDetected = true;
          this.onEvent({ slug, status: "starting", isVod: false,
            message: "映像ファイルが3分間増えていないため、録画を再接続しています。" });
          this.interruptChild(session, child);
        }
      }, LIVE_RECORDING_WATCHDOG_INTERVAL_MS);
    }
    let attemptSettled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (attemptSettled) return;
      attemptSettled = true;
      if (session.watchdogTimer) { clearInterval(session.watchdogTimer); session.watchdogTimer = null; }
      if (session.terminationTimer) { clearTimeout(session.terminationTimer); session.terminationTimer = null; }
      void this.finishAttempt(sessionId, slug, session, code, signal, error);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const output = String(chunk);
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("[") && existsSync(trimmed) &&
            [".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"].includes(extname(trimmed).toLowerCase())) {
          session.filePath = resolve(trimmed);
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
      saveLiveRecordingTimelineMetadata(session, slug, prefix);
      this.onEvent({
        slug,
        status: "recording",
        filePath: prefix,
        isVod: session.isVod,
        message: session.attempt === 1
          ? chasing ? "追っかけ録画を試行中（取得できる最古の映像。配信開始からの保存は未確認）。" : "録画を開始しました。"
          : `再接続に成功しました（${session.attempt - 1}/${session.maxRetries}回目）。`
      });
    });

    child.once("error", error => settle(null, null, error));
    child.once("close", (code, signal) => settle(code, signal));
  }

  private async finishAttempt(
    sessionId: string,
    slug: string,
    session: ActiveRecording,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: Error
  ): Promise<void> {
    session.child = null;
    const savedFiles = savedVideoFiles(session);
    const savedPath = savedFiles[0];
    const currentPrefix = basename(session.attemptPrefix);
    const attemptProducedVideo = savedFiles.some(file =>
      basename(file).startsWith(currentPrefix + "."));

    // A stop request may be issued while waiting for the API. Never restart a
    // manually stopped session, nor emit stale messages for a replaced session.
    if (this.active.get(sessionId) !== session) return;
    if (session.stopRequested) {
      this.active.delete(sessionId);
      persistRecordingSession(session, slug, "stopped", savedFiles);
      this.onEvent({ slug, status: "stopped", filePath: savedPath, isVod: session.isVod,
        message: savedPath ? "録画を停止し、途中までの映像を保存しました。" : "録画を停止しました。映像ファイルは作成されていません。" });
      return;
    }

    if (session.isVod) {
      if (!spawnError && code === 0 && savedPath) {
        this.active.delete(sessionId);
        persistRecordingSession(session, slug, "completed", savedFiles);
        this.onEvent({ slug, status: "stopped", filePath: savedPath, isVod: true,
          message: "過去配信のファイル保存を確認しました。" });
      } else {
        this.active.delete(sessionId);
        persistRecordingSession(session, slug, "failed", savedFiles);
        this.onEvent({ slug, status: "error", filePath: savedPath, isVod: true,
          message: savedPath
            ? "過去配信のダウンロードが途中で終了しました。保存済みの動画は残します。"
            : "過去配信のダウンロードに失敗しました：" + (session.stderrTail.trim().split(/\r?\n/).slice(-2).join(" ") || spawnError?.message || String(code)) });
      }
      return;
    }

    const stderr = session.stderrTail.trim();
    const spawnCode = spawnError && "code" in spawnError ? String(spawnError.code) : "";
    const missingExecutable = spawnCode === "ENOENT";
    const missingFfmpeg = /ffmpeg could not be found|ffmpeg not found/i.test(stderr);
    const fatalError = missingExecutable || missingFfmpeg;
    const runtimeMs = Math.max(0, Date.now() - session.attemptStartedAt);

    let probe: LiveProbeResult = null;
    if (!fatalError) {
      try {
        probe = await this.probeLive(slug);
        // Confirm an offline result; transient API data can otherwise cut a live recording short.
        if (probe && !probe.isLive) {
          await new Promise<void>(resolve => setTimeout(resolve, 2500));
          const confirmation = await this.probeLive(slug);
          // Unknown status is not confirmation that a LIVE ended.
          probe = confirmation;
        }
      } catch {
        probe = null;
      }
    }
    if (this.active.get(sessionId) !== session) return;
    if (session.stopRequested) {
      this.active.delete(sessionId);
      persistRecordingSession(session, slug, "stopped", savedFiles);
      this.onEvent({ slug, status: "stopped", filePath: savedPath, isVod: false,
        message: "録画を手動停止しました。保存済み動画は保持します。" });
      return;
    }

    if (!session.streamStartedAt && probe?.isLive && probe.startedAt) {
      session.streamStartedAt = probe.startedAt;
    }
    const decision = decideLiveRecordingRecovery({
      probe, expectedStreamStartedAt: session.streamStartedAt,
      code, savedFileCount: savedFiles.length, runtimeMs, attemptProducedVideo,
      failuresUsed: session.retriesUsed, maxFailures: session.maxRetries,
      fatalError, stalled: session.stallDetected
    });

    if (decision.action === "complete") {
      this.active.delete(sessionId);
      persistRecordingSession(session, slug, "completed", savedFiles);
      this.onEvent({ slug, status: "stopped", filePath: savedPath, isVod: false,
        message: decision.message });
      if (session.recoverVodAfterLive) this.onChaseComplete?.({slug,startedAt:session.streamStartedAt,outputDirectory:session.outputDirectory,recoverVodChat:session.recoverVodChat});
      return;
    }

    if (decision.action === "retry") {
      session.retriesUsed = decision.nextFailures;
      persistRecordingSession(session, slug, "recording", savedFiles);
      const delaySeconds = Math.ceil(session.retryDelayMs / 1000);
      this.onEvent({ slug, status: "starting", filePath: savedPath, isVod: false,
        message: `${decision.message} ${delaySeconds}秒後に再接続（連続失敗 ${session.retriesUsed}/${session.maxRetries}）。${session.chaseFromEarliest && session.attempt === 1 ? " 再接続は通常LIVE録画に切り替えます。" : ""}` });
      session.retryTimer = setTimeout(() => {
        session.retryTimer = null;
        if (!session.stopRequested && this.active.get(sessionId) === session) this.launch(sessionId, slug, session);
      }, session.retryDelayMs);
      return;
    }

    this.active.delete(sessionId);
    persistRecordingSession(session, slug, "failed", savedFiles);
    const cause = missingExecutable
      ? "yt-dlp.exe が見つかりません。アプリ同梱ファイルまたはPATHを確認してください。"
      : missingFfmpeg
        ? "ffmpeg.exe が見つかりません。アプリを最新版で再インストールしてください。"
        : decision.message + (stderr ? " 詳細：" + stderr.split(/\r?\n/).slice(-2).join(" ") : "") +
          (signal ? " 終了シグナル：" + signal : "");
    this.onEvent({ slug, status: "error", filePath: savedPath, isVod: false, message: cause });
  }

  stop(inputSlug: unknown, inputIsVod: unknown = false): { ok: true } {
    const slug = validateSlug(inputSlug);
    if (typeof inputIsVod !== "boolean") throw new Error("録画種別の指定が不正です。");
    const sessionId = this.sessionKey(slug, inputIsVod);
    const session = this.active.get(sessionId);
    if (!session) throw new Error(inputIsVod
      ? `${slug} の過去配信はダウンロード中ではありません。`
      : `${slug} はライブ録画中ではありません。`);

    session.stopRequested = true;
    if (session.watchdogTimer) { clearInterval(session.watchdogTimer); session.watchdogTimer = null; }
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }

    if (session.child) {
      this.interruptChild(session, session.child);
    } else {
      this.active.delete(sessionId);
      const files = savedVideoFiles(session);
      persistRecordingSession(session, slug, "stopped", files);
      this.onEvent({ slug, status: "stopped", filePath: files[0], message: session.isVod ? "過去配信のダウンロードを停止しました。" : "再接続待ちを取り消し、録画を停止しました。", isVod: session.isVod });
    }
    return { ok: true };
  }

  stopAll(): void {
    for (const [sessionId, session] of this.active) {
      session.stopRequested = true;
      if (session.watchdogTimer) { clearInterval(session.watchdogTimer); session.watchdogTimer = null; }
      if (session.retryTimer) {
        clearTimeout(session.retryTimer);
        session.retryTimer = null;
      }
      if (session.child) {
        this.interruptChild(session, session.child);
      } else {
        this.active.delete(sessionId);
      }
    }
  }
}

export function listRecordingFiles(outputDirectory: string): RecordingFile[] {
  const directory = resolve(outputDirectory);
  if (!existsSync(directory)) return [];

  const supportedExtensions = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
  const files: RecordingFile[] = [];
  const scanDirectories = recordingLibraryDirectories(directory);

  for (const scanDirectory of scanDirectories) {
    let entries;
    try { entries = readdirSync(scanDirectory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(scanDirectory, entry.name);
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
  }

  return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

export function deleteRecordingFile(
  outputDirectory: string,
  inputPath: string,
  isFileActive: (filePath: string) => boolean
): { ok: true; name: string } {
  const directory = resolve(outputDirectory);
  const target = resolve(inputPath);
  const supportedExtensions = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);

  if (!isRecordingLibraryFileParent(directory, target)) {
    throw new Error("録画ファイルの場所が不正です。");
  }
  if (!supportedExtensions.has(extname(target).toLowerCase())) {
    throw new Error("削除できる録画ファイルではありません。");
  }

  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    throw new Error("録画ファイルが見つからないか、すでに削除されています。");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("通常の録画ファイル以外は削除できません。");
  }
  if (isFileActive(target)) {
    throw new Error("録画中・ダウンロード中のファイルは削除できません。先に処理を停止してください。");
  }

  unlinkSync(target);
  return { ok: true, name: basename(target) };
}

export function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const target = resolve(filePath);
  const root = resolve(directory);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
