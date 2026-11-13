import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

export type KickChatMessage = {
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
};

export type ChatReceiverStatus = {
  running: boolean;
  connectedChannels: number;
  messageCount: number;
  lastMessageAt: string | null;
  message: string;
};

type JsonRecord = Record<string, unknown>;
type ResolvedChannel = { slug: string; chatroomId: number };
type RealtimeConnectionResponse = {
  data?: {
    connections?: Array<{
      provider?: string;
      credentials?: { url?: string };
    }>;
  };
};
type RealtimeTokenResponse = { data?: { token?: string } };

const execFileAsync = promisify(execFile);
function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
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

async function requestKickJson<T>(url: string, body?: JsonRecord, userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"): Promise<T> {
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--compressed",
    "--max-time", "20",
    "--write-out", "\n__KICK_HTTP_STATUS__:%{http_code}",
    "--header", "Accept: application/json",
    "--header", "Origin: https://kick.com",
    "--header", "Referer: https://kick.com/",
    "--header", "User-Agent: " + userAgent
  ];

  if (body) {
    args.push("--request", "POST", "--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  }

  args.push(url);

  let stdout: string;
  try {
    const result = await execFileAsync(getCurlExecutable(), args, {
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 4 * 1024 * 1024
    });
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("Kickへの接続に失敗しました。ネットワークまたはcurl.exeを確認してください。" + " (" + detail.slice(0, 180) + ")");
  }

  const statusMatch = stdout.match(/\n__KICK_HTTP_STATUS__:(\d{3})\s*$/);
  if (!statusMatch) throw new Error("Kickから正常な応答を取得できませんでした。");
  const status = Number(statusMatch[1]);
  const responseText = stdout.slice(0, statusMatch.index).trim();
  if (status < 200 || status >= 300) {
    throw new Error("Kick接続に失敗しました（HTTP " + status + "）。時間をおいて再試行してください。");
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new Error("KickからJSON形式ではない応答が返されました。");
  }
}

async function resolveChatroom(slug: string): Promise<ResolvedChannel> {
  const url = "https://kick.com/api/v2/channels/" + encodeURIComponent(slug);
  const payload = await requestKickJson<JsonRecord>(url, undefined, "Chatterino7");
  const chatroomId = readPositiveId(asRecord(payload.chatroom).id);
  if (!chatroomId) {
    throw new Error(slug + " のチャットルーム情報を取得できませんでした。チャンネル名を確認してください。");
  }
  return { slug, chatroomId };
}

async function createRealtimeConnection(clientId: string): Promise<string> {
  const payload = await requestKickJson<RealtimeConnectionResponse>(
    "https://web.kick.com/api/v1/realtime/connection",
    {
      client: { id: clientId, type: "web" },
      capabilities: {
        accepted_providers: [
          { provider: "pusher" },
          { provider: "centrifugo" }
        ]
      }
    }
  );

  const connection = (payload.data?.connections ?? []).find(item => item.provider === "centrifugo");
  const url = connection?.credentials?.url;
  if (typeof url !== "string" || !url.startsWith("wss://")) {
    throw new Error("Kickのリアルタイム接続先を取得できませんでした。");
  }
  return url;
}

async function createGuestToken(clientId: string): Promise<string> {
  const payload = await requestKickJson<RealtimeTokenResponse>(
    "https://web.kick.com/api/v1/realtime/auth/connection",
    { client_id: clientId }
  );
  const token = payload.data?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("Kickのチャット接続トークンを取得できませんでした。");
  }
  return token;
}

export class KickChatReceiver {
  private socket: WebSocket | null = null;
  private desiredSlugs: string[] = [];
  private connectedSlugs: string[] = [];
  private channelByFeed = new Map<string, string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private operationGeneration = 0;
  private stopping = true;
  private messageCount = 0;
  private lastMessageAt: string | null = null;
  private statusMessage = "コメント受信は停止中です。";
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly recentMessages: KickChatMessage[] = [];

  constructor(
    private readonly getOutputDirectory: () => string,
    private readonly shouldSaveMessages: () => boolean,
    private readonly onMessage: (message: KickChatMessage) => void,
    private readonly onStatus: (status: ChatReceiverStatus) => void
  ) {}

