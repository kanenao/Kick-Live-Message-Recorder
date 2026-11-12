import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isPathInsideDirectory } from "./recording";

const execFileAsync = promisify(execFile);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
const MAX_CHAT_RECORDS = 250_000;

export type CommentLogFile = {
  path: string;
  name: string;
  channelSlug: string;
  kind: "LIVE" | "VOD";
  size: number;
  modifiedAt: string;
};

export type CommentVideoFontFamily = "ms-pgothic" | "meiryo" | "yu-gothic" | "arial";
export type CommentVideoPosition = "scroll" | "top" | "bottom";

export type CommentVideoOptions = {
  videoPath: string;
  chatPath?: string;
  chatPaths?: string[];
  delaySeconds?: number;
  fontFamily?: CommentVideoFontFamily;
  fontSize?: number;
  displaySeconds?: number;
  speedPercent?: number;
  rowLimit?: number;
  collisionGap?: number;
  opacity?: number;
  quality?: "high" | "standard" | "compact";
  position?: CommentVideoPosition;
  showUsername?: boolean;
};

export type CommentVideoEvent = {
  status: "starting" | "encoding" | "completed" | "cancelled" | "error";
  percent: number;
  message: string;
  outputPath?: string;
  generatedComments?: number;
  skippedComments?: number;
};

type ParsedComment = {
  seconds: number;
  text: string;
  color: string;
};

type LaneState = {
  start: number;
  end: number;
  speed: number;
  width: number;
};

const COMMENT_FONT_FAMILIES: Record<CommentVideoFontFamily, string> = {
  "ms-pgothic": "ＭＳ Ｐゴシック",
  "meiryo": "Meiryo",
  "yu-gothic": "游ゴシック",
  "arial": "Arial"
};

function normalizeFontFamily(value: unknown): CommentVideoFontFamily {
  return value === "ms-pgothic" || value === "yu-gothic" || value === "arial"
    ? value
    : "meiryo";
}

function normalizeCommentVideoPosition(value: unknown): CommentVideoPosition {
  return value === "top" || value === "bottom" ? value : "scroll";
}

type VideoInfo = {
  width: number;
  height: number;
  duration: number;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function findTool(executable: "ffmpeg.exe" | "ffprobe.exe" | "ffmpeg" | "ffprobe"): string {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : process.cwd();
  const candidates = [
    join(resources, "tools", executable),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable),
    executable
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? executable;
}

function validateRegularFile(path: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(label + "が見つかりません。");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(label + "は通常のファイルではありません。");
  }
}

function allocateOutputPaths(directory: string, videoPath: string): { video: string; ass: string } {
  const outputDirectory = join(resolve(directory), "CommentVideos");
  mkdirSync(outputDirectory, { recursive: true });
  const baseName = basename(videoPath, extname(videoPath)).replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_");
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const tail = suffix === 1 ? "" : "_" + suffix;
    const base = join(outputDirectory, baseName + "_comments" + tail);
    const video = base + ".mp4";
    const ass = base + ".ass";
    if (!existsSync(video) && !existsSync(ass)) return { video, ass };
  }
  throw new Error("出力ファイル名を確保できませんでした。CommentVideosフォルダーを整理してください。");
}

function assTimestamp(seconds: number): string {
  const totalCentiseconds = Math.max(0, Math.floor(seconds * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return hour + ":" + String(minute).padStart(2, "0") + ":" +
    String(second).padStart(2, "0") + "." + String(centiseconds).padStart(2, "0");
}

function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const character of Array.from(text)) {
    const code = character.codePointAt(0) ?? 0;
    units += code <= 0x00ff ? 0.58 : code >= 0x1f000 ? 1.15 : 1;
  }
  return Math.max(fontSize, Math.ceil(units * fontSize));
}

function escapeAssText(value: string): string {
  return value
    .replace(/\[emote:\d+:([^\]]+)\]/g, "$1")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .trim()
    .slice(0, 500);
}

