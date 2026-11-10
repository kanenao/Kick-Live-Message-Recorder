import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export type RenderStatus = {
  status: "idle" | "preparing" | "rendering" | "completed" | "cancelled" | "error";
  message: string;
  progressPercent: number;
  commentCount: number;
  videoPath: string;
  outputPath: string;
  error?: string;
};

export type CommentRenderOptions = {
  videoPath: string;
  commentsPath: string;
  outputPath: string;
  ffmpegPath: string;
  fontSize: number;
  scrollDurationSeconds: number;
  includeUsername: boolean;
  respectPosition: boolean;
};

type ImportedComment = {
  time: number;
  text: string;
  user?: string;
  color?: string;
  position?: "scroll" | "top" | "bottom";
  duration?: number;
};

type MediaInfo = { width: number; height: number; duration?: number };

const MAX_COMMENT_FILE_BYTES = 80 * 1024 * 1024;
const MAX_COMMENTS = 100_000;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/gi, "&");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function parseClock(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = Number((match[4] ?? "0").padEnd(3, "0")) / 1000;
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function parseTimeValue(value: unknown, key: string): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (/vpos/i.test(key)) return value / 100;
    if (/(millis|milliseconds|_ms)$/i.test(key)) return value / 1000;
    if (value > 1_000_000_000) return null;
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return parseTimeValue(numeric, key);
  return parseClock(trimmed);
}

function firstValue(record: Record<string, unknown>, names: string[]): { value: unknown; key: string } | null {
  const entries = Object.entries(record);
  for (const name of names) {
    const entry = entries.find(([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== undefined && value !== null);
    if (entry) return { value: entry[1], key: entry[0] };
  }
  return null;
}

function normalizePosition(value: unknown): ImportedComment["position"] {
  const text = String(value ?? "").toLowerCase();
  if (/top|ue|上|nakaue/.test(text)) return "top";
  if (/bottom|shita|下/.test(text)) return "bottom";
  return "scroll";
}

function normalizeComment(record: Record<string, unknown>): ImportedComment | null {
  const timeValue = firstValue(record, [
    "vpos", "time", "offset", "seconds", "elapsed", "time_seconds", "timestamp_ms", "position", "timestamp"
  ]);
  if (!timeValue) return null;
  const time = parseTimeValue(timeValue.value, timeValue.key);
  const textValue = firstValue(record, ["text", "body", "comment", "message", "content", "value"]);
  const text = typeof textValue?.value === "string" || typeof textValue?.value === "number"
    ? String(textValue.value).trim()
    : "";
  if (time === null || time < 0 || !text) return null;
  const userValue = firstValue(record, ["user", "username", "author", "name", "nickname", "nick"]);
  const colorValue = firstValue(record, ["color", "colour", "font_color"]);
  const positionValue = firstValue(record, ["position_type", "position", "mail", "command", "mode"]);
  const durationValue = firstValue(record, ["duration", "display_duration"]);
  const duration = durationValue ? Number(durationValue.value) : undefined;
  return {
    time,
    text: text.replace(/\r/g, "").slice(0, 500),
    user: userValue ? String(userValue.value).slice(0, 80) : undefined,
    color: colorValue ? String(colorValue.value) : undefined,
    position: normalizePosition(positionValue?.value),
    duration: Number.isFinite(duration) && duration! > 0 ? Math.min(30, duration!) : undefined
  };
}

function parseJsonComments(source: string): ImportedComment[] {
  const parsed: unknown = JSON.parse(source);
  let records: unknown[] = [];
  if (Array.isArray(parsed)) records = parsed;
  else if (parsed && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    const collection = root.comments ?? root.data ?? root.messages ?? root.items ?? root.chat;
    if (Array.isArray(collection)) records = collection;
  }
  return records.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const normalized = normalizeComment(item as Record<string, unknown>);
    return normalized ? [normalized] : [];
  });
}

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' && quoted && source[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function parseDelimitedComments(source: string): ImportedComment[] {
  const rows = parseCsvRows(source.replace(/^\uFEFF/, ""));
  if (rows.length === 0) return [];
  const headerKeys = rows[0].map(value => value.trim().toLowerCase());
  const hasHeader = headerKeys.some(value => ["time", "vpos", "offset", "seconds", "timestamp", "text", "comment", "message"].includes(value));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (hasHeader) {
    return dataRows.flatMap(row => {
      const record: Record<string, unknown> = {};
      headerKeys.forEach((key, index) => { record[key] = row[index] ?? ""; });
      const normalized = normalizeComment(record);
      return normalized ? [normalized] : [];
    });
  }
  return dataRows.flatMap(row => {
    const timeText = row[0] ?? "";
    const user = row[1] ?? "";
    const normalized = normalizeComment({ time: timeText, user, text: row.slice(2).join(",") });
    return normalized ? [normalized] : [];
  });
}