  getStatus(): ChatReceiverStatus {
    return {
      running: Boolean(this.socket?.readyState === WebSocket.OPEN && this.connectedSlugs.length > 0),
      connectedChannels: this.connectedSlugs.length,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      message: this.statusMessage
    };
  }

  getDesiredSlugs(): string[] {
    return [...this.desiredSlugs];
  }

  private publishStatus(message?: string): void {
    if (message) this.statusMessage = message;
    this.onStatus(this.getStatus());
  }

  async start(input: unknown): Promise<ChatReceiverStatus> {
    if (!Array.isArray(input)) throw new Error("チャット受信するチャンネル一覧が不正です。");
    const slugs = [...new Set(input
      .filter((value): value is string => typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value))
      .map(value => value.toLowerCase()))];
    if (slugs.length === 0) throw new Error("コメント受信するKickチャンネル名を指定してください。");
    if (slugs.length > 50) throw new Error("チャットの同時自動取得は最大50チャンネルです。受信するチャンネルを50件以内にしてください。");

    const generation = ++this.operationGeneration;
    this.clearActiveConnection();
    this.desiredSlugs = slugs;
    this.stopping = false;
    this.reconnectAttempt = 0;
    this.publishStatus("Kickのコメント受信先を準備しています。");

    try {
      await this.connect(generation, slugs);
      if (generation !== this.operationGeneration) return this.getStatus();
      return this.getStatus();
    } catch (error) {
      if (generation !== this.operationGeneration) return this.getStatus();
      this.stopping = true;
      this.desiredSlugs = [];
      this.clearTimers();
      const detail = error instanceof Error ? error.message : String(error);
      this.publishStatus("コメント受信を開始できませんでした：" + detail);
      throw error;
    }
  }

  async stop(publish = true): Promise<ChatReceiverStatus> {
    this.operationGeneration += 1;
    this.stopping = true;
    this.desiredSlugs = [];
    this.clearActiveConnection();
    if (publish) this.publishStatus("コメント受信を停止しました。");
    return this.getStatus();
  }

  private clearActiveConnection(): void {
    this.connectedSlugs = [];
    this.channelByFeed.clear();
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.removeAllListeners();
      socket.close(1000, "Application stopped");
      socket.terminate();
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.reconnectTimer = null;
    this.tokenRefreshTimer = null;
  }

  private async connect(generation: number, requestedSlugs: string[] = [...this.desiredSlugs]): Promise<void> {
    const resolved: ResolvedChannel[] = [];
    for (let offset = 0; offset < requestedSlugs.length; offset += 5) {
      if (generation !== this.operationGeneration || this.stopping) return;
      const batch = requestedSlugs.slice(offset, offset + 5);
      const results = await Promise.all(batch.map(async slug => {
        try {
          return await resolveChatroom(slug);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(slug + "： " + detail);
        }
      }));
      resolved.push(...results);
    }

    if (generation !== this.operationGeneration || this.stopping) return;
    const clientId = randomUUID();
    const [connectionUrl, token] = await Promise.all([
      createRealtimeConnection(clientId),
      createGuestToken(clientId)
    ]);
    const feedMap = new Map<string, string>();
    for (const channel of resolved) {
      feedMap.set("chatrooms." + channel.chatroomId + ".v2", channel.slug);
    }

    if (generation !== this.operationGeneration || this.stopping) return;
    await this.openSocket(connectionUrl, token, feedMap, generation);
  }

  private openSocket(connectionUrl: string, token: string, feedMap: Map<string, string>, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connectionUrl, {
        headers: {
          Origin: "https://kick.com",
          Referer: "https://kick.com/"
        },
        handshakeTimeout: 20_000,
        perMessageDeflate: false,
        maxPayload: 2 * 1024 * 1024
      });
      this.socket = socket;
      this.channelByFeed = feedMap;
      this.connectedSlugs = [];
      let settled = false;
      let subscribed = false;
      let nextCommandId = 2;
      const pending = new Set<number>();
      const commandTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error("Kickのチャット接続がタイムアウトしました。"));
      }, 30_000);

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(commandTimeout);
        reject(error);
      };

      socket.on("open", () => {
        socket.send(JSON.stringify({
          id: 1,
          connect: { token, name: "js" }
        }));
      });

      socket.on("message", (raw: WebSocket.RawData) => {
        const frame = raw.toString();
        for (const line of frame.split(/\r?\n/)) {
          if (!line.trim()) {
            if (subscribed && socket.readyState === WebSocket.OPEN) socket.send("{}");
            continue;
          }

          let message: JsonRecord;
          try {
            message = asRecord(JSON.parse(line) as unknown);
          } catch {
            continue;
          }

          // Centrifugo's JSON protocol uses an empty object as a ping.
          if (Object.keys(message).length === 0) {
            if (subscribed && socket.readyState === WebSocket.OPEN) socket.send("{}");
            continue;
          }

          if (message.push) {
            this.handlePublication(asRecord(message.push));
            continue;
          }

          const commandId = typeof message.id === "number" ? message.id : null;
          if (commandId === 1) {
            if (message.error) {
              const detail = asRecord(message.error);
              fail(new Error("Kickのチャット認証に失敗しました：" + String(detail.message ?? detail.code ?? "不明なエラー")));
              return;
            }
            if (message.connect && !subscribed) {
              subscribed = true;
              for (const feed of feedMap.keys()) {
                const id = nextCommandId++;
                pending.add(id);
                socket.send(JSON.stringify({ id, subscribe: { channel: feed } }));
              }
            }
            continue;
          }

          if (commandId !== null && pending.has(commandId)) {
            if (message.error) {
              const detail = asRecord(message.error);
              fail(new Error("Kickのチャット購読に失敗しました：" + String(detail.message ?? detail.code ?? "不明なエラー")));
              return;
            }
            if (message.subscribe) {
              pending.delete(commandId);
              if (pending.size === 0 && !settled) {
                settled = true;
                clearTimeout(commandTimeout);
                if (generation !== this.operationGeneration || this.stopping) {
                  socket.close(1000, "Superseded connection");
                  return;
                }
                this.connectedSlugs = [...new Set(feedMap.values())];
                this.reconnectAttempt = 0;
                this.publishStatus("コメント受信中（" + this.connectedSlugs.length + "チャンネル）。");
                this.tokenRefreshTimer = setTimeout(() => {
                  if (this.socket !== socket || this.stopping) return;
                  this.publishStatus("接続トークンを更新するため再接続しています。");
                  socket.close(4000, "Refresh guest connection");
                }, 40 * 60 * 1000);
                resolve();
              }
            }
          }
        }
      });

      socket.on("error", error => {
        if (!settled) fail(new Error("Kickのチャットサーバーへ接続できませんでした：" + error.message));
        else this.publishStatus("チャット接続エラー：" + error.message);
      });

      socket.once("close", (code, reason) => {
        clearTimeout(commandTimeout);
        if (this.socket !== socket || generation !== this.operationGeneration) return;
        this.socket = null;
        this.connectedSlugs = [];
        if (!settled) {
          fail(new Error("Kickのチャット接続が閉じられました（" + code + "）。" + reason.toString()));
          return;
        }
        if (!this.stopping) {
          this.publishStatus("Kickとの接続が切れました。自動再接続します。");
          this.scheduleReconnect();
        } else {
          this.publishStatus("コメント受信を停止しました。");
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer || this.desiredSlugs.length === 0) return;
    const delaySeconds = Math.min(30, 3 * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      this.publishStatus("Kickへ再接続しています。");
      const generation = this.operationGeneration;
      void this.connect(generation).catch(error => {
        if (generation !== this.operationGeneration || this.stopping) return;
        const detail = error instanceof Error ? error.message : String(error);
        this.publishStatus("再接続に失敗しました：" + detail + " 次回も自動で再試行します。");
        this.scheduleReconnect();
      });
    }, delaySeconds * 1000);
  }

  private handlePublication(push: JsonRecord): void {
    const channel = typeof push.channel === "string" ? push.channel : "";
    const slug = this.channelByFeed.get(channel);
    if (!slug) return;

    const publication = asRecord(push.pub);
    let envelope: JsonRecord;
    const rawEnvelope = publication.data;
    try {
      envelope = typeof rawEnvelope === "string"
        ? asRecord(JSON.parse(rawEnvelope) as unknown)
        : asRecord(rawEnvelope);
    } catch {
      return;
    }

    if (envelope.event !== "App\\Events\\ChatMessageEvent") return;
    let payload: JsonRecord;
    try {
      payload = typeof envelope.data === "string"
        ? asRecord(JSON.parse(envelope.data) as unknown)
        : asRecord(envelope.data);
    } catch {
      return;
    }

    const sender = asRecord(payload.sender);
    const identity = asRecord(sender.identity);
    const metadata = asRecord(payload.metadata);
    const originalMessage = asRecord(metadata.original_message);
    const badges = Array.isArray(identity.badges)
      ? identity.badges.map(badge => asRecord(badge).text)
          .filter((value): value is string => typeof value === "string")
      : [];
    const content = typeof payload.content === "string" ? payload.content : "";
    const emotes = [...content.matchAll(/\[emote:(\d+):[^\]]+\]/g)].map(match => ({
      emoteId: match[1],
      positions: [{ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length - 1 }]
    }));
    const messageId = typeof payload.id === "string" ? payload.id : "";
    if (!messageId || this.seenEventIds.has(slug + ":" + messageId)) return;

    const parsedDate = typeof payload.created_at === "string" ? new Date(payload.created_at) : new Date();
    const createdAt = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
    const message: KickChatMessage = {
      eventId: slug + ":" + messageId,
      messageId,
      channelSlug: slug,
      broadcasterUserId: null,
      senderUsername: typeof sender.username === "string" ? sender.username : "unknown",
      senderUserId: readPositiveId(sender.id),
      content,
      createdAt,
      receivedAt: new Date().toISOString(),
      usernameColor: typeof identity.color === "string"
        ? identity.color
        : typeof identity.username_color === "string" ? identity.username_color : null,
      badges,
      emotes,
      replyToMessageId: typeof originalMessage.id === "string"
        ? originalMessage.id
        : typeof payload.thread_parent_id === "string" ? payload.thread_parent_id : null
    };

    if (this.shouldSaveMessages()) {
      const day = createdAt.slice(0, 10);
      const channelDirectory = join(this.getOutputDirectory(), "Chat", message.channelSlug);
      mkdirSync(channelDirectory, { recursive: true });
      appendFileSync(join(channelDirectory, day + ".jsonl"), JSON.stringify(message) + "\n", "utf8");
    }

    this.rememberEventId(message.eventId);
    this.messageCount += 1;
    this.lastMessageAt = message.createdAt;
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > 100) this.recentMessages.length = 100;
    this.onMessage(message);
    this.publishStatus();
  }

  private rememberEventId(eventId: string): void {
    if (this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    while (this.seenEventOrder.length > 10_000) {
      const expired = this.seenEventOrder.shift();
      if (expired) this.seenEventIds.delete(expired);
    }
  }

  listRecentMessages(limit = 100): KickChatMessage[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const root = join(this.getOutputDirectory(), "Chat");
    if (!existsSync(root)) return [...this.recentMessages].slice(0, boundedLimit);

    const messages: KickChatMessage[] = [...this.recentMessages];
    try {
      for (const channelEntry of readdirSync(root, { withFileTypes: true })) {
        if (!channelEntry.isDirectory() || !/^[a-z0-9_]{1,25}$/.test(channelEntry.name)) continue;
        const channelDirectory = join(root, channelEntry.name);
        const files = readdirSync(channelDirectory)
          .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
          .sort()
          .reverse()
          .slice(0, 7);
        for (const file of files) {
          const content = readFileSync(join(channelDirectory, file), "utf8");
          for (const line of content.split(/\r?\n/).filter(Boolean).reverse()) {
            try {
              messages.push(JSON.parse(line) as KickChatMessage);
            } catch {
              // 壊れた行は飛ばして残りのログを読み込みます。
            }
          }
        }
      }
    } catch {
      // 読み込み中にファイルが移動・削除された場合は、読み込めた分だけ返します。
    }

    const unique = new Map<string, KickChatMessage>();
    for (const message of messages) unique.set(message.eventId, message);
    return [...unique.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, boundedLimit);
  }
}