function colorToAss(value: string): string {
  const match = value.match(/^#?([0-9a-f]{6})$/i);
  const rgb = match?.[1] ?? "FFFFFF";
  const red = rgb.slice(0, 2);
  const green = rgb.slice(2, 4);
  const blue = rgb.slice(4, 6);
  return "&H" + blue.toUpperCase() + green.toUpperCase() + red.toUpperCase() + "&";
}

function escapeFilterPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

async function probeVideo(ffprobePath: string, videoPath: string): Promise<VideoInfo> {
  let stdout: string;
  try {
    const result = await execFileAsync(ffprobePath, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      videoPath
    ], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8"
    });
    stdout = result.stdout;
  } catch {
    throw new Error("動画情報を読み取れませんでした。録画ファイルが破損していないか確認してください。");
  }

  let payload: { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    throw new Error("ffprobeから動画情報を解析できませんでした。");
  }
  const stream = payload.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const duration = Number(payload.format?.duration);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
    !Number.isFinite(duration) || duration <= 0 || duration > 7 * 24 * 60 * 60) {
    throw new Error("動画の解像度または再生時間を取得できませんでした。");
  }
  return { width: Math.round(width), height: Math.round(height), duration };
}

function getEncoderOptions(encoderList: string, quality: "high" | "standard" | "compact"): string[] {
  const rates = {
    high: { crf: "19", bitrate: "8000k", mpeg4: "2" },
    standard: { crf: "23", bitrate: "5000k", mpeg4: "4" },
    compact: { crf: "27", bitrate: "3000k", mpeg4: "6" }
  }[quality];

  if (encoderList.includes("libx264")) {
    return ["-c:v", "libx264", "-preset", "medium", "-crf", rates.crf];
  }
  if (encoderList.includes("h264_mf")) {
    return ["-c:v", "h264_mf", "-b:v", rates.bitrate];
  }
  if (encoderList.includes("libopenh264")) {
    return ["-c:v", "libopenh264", "-b:v", rates.bitrate];
  }
  // LGPL版FFmpegでH.264 encoderが利用できない環境でも生成できる互換フォールバック。
  return ["-c:v", "mpeg4", "-q:v", rates.mpeg4];
}

async function getEncoderList(ffmpegPath: string): Promise<string> {
  try {
    const result = await execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    return result.stdout + result.stderr;
  } catch {
    throw new Error("FFmpegを起動できませんでした。アプリを再インストールしてください。");
  }
}

export function listCommentLogFiles(outputDirectory: string): CommentLogFile[] {
  const chatRoot = join(resolve(outputDirectory), "Chat");
  if (!existsSync(chatRoot)) return [];
  const files: CommentLogFile[] = [];

  for (const channelEntry of readdirSync(chatRoot, { withFileTypes: true })) {
    if (!channelEntry.isDirectory() || !/^[a-zA-Z0-9_-]{1,40}$/.test(channelEntry.name)) continue;
    const channelDirectory = join(chatRoot, channelEntry.name);
    for (const entry of readdirSync(channelDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".jsonl") continue;
      const fullPath = join(channelDirectory, entry.name);
      try {
        const stats = lstatSync(fullPath);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        files.push({
          path: fullPath,
          name: basename(entry.name),
          channelSlug: channelEntry.name,
          kind: /^VOD_/i.test(entry.name) ? "VOD" : "LIVE",
          size: stats.size,
          modifiedAt: stats.mtime.toISOString()
        });
      } catch {
        // 一覧取得中に削除されたファイルは無視する。
      }
    }
  }

  return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).slice(0, 1000);
}

async function* readLinesFromFiles(filePaths: string[], signal: AbortSignal): AsyncGenerator<string> {
  for (const filePath of filePaths) {
    if (signal.aborted) throw new Error("生成を停止しました。");
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    try {
      for await (const line of reader) {
        if (signal.aborted) throw new Error("生成を停止しました。");
        yield line;
      }
    } finally {
      reader.close();
    }
  }
}


export type CommentVideoPreviewResult = {
  width: number;
  height: number;
  durationSeconds: number;
  totalComments: number;
  malformedLines: number;
  outsideVideoCount: number;
  comments: Array<{ seconds: number; content: string; username: string; color: string }>;
};

/**
 * 選択された録画・コメントログを読み取り、実データを使った生成前プレビューを返す。
 * 動画やログファイルの作成・変更は行わない。
 */