function parseXmlComments(source: string): ImportedComment[] {
  const comments: ImportedComment[] = [];
  const pattern = /<(chat|comment|message|item)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && comments.length < MAX_COMMENTS) {
    const attributes: Record<string, unknown> = {};
    const attrPattern = /([a-zA-Z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(match[2])) !== null) {
      attributes[attr[1]] = decodeEntities(attr[3] ?? attr[4] ?? "");
    }
    const body = stripTags(match[3] ?? "");
    if (body && !attributes.text && !attributes.message) attributes.text = body;
    const normalized = normalizeComment(attributes);
    if (normalized) comments.push(normalized);
  }
  return comments;
}

function parseSrtComments(source: string): ImportedComment[] {
  const pattern = /(?:^|\r?\n)\s*(?:\d+\s*\r?\n)?(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\r?\n|$)/g;
  const comments: ImportedComment[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const time = parseClock(match[1]);
    const end = parseClock(match[2]);
    const text = stripTags(match[3].replace(/\r?\n/g, " "));
    if (time !== null && text) {
      comments.push({ time, text, duration: end !== null ? Math.max(1, Math.min(30, end - time)) : 5, position: "scroll" });
    }
    if (comments.length >= MAX_COMMENTS) break;
  }
  return comments;
}

function parseTextComments(source: string): ImportedComment[] {
  const comments: ImportedComment[] = [];
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const tabParts = line.split("\t");
    let normalized: ImportedComment | null = null;
    if (tabParts.length >= 3) {
      normalized = normalizeComment({ time: tabParts[0], user: tabParts[1], text: tabParts.slice(2).join("\t") });
    } else {
      const match = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s+(.+)$/);
      if (match) normalized = normalizeComment({ time: match[1], text: match[2] });
    }
    if (normalized) comments.push(normalized);
    if (comments.length >= MAX_COMMENTS) break;
  }
  return comments;
}

function countAssDialogue(source: string): number {
  return source.split(/\r?\n/).filter(line => /^Dialogue\s*:/i.test(line)).length;
}

function readCommentFile(filePath: string): { comments: ImportedComment[]; isAss: boolean; format: string } {
  if (!existsSync(filePath)) throw new Error("コメントファイルが見つかりません。");
  const size = statSync(filePath).size;
  if (size <= 0 || size > MAX_COMMENT_FILE_BYTES) throw new Error("コメントファイルは空、または80MBを超えています。");
  const extension = extname(filePath).toLowerCase();
  const source = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (extension === ".ass") {
    const count = countAssDialogue(source);
    if (count === 0) throw new Error("ASSファイル内にDialogue行がありません。");
    return { comments: Array.from({ length: count }, () => ({ time: 0, text: "" })), isAss: true, format: "ASS字幕" };
  }
  let comments: ImportedComment[];
  switch (extension) {
    case ".json": comments = parseJsonComments(source); break;
    case ".csv": comments = parseDelimitedComments(source); break;
    case ".xml": comments = parseXmlComments(source); break;
    case ".srt": comments = parseSrtComments(source); break;
    case ".txt": comments = parseTextComments(source); break;
    default: throw new Error("対応形式は JSON / CSV / XML / TXT / SRT / ASS です。");
  }
  if (comments.length === 0) throw new Error("有効なコメントを読み取れませんでした。時刻とコメント本文が入っているか確認してください。");
  return { comments: comments.slice(0, MAX_COMMENTS), isAss: false, format: extension.slice(1).toUpperCase() };
}

function assTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds * 100));
  const centiseconds = total % 100;
  const totalSeconds = Math.floor(total / 100);
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return String(hour) + ":" + String(minute).padStart(2, "0") + ":" +
    String(second).padStart(2, "0") + "." + String(centiseconds).padStart(2, "0");
}

function assEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}")
    .replace(/\r?\n/g, " ").replace(/\u0000/g, "");
}

function assColor(value?: string): string {
  const input = String(value ?? "").trim().toLowerCase();
  const names: Record<string, string> = {
    white: "#ffffff", black: "#ffffff", red: "#ff4444", pink: "#ff80c0",
    orange: "#ff9900", yellow: "#ffff55", green: "#55ff55", cyan: "#55ffff",
    blue: "#5599ff", purple: "#cc88ff"
  };
  const hex = names[input] ?? input;
  const match = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return "&H00FFFFFF&";
  const rgb = match[1];
  return ("&H00" + rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2) + "&").toUpperCase();
}

function approximateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    width += /[\u3000-\u9fff\uf900-\ufaff\u{1f000}-\u{1faff}]/u.test(char) ? fontSize : fontSize * 0.58;
  }
  return Math.max(fontSize, width);
}

function makeAss(comments: ImportedComment[], info: MediaInfo, options: CommentRenderOptions): string {
  const width = Math.max(320, info.width);
  const height = Math.max(240, info.height);
  const fontSize = Math.max(16, Math.round(options.fontSize * height / 1080));
  const lineHeight = Math.max(24, Math.round(fontSize * 1.35));
  const margin = Math.max(8, Math.round(height * 0.025));
  const travelBase = Math.max(5, Math.min(30, options.scrollDurationSeconds));
  const scrollLaneCount = Math.max(1, Math.floor(height * 0.68 / lineHeight));
  const fixedLaneCount = Math.max(1, Math.min(6, Math.floor(height * 0.18 / lineHeight)));
  const scrollFreeAt = Array.from({ length: scrollLaneCount }, () => 0);
  const topFreeAt = Array.from({ length: fixedLaneCount }, () => 0);
  const bottomFreeAt = Array.from({ length: fixedLaneCount }, () => 0);
  const events: string[] = [];

  for (const comment of [...comments].sort((a, b) => a.time - b.time)) {
    if (info.duration !== undefined && comment.time > info.duration + 1) continue;
    const text = options.includeUsername && comment.user ? comment.user + ": " + comment.text : comment.text;
    const safeText = assEscape(text).slice(0, 500);
    if (!safeText) continue;
    const position = options.respectPosition ? (comment.position ?? "scroll") : "scroll";
    const color = assColor(comment.color);
    const commentDuration = Math.max(1, Math.min(30, comment.duration ?? 4));

    if (position === "top" || position === "bottom") {
      const lanes = position === "top" ? topFreeAt : bottomFreeAt;
      let laneIndex = lanes.findIndex(freeAt => freeAt <= comment.time);
      if (laneIndex < 0) laneIndex = lanes.indexOf(Math.min(...lanes));
      const end = comment.time + commentDuration;
      lanes[laneIndex] = end + 0.25;
      const y = position === "top"
        ? margin + laneIndex * lineHeight
        : height - margin - (fixedLaneCount - laneIndex - 1) * lineHeight;
      const alignment = position === "top" ? "\\an8" : "\\an2";
      const effect = "{" + alignment + "\\pos(" + Math.round(width / 2) + "," + y + ")" +
        "\\fs" + fontSize + "\\bord2\\shad1\\1c" + color + "\\3c&H000000&}";
      events.push("Dialogue: 1," + assTime(comment.time) + "," + assTime(end) +
        ",Danmaku,,0,0,0,," + effect + safeText);
      continue;
    }

    const commentWidth = approximateTextWidth(text, fontSize);
    const duration = Math.max(4, travelBase * ((width + commentWidth + 40) / width));
    let laneIndex = scrollFreeAt.findIndex(freeAt => freeAt <= comment.time);
    if (laneIndex < 0) laneIndex = scrollFreeAt.indexOf(Math.min(...scrollFreeAt));
    scrollFreeAt[laneIndex] = comment.time + duration * 0.45 + 0.7;
    const y = margin + laneIndex * lineHeight;
    const move = "\\move(" + Math.round(width + 30) + "," + y + "," +
      Math.round(-commentWidth - 30) + "," + y + ",0," + Math.round(duration * 1000) + ")";
    const effect = "{" + move + "\\fs" + fontSize + "\\bord2\\shad1\\1c" + color + "\\3c&H000000&}";
    events.push("Dialogue: 0," + assTime(comment.time) + "," + assTime(comment.time + duration) +
      ",Danmaku,,0,0,0,," + effect + safeText);
  }

  return [
    "[Script Info]", "ScriptType: v4.00+", "WrapStyle: 2", "ScaledBorderAndShadow: yes",
    "PlayResX: " + width, "PlayResY: " + height, "YCbCr Matrix: TV.709", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Danmaku,Yu Gothic UI," + fontSize + ",&H00FFFFFF&,&H000000FF&,&H00000000&,&H64000000&,1,0,0,0,100,100,0,0,1,2,1,7,20,20,20,1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events
  ].join("\r\n");
}

