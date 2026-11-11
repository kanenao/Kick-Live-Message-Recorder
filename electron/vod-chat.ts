import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
type JsonRecord = Record<string, unknown>;

export type VodChatMessage = {
  eventId: string;
  messageId: string;
  channelSlug: string;
  broadcasterUserId: number | null;
  senderUsername: string;
  senderUserId: number | null;
  content: string;
  createdAt: string;
  receivedAt: string;
  usernameColor: string | null;
  badges: string[];
  emotes: Array<{ emoteId: string; positions: Array<{ start: number; end: number }> }>;
  replyToMessageId: string | null;
  videoId: string;
  timeInSeconds: number;
  timeText: string;
};

export type VodChatEvent = {
  status: "starting" | "progress" | "completed" | "stopped" | "error";
  slug: string;
  videoId: string;
  pages: number;
  messageCount: number;
  message: string;
  filePaths?: string[];
};

type VodIdentity = {
  slug: string;
  videoId: string;
  url: string;
};

type VodMetadata = {
  channelId: string;
  title: string;
  startAt: Date;
  durationSeconds: number;
};

class KickHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "KickHttpError";
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveId(value: unknown): number | null {
  const id = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getCurlExecutable(): string {
  if (process.platform === "win32") {
    const windowsCurl = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");
    if (existsSync(windowsCurl)) return windowsCurl;
    return "curl.exe";
  }
  return "curl";
}

function parseVodUrl(value: unknown): VodIdentity {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Kickの過去配信URLを入力してください。");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Kickの過去配信URLが正しくありません。");
  }
  if (
    parsed.protocol !== "https:" ||
    !["kick.com", "www.kick.com"].includes(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("https://kick.com/チャンネル/videos/動画ID のURLを入力してください。");
  }
  const match = parsed.pathname.match(/^\/([a-zA-Z0-9_-]{1,40})\/videos\/([a-f0-9-]{36})\/?$/i);
  if (!match) {
    throw new Error("VOD URLの形式が正しくありません。KickのVideosページからURLをコピーしてください。");
  }
  return {
    slug: match[1].toLowerCase(),
    videoId: match[2].toLowerCase(),
    url: "https://kick.com/" + match[1] + "/videos/" + match[2]
  };
}

async function requestJson(
  url: string,
  signal: AbortSignal
): Promise<{ status: number; payload: JsonRecord }> {
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--compressed",
    "--connect-timeout", "15",
    "--max-time", "35",
    "--write-out", "\n__KICK_HTTP_STATUS__:%{http_code}",
    "--header", "Accept: application/json",
    "--header", "Origin: https://kick.com",
    "--header", "Referer: https://kick.com/",
    "--header", "Accept-Language: ja,en-US;q=0.9,en;q=0.8",
    "--header", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "--url", url
  ];

  let stdout: string;
  try {
    const result = await execFileAsync(getCurlExecutable(), args, {
      windowsHide: true,
      timeout: 40_000,
      maxBuffer: 20 * 1024 * 1024,
      signal
    });
    stdout = result.stdout;
  } catch (error) {
    if (signal.aborted) throw new Error("コメント取得を停止しました。");
    const detail = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") throw new Error("curl.exe が見つかりません。Windowsの標準curlが利用できるか確認してください。");
    throw new Error("Kickへの接続に失敗しました。ネットワークを確認してください。" + " (" + detail.slice(0, 160) + ")");
  }

  const statusMatch = stdout.match(/\n__KICK_HTTP_STATUS__:(\d{3})\s*$/);
  if (!statusMatch) throw new Error("KickからHTTP応答を確認できませんでした。");
  const status = Number(statusMatch[1]);
  const responseText = stdout.slice(0, statusMatch.index).trim();
  if (responseText.startsWith("<") || /cloudflare|attention required/i.test(responseText.slice(0, 1000))) {
    throw new Error("Kickが自動アクセスを制限したか、Cloudflareの確認画面を返しました。時間をおいて再試行してください。");
  }
  let payload: JsonRecord = {};
  if (responseText) {
    try {
      payload = asRecord(JSON.parse(responseText) as unknown);
    } catch {
      if (status >= 200 && status < 300) {
        throw new Error("KickからJSON形式ではない応答が返されました。");
      }
    }
  }
  if (status < 200 || status >= 300) {
    const detail = readString(payload.message) ?? readString(asRecord(payload.data).message);
    if (status === 429) throw new KickHttpError(status, "Kickからアクセス制限（HTTP 429）が返されました。少し時間をおいて再試行してください。");
    if (status === 403) throw new KickHttpError(status, "このVODは非公開・サブスク限定、またはアクセス制限されています（HTTP 403）。");
    if (status === 404) throw new KickHttpError(status, "指定したVODまたはチャンネルが見つかりません（HTTP 404）。");
    throw new KickHttpError(status, detail ? "Kick APIエラー（HTTP " + status + "）：" + detail : "Kick APIエラー（HTTP " + status + "）。");
  }
  return { status, payload };
}