export async function previewCommentVideo(
  input: unknown,
  outputDirectory: string,
  isFileActive: (filePath: string) => boolean = () => false
): Promise<CommentVideoPreviewResult> {
  if (!input || typeof input !== "object") throw new Error("動画とコメントファイルを選択してください。");
  const values = input as Partial<CommentVideoOptions>;
  if (typeof values.videoPath !== "string" || values.videoPath.length > 4096) {
    throw new Error("動画ファイルの指定が不正です。");
  }
  const requestedChatPaths: unknown[] = Array.isArray(values.chatPaths)
    ? values.chatPaths
    : typeof values.chatPath === "string" ? [values.chatPath] : [];
  if (requestedChatPaths.length === 0 || requestedChatPaths.length > 31 ||
    requestedChatPaths.some(path => typeof path !== "string" || path.length === 0 || path.length > 4096)) {
    throw new Error("コメントファイルは1～31件の範囲で選択してください。");
  }

  const root = resolve(outputDirectory);
  const videoPath = resolve(values.videoPath);
  const chatPaths = [...new Set(requestedChatPaths.map(path => resolve(path as string)))];
  if (!isPathInsideDirectory(videoPath, root) || !VIDEO_EXTENSIONS.has(extname(videoPath).toLowerCase())) {
    throw new Error("動画は録画ライブラリ内の対応形式を選択してください。");
  }
  const chatRoot = join(root, "Chat");
  if (chatPaths.some(path => !isPathInsideDirectory(path, chatRoot) || extname(path).toLowerCase() !== ".jsonl")) {
    throw new Error("コメントファイルはアプリのChatフォルダー内にあるJSONLを選択してください。");
  }
  const chatDirectories = new Set(chatPaths.map(path => resolve(dirname(path))));
  const firstChatPath = chatPaths[0];
  const channelDirectory = firstChatPath ? dirname(firstChatPath) : "";
  if (chatDirectories.size !== 1 || !channelDirectory ||
    resolve(dirname(channelDirectory)) !== resolve(chatRoot) ||
    !/^[a-zA-Z0-9_-]{1,40}$/.test(basename(channelDirectory))) {
    throw new Error("複数選択する場合は、同じチャンネルフォルダー内のコメントログを選択してください。");
  }
  const chatKinds = new Set(chatPaths.map(path => /^VOD_/i.test(basename(path)) ? "VOD" : "LIVE"));
  if (chatKinds.size !== 1 || (chatKinds.has("VOD") && chatPaths.length > 1)) {
    throw new Error("LIVEログとVODログは混在できません。VODログは1ファイルずつ選択してください。");
  }

  validateRegularFile(videoPath, "動画ファイル");
  for (const chatPath of chatPaths) validateRegularFile(chatPath, "コメントファイル");
  if (isFileActive(videoPath)) {
    throw new Error("録画中・ダウンロード中の動画はプレビューできません。録画を停止して完了後に再度実行してください。");
  }

  const ffprobePath = findTool(process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const info = await probeVideo(ffprobePath, videoPath);
  const videoStats = statSync(videoPath);
  const filenameTimestamp = basename(videoPath, extname(videoPath)).match(/_(\d{8})_(\d{6})(?:_retry\d+)?$/);
  const filenameStartMs = filenameTimestamp
    ? (() => {
        const stamp = filenameTimestamp[1] + filenameTimestamp[2];
        const year = Number(stamp.slice(0, 4));
        const month = Number(stamp.slice(4, 6)) - 1;
        const day = Number(stamp.slice(6, 8));
        const hour = Number(stamp.slice(8, 10));
        const minute = Number(stamp.slice(10, 12));
        const second = Number(stamp.slice(12, 14));
        const parsed = new Date(year, month, day, hour, minute, second);
        return parsed.getFullYear() === year && parsed.getMonth() === month &&
          parsed.getDate() === day && parsed.getHours() === hour &&
          parsed.getMinutes() === minute && parsed.getSeconds() === second
          ? parsed.getTime()
          : Number.NaN;
      })()
    : Number.NaN;
  const estimatedVideoStartMs = Number.isFinite(filenameStartMs)
    ? filenameStartMs
    : videoStats.mtimeMs - info.duration * 1000;
  const delaySeconds = boundedNumber(values.delaySeconds, 0, -300, 300);
  const previewCandidates: Array<{ seconds: number; content: string; username: string; color: string }> = [];
  let malformedLines = 0;
  let outsideVideoCount = 0;
  let readCount = 0;
  const controller = new AbortController();

  for await (const line of readLinesFromFiles(chatPaths, controller.signal)) {
    if (!line.trim()) continue;
    readCount += 1;
    if (readCount > MAX_CHAT_RECORDS) {
      throw new Error("コメントが25万件を超えています。対象ログを日付別に分けてください。");
    }

    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      malformedLines += 1;
      continue;
    }

    const content = readString(raw.content) ?? readString(raw.message) ?? "";
    if (!content) continue;
    let seconds: number;
    if (typeof raw.timeInSeconds === "number" && Number.isFinite(raw.timeInSeconds)) {
      seconds = raw.timeInSeconds;
    } else {
      const createdAt = readString(raw.createdAt) ?? readString(raw.created_at);
      const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
      if (!Number.isFinite(createdMs)) continue;
      seconds = (createdMs - estimatedVideoStartMs) / 1000;
    }

    seconds += delaySeconds;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > info.duration) {
      outsideVideoCount += 1;
      continue;
    }

    const username = readString(raw.senderUsername) ?? readString(raw.username) ?? "";
    const cleanContent = content
      .replace(/\[emote:\d+:([^\]]+)\]/g, "$1")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim()
      .slice(0, 500);
    if (!cleanContent) continue;
    previewCandidates.push({
      seconds,
      content: cleanContent,
      username: username.slice(0, 80),
      color: readString(raw.usernameColor) ?? readString(raw.color) ?? "#ffffff"
    });
  }

  previewCandidates.sort((a, b) => a.seconds - b.seconds);
  const sampleSize = Math.min(24, previewCandidates.length);
  const comments = Array.from({ length: sampleSize }, (_, index) => {
    const sourceIndex = sampleSize <= 1
      ? 0
      : Math.round(index * (previewCandidates.length - 1) / (sampleSize - 1));
    return previewCandidates[sourceIndex];
  });

  return {
    width: info.width,
    height: info.height,
    durationSeconds: info.duration,
    totalComments: previewCandidates.length,
    malformedLines,
    outsideVideoCount,
    comments
  };
}