function executableForProbe(ffmpegPath: string): string {
  const trimmed = ffmpegPath.trim();
  if (!trimmed) return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const probeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return join(dirname(resolve(trimmed)), probeName);
}

function captureProcess(executable: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("動画情報の取得がタイムアウトしました。"));
    }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); rejectPromise(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(stderr || "外部ツールが終了コード " + code + " で停止しました。"));
    });
  });
}

async function probeVideo(videoPath: string, ffmpegPath: string): Promise<MediaInfo> {
  try {
    const probe = await captureProcess(executableForProbe(ffmpegPath), [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json", videoPath
    ]);
    const payload = JSON.parse(probe) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = payload.streams?.[0];
    const duration = Number(payload.format?.duration);
    return {
      width: typeof stream?.width === "number" && stream.width > 0 ? stream.width : 1280,
      height: typeof stream?.height === "number" && stream.height > 0 ? stream.height : 720,
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined
    };
  } catch {
    return { width: 1280, height: 720 };
  }
}

export class CommentVideoRenderer {
  private child: ChildProcess | null = null;
  private status: RenderStatus = {
    status: "idle", message: "動画とコメントファイルを選択してください。",
    progressPercent: 0, commentCount: 0, videoPath: "", outputPath: ""
  };
  private temporaryAssPath = "";
  private cancelled = false;

  constructor(private readonly onUpdate: (status: RenderStatus) => void) {}

  getStatus(): RenderStatus { return { ...this.status }; }

  preview(commentsPath: string): { count: number; format: string; usesExistingAss: boolean } {
    const parsed = readCommentFile(commentsPath);
    return { count: parsed.comments.length, format: parsed.format, usesExistingAss: parsed.isAss };
  }