async function requestJsonWithRetry(url: string, signal: AbortSignal): Promise<JsonRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal.aborted) throw new Error("コメント取得を停止しました。");
    try {
      return (await requestJson(url, signal)).payload;
    } catch (error) {
      lastError = error;
      const status = error instanceof KickHttpError ? error.status : 0;
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt >= 3 || signal.aborted) throw error;
      await delay(1000 * (attempt + 1), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseDate(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) throw new Error("VODの配信開始時刻を取得できませんでした。");
  const raw = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) ? raw + "Z" : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error("VODの配信開始時刻を解析できませんでした。");
  return date;
}

function toDurationSeconds(value: unknown, unit: "milliseconds" | "seconds"): number {
  const duration = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("VODの配信時間を取得できませんでした。");
  const seconds = unit === "milliseconds" ? duration / 1000 : duration;
  if (seconds <= 0 || seconds > 7 * 24 * 60 * 60) throw new Error("VODの配信時間が不正です。");
  return seconds;
}

async function fetchVodMetadata(identity: VodIdentity, signal: AbortSignal): Promise<VodMetadata> {
  let legacy: JsonRecord | null = null;
  try {
    legacy = await requestJsonWithRetry(
      "https://kick.com/api/v1/video/" + encodeURIComponent(identity.videoId),
      signal
    );
  } catch (error) {
    if (!(error instanceof KickHttpError) || error.status !== 404) throw error;
  }

  if (legacy) {
    const livestream = asRecord(legacy.livestream);
    const channel = asRecord(livestream.channel);
    const returnedId = readString(legacy.uuid);
    const returnedSlug = readString(channel.slug);
    if (returnedId && returnedId.toLowerCase() !== identity.videoId) {
      throw new Error("Kickから別のVOD情報が返されたため、安全のため中止しました。");
    }
    if (returnedSlug && returnedSlug.toLowerCase() !== identity.slug) {
      throw new Error("URLのチャンネル名とVODの配信者が一致しません。");
    }
    const channelId = readPositiveId(channel.id);
    if (!channelId) throw new Error("VODのチャンネルIDを取得できませんでした。");
    return {
      channelId: String(channelId),
      title: readString(livestream.session_title) ?? identity.slug,
      startAt: parseDate(livestream.start_time),
      durationSeconds: toDurationSeconds(livestream.duration, "milliseconds")
    };
  }

  // Kickの新しいWebサイト用メタデータAPI。旧APIが404の場合だけ使用する。
  const channelPayload = await requestJsonWithRetry(
    "https://kick.com/api/v2/channels/" + encodeURIComponent(identity.slug),
    signal
  );
  const channelId = readPositiveId(channelPayload.id);
  const returnedSlug = readString(channelPayload.slug);
  if (!channelId || returnedSlug?.toLowerCase() !== identity.slug) {
    throw new Error("Kickのチャンネル情報がURLと一致しません。");
  }

  const webPayload = await requestJsonWithRetry(
    "https://web.kick.com/api/v1/channels/" + channelId + "/videos/" + encodeURIComponent(identity.videoId),
    signal
  );
  const video = asRecord(webPayload.data);
  const owner = asRecord(video.channel);
  if (
    readString(video.id)?.toLowerCase() !== identity.videoId ||
    String(owner.id ?? "") !== String(channelId) ||
    readString(owner.slug)?.toLowerCase() !== identity.slug
  ) {
    throw new Error("KickのVOD情報が指定したチャンネル・動画と一致しません。");
  }
  if (video.status !== "public" || video.is_live !== false) {
    throw new Error("コメント取得の対象は公開済みの過去配信です。非公開・配信中の動画は取得できません。");
  }
  return {
    channelId: String(channelId),
    title: readString(video.title) ?? identity.slug,
    startAt: parseDate(video.start_time),
    durationSeconds: toDurationSeconds(video.duration, "seconds")
  };
}

