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
import { basename, extname, join, resolve } from "node:path";
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

export type CommentVideoOptions = {
  videoPath: string;
  chatPath: string;
  delaySeconds?: number;
  fontSize?: number;
  displaySeconds?: number;
  rowLimit?: number;
  opacity?: number;
  quality?: "high" | "standard" | "compact";
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
};

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
    if (typeof values.videoPath !== "string" || values.videoPath.length > 4096 ||
      typeof values.chatPath !== "string" || values.chatPath.length > 4096) {
      throw new Error("動画またはコメントファイルの指定が不正です。");
    }

    const root = resolve(outputDirectory);
    const videoPath = resolve(values.videoPath);
    const chatPath = resolve(values.chatPath);
    if (!isPathInsideDirectory(videoPath, root) || !VIDEO_EXTENSIONS.has(extname(videoPath).toLowerCase())) {
      throw new Error("動画は録画ライブラリ内の対応形式を選択してください。");
    }
    const chatRoot = join(root, "Chat");
    if (!isPathInsideDirectory(chatPath, chatRoot) || extname(chatPath).toLowerCase() !== ".jsonl") {
      throw new Error("コメントファイルはアプリのChatフォルダー内にあるJSONLを選択してください。");
    }
    validateRegularFile(videoPath, "動画ファイル");
    validateRegularFile(chatPath, "コメントファイル");
    if (isFileActive(videoPath)) {
      throw new Error("録画中・ダウンロード中の動画は生成元にできません。録画を停止して完了後に再度実行してください。");
    }

    const output = allocateOutputPaths(root, videoPath);
    const options: Required<Omit<CommentVideoOptions, "videoPath" | "chatPath">> & Pick<CommentVideoOptions, "videoPath" | "chatPath"> = {
      videoPath,
      chatPath,
      delaySeconds: boundedNumber(values.delaySeconds, 0, -300, 300),
      fontSize: boundedNumber(values.fontSize, 42, 16, 80),
      displaySeconds: boundedNumber(values.displaySeconds, 6, 2, 15),
      rowLimit: Math.round(boundedNumber(values.rowLimit, 8, 1, 20)),
      opacity: boundedNumber(values.opacity, 92, 20, 100),
      quality: values.quality === "high" || values.quality === "compact" ? values.quality : "standard",
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
    options: Required<Omit<CommentVideoOptions, "videoPath" | "chatPath">> & Pick<CommentVideoOptions, "videoPath" | "chatPath">,
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
      // LIVEコメントは動画ファイルの更新時刻から再生時間を差し引いて録画開始時刻を推定する。
      // VODコメントは取得時に保存したtimeInSecondsを優先するため、開始時刻推定に依存しない。
      const estimatedVideoStartMs = videoStats.mtimeMs - info.duration * 1000;
      const interfaceReader = createInterface({
        input: createReadStream(options.chatPath, { encoding: "utf8" }),
        crlfDelay: Infinity
      });
      const comments: ParsedComment[] = [];
      let readCount = 0;
      let malformedCount = 0;

      for await (const line of interfaceReader) {
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
        "Style: Default,Yu Gothic UI," + options.fontSize + ",&H00FFFFFF,&H000000FF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,7,14,14,14,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
      ].join("\n") + "\n";
      writeFileSync(output.ass, header, "utf8");

      const lanes: Array<LaneState | null> = Array.from({ length: options.rowLimit }, () => null);
      const lineHeight = Math.max(options.fontSize + 10, Math.round(options.fontSize * 1.48));
      const topMargin = Math.max(20, Math.round(info.height * 0.025));
      let generated = 0;
      let skipped = 0;
      let batch: string[] = [];

      for (const comment of comments) {
        if (signal.aborted) throw new Error("生成を停止しました。");
        const width = Math.min(info.width * 2, estimateTextWidth(comment.text, options.fontSize) + 24);
        const speed = (info.width + width) / options.displaySeconds;
        let laneIndex = -1;

        for (let index = 0; index < lanes.length; index += 1) {
          const previous = lanes[index];
          if (!previous || comment.seconds >= previous.end) {
            laneIndex = index;
            break;
          }
          const overlap = Math.max(0, Math.min(options.displaySeconds, previous.end - comment.seconds));
          const gapNeeded = Math.max(options.fontSize * 1.8, 42) +
            Math.max(0, speed - previous.speed) * overlap;
          const currentGap = previous.speed * Math.max(0, comment.seconds - previous.start);
          if (currentGap >= gapNeeded) {
            laneIndex = index;
            break;
          }
        }

        if (laneIndex < 0) {
          skipped += 1;
          continue;
        }

        const start = comment.seconds;
        const end = Math.min(info.duration, start + options.displaySeconds);
        lanes[laneIndex] = { start, end, speed };
        const y = topMargin + laneIndex * lineHeight;
        const color = colorToAss(comment.color);
        const alpha = Math.round((100 - options.opacity) * 2.55).toString(16).padStart(2, "0").toUpperCase();
        const tags = "{\\move(" + (info.width + 16) + "," + y + "," + Math.round(-width) + "," + y +
          ",0," + Math.max(1, Math.round((end - start) * 1000)) + ")" +
          "\\1c" + color + "\\alpha&H" + alpha + "&\\bord2\\shad1}";
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
      if (generated === 0) throw new Error("表示できるコメントがありません。行数設定を増やすか、コメントの同期ずれを調整してください。");

      this.onEvent({
        status: "encoding",
        percent: 18,
        outputPath: output.video,
        generatedComments: generated,
        skippedComments: skipped + malformedCount,
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
              skippedComments: skipped + malformedCount,
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
        skippedComments: skipped + malformedCount,
        message: "コメント付き動画を生成しました。コメント表示：" + generated.toLocaleString("ja-JP") +
          "件、重なり等で省略：" + skipped.toLocaleString("ja-JP") +
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