  async start(options: CommentRenderOptions): Promise<RenderStatus> {
    if (this.child) throw new Error("コメント付き動画の生成はすでに実行中です。");
    const videoPath = resolve(options.videoPath);
    const commentsPath = resolve(options.commentsPath);
    const outputPath = resolve(options.outputPath);
    if (!existsSync(videoPath) || !statSync(videoPath).isFile()) throw new Error("元動画ファイルが見つかりません。");
    if (!existsSync(commentsPath) || !statSync(commentsPath).isFile()) throw new Error("コメントファイルが見つかりません。");
    if (videoPath.toLowerCase() === outputPath.toLowerCase()) throw new Error("出力先に元動画と同じファイルは指定できません。");
    if (extname(outputPath).toLowerCase() !== ".mp4") throw new Error("出力ファイルの拡張子は .mp4 にしてください。");
    if (statSync(videoPath).size <= 0) throw new Error("元動画ファイルが空です。");
    const ffmpegPath = options.ffmpegPath.trim() || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if ((ffmpegPath.includes("/") || ffmpegPath.includes("\\")) && !existsSync(ffmpegPath)) {
      throw new Error("FFmpegが見つかりません。設定画面で ffmpeg.exe を指定してください。");
    }

    this.cancelled = false;
    this.status = {
      status: "preparing", message: "コメントを読み込み、動画情報を確認しています。",
      progressPercent: 0, commentCount: 0, videoPath, outputPath
    };
    this.publish();

    const parsed = readCommentFile(commentsPath);
    const info = await probeVideo(videoPath, ffmpegPath);
    if (this.cancelled) return this.getStatus();
    mkdirSync(dirname(outputPath), { recursive: true });

    const token = String(process.pid) + "_" + String(Date.now());
    this.temporaryAssPath = join(dirname(outputPath), "_klmr_comments_" + token + ".ass");
    if (parsed.isAss) copyFileSync(commentsPath, this.temporaryAssPath);
    else writeFileSync(this.temporaryAssPath, makeAss(parsed.comments, info, options), "utf8");

    const tempAssName = basename(this.temporaryAssPath);
    const args = [
      "-hide_banner", "-y", "-i", videoPath,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "ass=filename='" + tempAssName + "'",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-progress", "pipe:1", "-nostats",
      outputPath
    ];

    this.status = {
      status: "rendering", message: "コメントを重ねた動画を生成しています。",
      progressPercent: 0, commentCount: parsed.comments.length, videoPath, outputPath
    };
    this.publish();

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        let child: ChildProcess;
        try {
          child = spawn(ffmpegPath, args, {
            cwd: dirname(outputPath), windowsHide: true, shell: false,
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch (error) {
          rejectPromise(error);
          return;
        }
        this.child = child;
        let stderr = "";
        let outTimeSeconds = 0;
        child.stdout?.on("data", chunk => {
          const lines = chunk.toString("utf8").split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith("out_time_ms=")) {
              const microseconds = Number(line.slice("out_time_ms=".length));
              if (Number.isFinite(microseconds)) outTimeSeconds = microseconds / 1_000_000;
            } else if (line === "progress=end") {
              this.status.progressPercent = 100;
            }
          }
          if (info.duration) {
            this.status.progressPercent = Math.max(0, Math.min(99, Math.round(outTimeSeconds / info.duration * 100)));
          }
          this.status.message = "動画を再エンコードしています（" + this.status.progressPercent + "%）。";
          this.publish();
        });
        child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
        child.on("error", error => {
          this.child = null;
          rejectPromise(new Error("FFmpegを起動できませんでした：" + error.message));
        });
        child.on("close", code => {
          this.child = null;
          if (this.cancelled || code === 0) resolvePromise();
          else rejectPromise(new Error(stderr.trim().split(/\r?\n/).slice(-5).join("\n") || "FFmpegが終了コード " + code + " で停止しました。"));
        });
      });
      this.cleanupTemporaryAss();
      if (this.cancelled) {
        this.status = { ...this.status, status: "cancelled", message: "動画生成をキャンセルしました。", progressPercent: 0 };
      } else {
        this.status = { ...this.status, status: "completed", message: "コメント付き動画の生成が完了しました。", progressPercent: 100 };
      }
      this.publish();
      return this.getStatus();
    } catch (error) {
      this.cleanupTemporaryAss();
      this.status = {
        ...this.status, status: "error",
        message: "コメント付き動画の生成に失敗しました。",
        error: error instanceof Error ? error.message : String(error)
      };
      this.publish();
      throw error;
    }
  }

  cancel(): RenderStatus {
    if (!this.child) return this.getStatus();
    this.cancelled = true;
    this.status = { ...this.status, message: "動画生成をキャンセルしています。" };
    this.publish();
    this.child.kill();
    return this.getStatus();
  }

  private cleanupTemporaryAss(): void {
    if (this.temporaryAssPath && existsSync(this.temporaryAssPath)) {
      try { unlinkSync(this.temporaryAssPath); } catch { /* best-effort cleanup */ }
    }
    this.temporaryAssPath = "";
  }

  private publish(): void { this.onUpdate(this.getStatus()); }
}