function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map(value => String(value).padStart(2, "0")).join(":");
}

function normalizeMessage(
  rawValue: unknown,
  identity: VodIdentity,
  metadata: VodMetadata,
  receivedAt: string
): VodChatMessage | null {
  const raw = asRecord(rawValue);
  const messageId = raw.id === undefined || raw.id === null ? "" : String(raw.id);
  const createdAtRaw = readString(raw.created_at);
  const createdAtDate = createdAtRaw ? new Date(createdAtRaw) : null;
  if (!messageId || !createdAtDate || Number.isNaN(createdAtDate.getTime())) return null;

  const sender = asRecord(raw.sender);
  const userIdentity = asRecord(sender.identity);
  const metadataRecord = asRecord(raw.metadata);
  const originalMessage = asRecord(metadataRecord.original_message);
  const content = typeof raw.content === "string"
    ? raw.content
    : typeof raw.message === "string" ? raw.message : "";
  const username = readString(sender.username) ?? readString(sender.slug) ?? "unknown";
  const elapsed = (createdAtDate.getTime() - metadata.startAt.getTime()) / 1000;
  if (elapsed < 0 || elapsed > metadata.durationSeconds + 5) return null;

  const badges = Array.isArray(userIdentity.badges)
    ? userIdentity.badges.map(badge => {
        if (typeof badge === "string") return badge;
        return readString(asRecord(badge).text);
      }).filter((value): value is string => Boolean(value))
    : [];
  const emotes = [...content.matchAll(/\[emote:(\d+):[^\]]+\]/g)].map(match => ({
    emoteId: match[1],
    positions: [{ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length - 1 }]
  }));

  return {
    eventId: identity.slug + ":vod:" + identity.videoId + ":" + messageId,
    messageId,
    channelSlug: identity.slug,
    broadcasterUserId: Number(metadata.channelId),
    senderUsername: username,
    senderUserId: readPositiveId(sender.id),
    content,
    createdAt: createdAtDate.toISOString(),
    receivedAt,
    usernameColor: readString(userIdentity.color) ?? readString(userIdentity.username_color),
    badges,
    emotes,
    replyToMessageId: readString(originalMessage.id) ?? readString(raw.thread_parent_id),
    videoId: identity.videoId,
    timeInSeconds: Math.max(0, elapsed),
    timeText: formatOffset(elapsed)
  };
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