export class KickCommentVideoGenerator {
  private child: ChildProcessWithoutNullStreams | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly onEvent: (event: CommentVideoEvent) => void) {}

  isRunning(): boolean {
    return this.controller !== null;
  }

  start(
    input: unknown,
    outputDirectory: string,
    isFileActive: (filePath: string) => boolean
  ): { ok: true; outputPath: string } {
    if (this.controller) throw new Error("別のコメント付き動画を生成中です。完了または停止してから開始してください。");
    if (!input || typeof input !== "object") throw new Error("動画とコメントファイルを選択してください。");

    const values = input as Partial<CommentVideoOptions>;
    if (typeof values.videoPath !== "string" || values.videoPath.length > 4096) {
      throw new Error("動画ファイルの指定が不正です。");
    }
    const requestedChatPaths: unknown[] = Array.isArray(values.chatPaths)
      ? values.chatPaths
      : typeof values.chatPath === "string" ? [values.chatPath] : [];
    if (requestedChatPaths.length === 0 || requestedChatPaths.length > 31 ||
      requestedChatPaths.some(path => typeof path !== "string" || path.length === 0 || path.length > 4096)) {
      throw new Error("コメントファイルは1～31件の範囲で選択してください。");
    }

    const root = resolve(outputDirectory);
    const videoPath = resolve(values.videoPath);
    const chatPaths = [...new Set(requestedChatPaths.map(path => resolve(path as string)))];
    if (!isPathInsideDirectory(videoPath, root) || !VIDEO_EXTENSIONS.has(extname(videoPath).toLowerCase())) {
      throw new Error("動画は録画ライブラリ内の対応形式を選択してください。");
    }
    const chatRoot = join(root, "Chat");
    if (chatPaths.some(path => !isPathInsideDirectory(path, chatRoot) || extname(path).toLowerCase() !== ".jsonl")) {
      throw new Error("コメントファイルはアプリのChatフォルダー内にあるJSONLを選択してください。");
    }
    const chatDirectories = new Set(chatPaths.map(path => resolve(dirname(path))));
    const firstChatPath = chatPaths[0];
    const channelDirectory = firstChatPath ? dirname(firstChatPath) : "";
    if (chatDirectories.size !== 1 || !channelDirectory ||
      resolve(dirname(channelDirectory)) !== resolve(chatRoot) ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(basename(channelDirectory))) {
      throw new Error("複数選択する場合は、同じチャンネルフォルダー内のコメントログを選択してください。");
    }
    const chatKinds = new Set(chatPaths.map(path => /^VOD_/i.test(basename(path)) ? "VOD" : "LIVE"));
    if (chatKinds.size !== 1 || (chatKinds.has("VOD") && chatPaths.length > 1)) {
      throw new Error("LIVEログとVODログは混在できません。VODログは1ファイルずつ生成してください。");
    }
    validateRegularFile(videoPath, "動画ファイル");
    for (const chatPath of chatPaths) validateRegularFile(chatPath, "コメントファイル");
    if (isFileActive(videoPath)) {
      throw new Error("録画中・ダウンロード中の動画は生成元にできません。録画を停止して完了後に再度実行してください。");
    }

    const output = allocateOutputPaths(root, videoPath);
    const options: Required<Omit<CommentVideoOptions, "videoPath" | "chatPath" | "chatPaths">> & { videoPath: string; chatPaths: string[] } = {
      videoPath,
      chatPaths,
      delaySeconds: boundedNumber(values.delaySeconds, 0, -300, 300),
      fontFamily: normalizeFontFamily(values.fontFamily),
      fontSize: boundedNumber(values.fontSize, 48, 16, 80),
      displaySeconds: boundedNumber(values.displaySeconds, 6, 2, 15),
      speedPercent: boundedNumber(values.speedPercent, 100, 50, 200),
      rowLimit: Math.round(boundedNumber(values.rowLimit, 12, 1, 20)),
      collisionGap: boundedNumber(values.collisionGap, 48, 0, 200),
      opacity: boundedNumber(values.opacity, 92, 20, 100),
      quality: values.quality === "high" || values.quality === "compact" ? values.quality : "standard",
      position: normalizeCommentVideoPosition(values.position),
      showUsername: values.showUsername === true
    };

    const controller = new AbortController();
    this.controller = controller;
    this.onEvent({
      status: "starting",
      percent: 0,
      outputPath: output.video,
      message: "動画とコメントの情報を確認しています。"
    });

    void this.run(options, output, controller.signal).catch(error => {
      const cancelled = controller.signal.aborted;
      const detail = error instanceof Error ? error.message : String(error);
      this.onEvent({
        status: cancelled ? "cancelled" : "error",
        percent: 0,
        outputPath: output.video,
        message: cancelled ? "コメント付き動画の生成を停止しました。" : detail
      });
    }).finally(() => {
      if (this.controller === controller) {
        this.controller = null;
        this.child = null;
      }
    });

    return { ok: true, outputPath: output.video };
  }

  stop(): { ok: true } {
    if (!this.controller) throw new Error("コメント付き動画を生成していません。");
    this.controller.abort();
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { this.child.kill(); }
    }
    return { ok: true };
  }

  stopAll(): void {
    if (!this.controller) return;
    this.controller.abort();
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { this.child.kill(); }
    }
  }

  private async run(
    options: Required<Omit<CommentVideoOptions, "videoPath" | "chatPath" | "chatPaths">> & { videoPath: string; chatPaths: string[] },
    output: { video: string; ass: string },
    signal: AbortSignal
  ): Promise<void> {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "kick-comment-video-"));
    try {
      const ffmpegPath = findTool(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
      const ffprobePath = findTool(process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
      const info = await probeVideo(ffprobePath, options.videoPath);
      if (signal.aborted) throw new Error("生成を停止しました。");

      const videoStats = statSync(options.videoPath);
      // 録画ファイル名には録画開始時刻（YYYYMMDD_HHMMSS）が含まれるため、まずそれを使う。
      // 手動で名称変更した動画などは、ファイル更新時刻から再生時間を差し引いて推定する。
      // VODコメントは取得時に保存したtimeInSecondsを優先する。
      const filenameTimestamp = basename(options.videoPath, extname(options.videoPath))
        .match(/_(\d{8})_(\d{6})(?:_retry\d+)?$/);
      const filenameStartMs = filenameTimestamp
        ? (() => {
            const stamp = filenameTimestamp[1] + filenameTimestamp[2];
            const year = Number(stamp.slice(0, 4));
            const month = Number(stamp.slice(4, 6)) - 1;
            const day = Number(stamp.slice(6, 8));
            const hour = Number(stamp.slice(8, 10));
            const minute = Number(stamp.slice(10, 12));
            const second = Number(stamp.slice(12, 14));
            const parsed = new Date(year, month, day, hour, minute, second);
            return parsed.getFullYear() === year && parsed.getMonth() === month &&
              parsed.getDate() === day && parsed.getHours() === hour &&
              parsed.getMinutes() === minute && parsed.getSeconds() === second
              ? parsed.getTime()
              : Number.NaN;
          })()
        : Number.NaN;
      const estimatedVideoStartMs = Number.isFinite(filenameStartMs)
        ? filenameStartMs
        : videoStats.mtimeMs - info.duration * 1000;
      const comments: ParsedComment[] = [];
      let readCount = 0;
      let malformedCount = 0;

      for await (const line of readLinesFromFiles(options.chatPaths, signal)) {
        if (signal.aborted) throw new Error("生成を停止しました。");
        if (!line.trim()) continue;
        readCount += 1;
        if (readCount > MAX_CHAT_RECORDS) {
          throw new Error("コメントが25万件を超えています。対象ログを日付別に分けてください。");
        }

        let raw: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line) as unknown;
          raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        } catch {
          malformedCount += 1;
          continue;
        }

        const content = readString(raw.content) ?? readString(raw.message) ?? "";
        if (!content) continue;
        let seconds: number;
        if (typeof raw.timeInSeconds === "number" && Number.isFinite(raw.timeInSeconds)) {
          seconds = raw.timeInSeconds;
        } else {
          const createdAt = readString(raw.createdAt) ?? readString(raw.created_at);
          const createdMs = createdAt ? Date.parse(createdAt) : NaN;
          if (!Number.isFinite(createdMs)) continue;
          seconds = (createdMs - estimatedVideoStartMs) / 1000;
        }

        seconds += options.delaySeconds;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > info.duration) continue;

        const username = readString(raw.senderUsername) ?? readString(raw.username) ?? "";
        const text = escapeAssText(options.showUsername && username ? username + " : " + content : content);
        if (!text) continue;
        comments.push({
          seconds,
          text,
          color: readString(raw.usernameColor) ?? readString(raw.color) ?? ""
        });

        if (readCount % 10_000 === 0) {
          this.onEvent({
            status: "starting",
            percent: 8,
            outputPath: output.video,
            message: "コメントを読み込んでいます：" + readCount.toLocaleString("ja-JP") + "行"
          });
        }
      }

      if (signal.aborted) throw new Error("生成を停止しました。");
      if (comments.length === 0) {
        throw new Error("選択したコメントファイルに、この動画の再生時間内で表示できるコメントがありません。LIVE録画と同じ日のログ、または対応するVODコメントを選択してください。");
      }
      comments.sort((a, b) => a.seconds - b.seconds);

      const header = [
        "[Script Info]",
        "Title: Kick Live Message Recorder - Comments",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "PlayResX: " + info.width,
        "PlayResY: " + info.height,
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default," + COMMENT_FONT_FAMILIES[options.fontFamily] + "," + options.fontSize + ",&H00FFFFFF,&H000000FF,&H80000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,7,14,14,14,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
      ].join("\n") + "\n";
      writeFileSync(output.ass, header, "utf8");

      const lineHeight = Math.max(options.fontSize + 12, Math.round(options.fontSize * 1.55));
      const moveDuration = options.displaySeconds * 100 / options.speedPercent;
      const topMargin = Math.max(12, Math.round(info.height * 0.012));
      const usableHeight = Math.max(1, info.height - topMargin * 2 - options.fontSize);
      const visibleRows = Math.max(1, Math.floor(usableHeight / lineHeight) + 1);
      const laneCount = Math.min(options.rowLimit, visibleRows);
      const laneSpacing = laneCount > 1 ? usableHeight / (laneCount - 1) : 0;
      const lanes: Array<LaneState | null> = Array.from({ length: laneCount }, () => null);

      // Saccubusのue/shita/naka配置を参考に、固定表示と横スクロールを選べるようにする。
      // 上下固定は同じ行の表示時間を管理し、表示中コメントが同じ位置で重ならないようにする。
      const fixedAreaHeight = Math.max(lineHeight, Math.round(info.height * 0.28));
      const fixedLaneStep = lineHeight + options.collisionGap;
      const fixedLaneCount = Math.max(1, Math.min(
        options.rowLimit,
        Math.floor((fixedAreaHeight + options.collisionGap) / Math.max(1, fixedLaneStep))
      ));
      const fixedLaneEnds: Array<number | null> = Array.from({ length: fixedLaneCount }, () => null);

      // 同じコメント群を再生成しても配置が安定する、再現可能な疑似乱数。
      let laneRandomState = 0x12345678;
      const nextLaneStart = (): number => {
        laneRandomState = (laneRandomState + 0x6D2B79F5) >>> 0;
        let value = laneRandomState;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) % lanes.length;
      };
      let generated = 0;
      let skipped = 0;
      let batch: string[] = [];

      for (const comment of comments) {
        if (signal.aborted) throw new Error("生成を停止しました。");
        const width = estimateTextWidth(comment.text, options.fontSize) + 32;
        let laneIndex = -1;
        const isScrolling = options.position === "scroll";
        const start = comment.seconds;

        if (isScrolling) {
          const speed = (info.width + width) / moveDuration;
          const laneStart = nextLaneStart();
          for (let offset = 0; offset < lanes.length; offset += 1) {
            // 横スクロールは文字幅・速度差・時間差・指定間隔を調べ、衝突しない行だけを再利用。
            const index = (laneStart + offset) % lanes.length;
            const previous = lanes[index];
            if (!previous || comment.seconds >= previous.end) {
              laneIndex = index;
              break;
            }
            const overlap = Math.max(0, Math.min(moveDuration, previous.end - comment.seconds));
            const gapNeeded = options.collisionGap +
              Math.max(0, speed - previous.speed) * overlap;
            const currentGap = previous.speed * Math.max(0, comment.seconds - previous.start) - width;
            if (currentGap >= gapNeeded) {
              laneIndex = index;
              break;
            }
          }

          if (laneIndex >= 0) {
            const end = Math.min(info.duration, start + moveDuration);
            lanes[laneIndex] = { start, end, speed, width };
          }
        } else {
          // 上・下固定は同一行の表示終了時刻を管理。空いている行を優先する。
          for (let index = 0; index < fixedLaneEnds.length; index += 1) {
            const previousEnd = fixedLaneEnds[index];
            if (previousEnd === null || start >= previousEnd) {
              laneIndex = index;
              break;
            }
          }
          if (laneIndex >= 0) {
            fixedLaneEnds[laneIndex] = Math.min(info.duration, start + options.displaySeconds);
          }
        }

        if (laneIndex < 0) {
          skipped += 1;
          continue;
        }

        const end = Math.min(info.duration, start + (isScrolling ? moveDuration : options.displaySeconds));
        const color = colorToAss(comment.color);
        const alpha = Math.round((100 - options.opacity) * 2.55).toString(16).padStart(2, "0").toUpperCase();
        let tags: string;

        if (isScrolling) {
          const y = Math.round(topMargin + laneIndex * laneSpacing);
          tags = "{\\move(" + (info.width + 16) + "," + y + "," + Math.round(-width) + "," + y +
            ",0," + Math.max(1, Math.round(moveDuration * 1000)) + ")" +
            "\\fn" + COMMENT_FONT_FAMILIES[options.fontFamily] + "\\b1\\1c" + color +
            "\\alpha&H" + alpha + "&\\bord2.5\\shad1}";
        } else {
          const y = options.position === "top"
            ? topMargin + laneIndex * fixedLaneStep
            : info.height - topMargin - laneIndex * fixedLaneStep;
          const alignment = options.position === "top" ? "\\an8" : "\\an2";
          // 固定表示でも長文が左右にはみ出さないよう、横幅に合わせて縮小する。
          const maxPinnedWidth = info.width * 0.88;
          const horizontalScale = Math.max(5, Math.min(100, Math.floor(maxPinnedWidth / Math.max(1, width) * 100)));
          tags = "{" + alignment + "\\pos(" + Math.round(info.width / 2) + "," + y + ")" +
            "\\fn" + COMMENT_FONT_FAMILIES[options.fontFamily] + "\\b1\\1c" + color +
            (horizontalScale < 100 ? "\\fscx" + horizontalScale : "") +
            "\\alpha&H" + alpha + "&\\bord2.5\\shad1}";
        }

        batch.push(
          "Dialogue: 0," + assTimestamp(start) + "," + assTimestamp(end) +
          ",Default,,0,0,0,," + tags + comment.text
        );
        generated += 1;
        if (batch.length >= 1500) {
          appendFileSync(output.ass, batch.join("\n") + "\n", "utf8");
          batch = [];
        }
      }

      if (batch.length > 0) appendFileSync(output.ass, batch.join("\n") + "\n", "utf8");
      const totalSkipped = skipped + malformedCount;
      if (generated === 0) throw new Error("表示できるコメントがありません。行数設定を増やすか、コメントの同期ずれを調整してください。");

      this.onEvent({
        status: "encoding",
        percent: 18,
        outputPath: output.video,
        generatedComments: generated,
        skippedComments: totalSkipped,
        message: "コメント" + generated.toLocaleString("ja-JP") + "件を字幕化しました。動画へ合成しています。"
      });

      const encoders = await getEncoderList(ffmpegPath);
      const videoEncoderOptions = getEncoderOptions(encoders, options.quality);
      const escapedAssPath = escapeFilterPath(output.ass);
      const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", options.videoPath,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", "ass=filename='" + escapedAssPath + "'",
        ...videoEncoderOptions,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        output.video
      ];

      if (signal.aborted) throw new Error("生成を停止しました。");
      const child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      let progressBuffer = "";
      let stderrTail = "";
      let lastPercent = 18;

      child.stdout.on("data", (chunk: Buffer | string) => {
        progressBuffer += String(chunk);
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const separator = line.indexOf("=");
          if (separator < 0) continue;
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1);
          if (key !== "out_time_ms" && key !== "out_time_us") continue;
          const microseconds = Number(value);
          if (!Number.isFinite(microseconds)) continue;
          const elapsed = microseconds / 1_000_000;
          const percent = Math.max(18, Math.min(97, 18 + (elapsed / info.duration) * 79));
          const rounded = Math.floor(percent);
          if (rounded > lastPercent) {
            lastPercent = rounded;
            this.onEvent({
              status: "encoding",
              percent: rounded,
              outputPath: output.video,
              generatedComments: generated,
              skippedComments: totalSkipped,
              message: "コメント付き動画をエンコード中：" + rounded + "%"
            });
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + String(chunk)).slice(-6000);
      });

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolveExit => {
        let settled = false;
        const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void => {
          if (settled) return;
          settled = true;
          resolveExit(result);
        };
        child.once("error", error => finish({ code: null, signal: null, error }));
        child.once("close", (code, closeSignal) => finish({ code, signal: closeSignal }));
      });

      this.child = null;
      if (signal.aborted) throw new Error("生成を停止しました。");
      if (exit.error) throw new Error("FFmpegを起動できませんでした：" + exit.error.message);
      if (exit.code !== 0) {
        const detail = stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" ");
        throw new Error(detail || "FFmpegのエンコードに失敗しました（終了コード：" + String(exit.code) + "）。");
      }
      const outputStats = statSync(output.video);
      if (!outputStats.isFile() || outputStats.size < 1024) {
        throw new Error("生成された動画ファイルが空、または不完全です。");
      }

      this.onEvent({
        status: "completed",
        percent: 100,
        outputPath: output.video,
        generatedComments: generated,
        skippedComments: totalSkipped,
        message: "コメント付き動画を生成しました。コメント表示：" + generated.toLocaleString("ja-JP") +
          "件、不正行・行不足等で省略：" + totalSkipped.toLocaleString("ja-JP") +
          "件。保存先：CommentVideos"
      });
    } catch (error) {
      rmSync(output.video, { force: true });
      rmSync(output.ass, { force: true });
      throw error;
    } finally {
      this.child = null;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