function getOutputPaths(directory: string, identity: VodIdentity): { jsonl: string; txt: string } {
  const channelDirectory = join(directory, "Chat", identity.slug);
  mkdirSync(channelDirectory, { recursive: true });
  const base = "VOD_" + identity.videoId + "_" + timestampForFilename(new Date());
  let name = base;
  let suffix = 1;
  while (existsSync(join(channelDirectory, name + ".jsonl")) || existsSync(join(channelDirectory, name + ".txt"))) {
    name = base + "_" + suffix++;
  }
  return {
    jsonl: join(channelDirectory, name + ".jsonl"),
    txt: join(channelDirectory, name + ".txt")
  };
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("コメント取得を停止しました。"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

export class KickVodChatDownloader {
  private controller: AbortController | null = null;

  constructor(private readonly onEvent: (event: VodChatEvent) => void) {}

  isRunning(): boolean {
    return this.controller !== null;
  }

  start(inputUrl: unknown, outputDirectory: string): { ok: true; outputDirectory: string } {
    if (this.controller) throw new Error("別の過去配信コメントを取得中です。完了または停止してから再度実行してください。");
    const identity = parseVodUrl(inputUrl);
    const directory = outputDirectory.trim();
    if (!directory) throw new Error("コメントの保存先が設定されていません。");
    const controller = new AbortController();
    this.controller = controller;
    this.onEvent({
      status: "starting",
      slug: identity.slug,
      videoId: identity.videoId,
      pages: 0,
      messageCount: 0,
      message: "VOD情報を確認し、過去コメントの取得を開始しています。"
    });

    void this.run(identity, directory, controller.signal).then(result => {
      this.onEvent({
        status: "completed",
        slug: identity.slug,
        videoId: identity.videoId,
        pages: result.pages,
        messageCount: result.messageCount,
        filePaths: [result.jsonlPath, result.txtPath],
        message: "過去コメントを取得しました（" + result.messageCount.toLocaleString("ja-JP") + "件）。JSONLとTXTを保存しました。"
      });
    }).catch(error => {
      const stopped = controller.signal.aborted;
      const detail = error instanceof Error ? error.message : String(error);
      this.onEvent({
        status: stopped ? "stopped" : "error",
        slug: identity.slug,
        videoId: identity.videoId,
        pages: 0,
        messageCount: 0,
        message: stopped ? "過去コメントの取得を停止しました。" : "過去コメントの取得に失敗しました：" + detail
      });
    }).finally(() => {
      if (this.controller === controller) this.controller = null;
    });

    return { ok: true, outputDirectory: directory };
  }

  stop(): { ok: true } {
    this.controller?.abort();
    return { ok: true };
  }

  stopAll(): void {
    this.controller?.abort();
  }

  private async run(
    identity: VodIdentity,
    outputDirectory: string,
    signal: AbortSignal
  ): Promise<{ pages: number; messageCount: number; jsonlPath: string; txtPath: string }> {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "kick-vod-chat-"));
    const pageFiles: string[] = [];
    let pages = 0;
    let rawCount = 0;
    let messageCount = 0;
    try {
      const metadata = await fetchVodMetadata(identity, signal);
      const receivedAt = new Date().toISOString();
      const startMs = metadata.startAt.getTime();
      const endMs = startMs + metadata.durationSeconds * 1000;
      let cursor = String(Math.floor(endMs * 1000) + 1_000_000);
      const requestedCursors = new Set<string>();
      const seenMessages = new Set<string>();
      const seenPages = new Set<string>();
      let reachedStart = false;
      const maxPages = 500;
      const maxRecords = 250_000;

      while (cursor) {
        if (signal.aborted) throw new Error("コメント取得を停止しました。");
        if (pages >= maxPages || rawCount >= maxRecords) {
          throw new Error("取得上限（500ページ／25万件）に達しました。全履歴を保証できないため、不完全な取得として中止しました。");
        }
        if (requestedCursors.has(cursor)) throw new Error("Kickのコメント履歴APIが同じページを繰り返したため、中止しました。");
        requestedCursors.add(cursor);
        const requestCursor = cursor;
        const endpoint = "https://kick.com/api/v2/channels/" + encodeURIComponent(metadata.channelId) +
          "/messages?cursor=" + encodeURIComponent(cursor);
        const payload = await requestJsonWithRetry(endpoint, signal);
        const data = asRecord(payload.data);
        if (!Array.isArray(data.messages)) throw new Error("Kickのコメント履歴APIにメッセージ一覧がありません。");
        const rawMessages = data.messages;
        const nextCursor = typeof data.cursor === "string" && data.cursor ? data.cursor : "";
        pages += 1;
        rawCount += rawMessages.length;
        if (rawCount > maxRecords) throw new Error("コメント数が取得上限の25万件を超えました。不完全な取得として中止しました。");

        if (nextCursor && /^\d+$/.test(requestCursor) && /^\d+$/.test(nextCursor)) {
          if (BigInt(nextCursor) >= BigInt(requestCursor)) {
            throw new Error("Kickのコメント履歴APIのページカーソルが正しく進まないため、中止しました。");
          }
        }
        const digest = createHash("sha256").update(JSON.stringify(rawMessages)).digest("hex");
        if (rawMessages.length > 0 && seenPages.has(digest)) {
          throw new Error("Kickのコメント履歴APIが重複ページを返したため、中止しました。");
        }
        if (rawMessages.length > 0) seenPages.add(digest);

        const normalized: Array<{ message: VodChatMessage; createdMs: number }> = [];
        let pageEarliest = Number.POSITIVE_INFINITY;
        for (const raw of rawMessages) {
          const record = asRecord(raw);
          const createdAt = readString(record.created_at);
          const timestamp = createdAt ? new Date(createdAt).getTime() : NaN;
          if (Number.isFinite(timestamp)) pageEarliest = Math.min(pageEarliest, timestamp);
          const message = normalizeMessage(raw, identity, metadata, receivedAt);
          if (!message) continue;
          const createdMs = Date.parse(message.createdAt);
          if (createdMs < startMs || createdMs > endMs) continue;
          const identityKey = message.messageId;
          if (seenMessages.has(identityKey)) continue;
          seenMessages.add(identityKey);
          normalized.push({ message, createdMs });
        }
        if (pageEarliest < startMs) reachedStart = true;
        normalized.sort((a, b) => a.createdMs - b.createdMs || a.message.messageId.localeCompare(b.message.messageId));
        if (normalized.length > 0) {
          const pagePath = join(temporaryDirectory, "page-" + String(pages).padStart(5, "0") + ".jsonl");
          writeFileSync(pagePath, normalized.map(item => JSON.stringify(item.message)).join("\n") + "\n", "utf8");
          pageFiles.push(pagePath);
          messageCount += normalized.length;
        }
        this.onEvent({
          status: "progress",
          slug: identity.slug,
          videoId: identity.videoId,
          pages,
          messageCount,
          message: "過去コメントを取得中：" + pages.toLocaleString("ja-JP") + "ページ、" + messageCount.toLocaleString("ja-JP") + "件"
        });

        if (!nextCursor || reachedStart) break;
        cursor = nextCursor;
        await delay(150, signal);
      }

      if (signal.aborted) throw new Error("コメント取得を停止しました。");
      const outputPaths = getOutputPaths(outputDirectory, identity);
      const jsonlTemp = join(temporaryDirectory, "result.jsonl");
      const txtTemp = join(temporaryDirectory, "result.txt");
      writeFileSync(jsonlTemp, "", "utf8");
      writeFileSync(txtTemp, [
        "Kick VOD コメント履歴",
        "チャンネル: " + identity.slug,
        "タイトル: " + metadata.title,
        "VOD URL: " + identity.url,
        "配信開始: " + metadata.startAt.toISOString(),
        "取得コメント数: " + messageCount.toLocaleString("ja-JP"),
        "時刻は配信開始からの経過時間です。",
        ""
      ].join("\n"), "utf8");

      let lastTimestamp = Number.NEGATIVE_INFINITY;
      for (const pagePath of [...pageFiles].reverse()) {
        if (signal.aborted) throw new Error("コメント取得を停止しました。");
        const lines = readFileSync(pagePath, "utf8").split(/\r?\n/).filter(Boolean);
        const jsonLines: string[] = [];
        const textLines: string[] = [];
        for (const line of lines) {
          const message = JSON.parse(line) as VodChatMessage;
          const timestamp = Date.parse(message.createdAt);
          if (timestamp < lastTimestamp) {
            throw new Error("Kickのコメント履歴ページの時刻順が不正でした。不完全なファイルを作らないため保存を中止しました。");
          }
          lastTimestamp = timestamp;
          jsonLines.push(JSON.stringify(message));
          const safeContent = message.content.replace(/[\r\n]+/g, " ");
          textLines.push("[" + message.timeText + "] " + message.senderUsername + ": " + safeContent);
        }
        if (jsonLines.length > 0) {
          appendFileSync(jsonlTemp, jsonLines.join("\n") + "\n", "utf8");
          appendFileSync(txtTemp, textLines.join("\n") + "\n", "utf8");
        }
      }

      if (signal.aborted) throw new Error("コメント取得を停止しました。");
      renameSync(jsonlTemp, outputPaths.jsonl);
      renameSync(txtTemp, outputPaths.txt);
      return {
        pages,
        messageCount,
        jsonlPath: outputPaths.jsonl,
        txtPath: outputPaths.txt
      };
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
