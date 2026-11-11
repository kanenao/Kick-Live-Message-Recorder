import { spawn, type ChildProcess } from "node:child_process";
import { constants, verify as verifySignature } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

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
  tunnelUrl: string;
  webhookUrl: string;
  messageCount: number;
  lastMessageAt: string | null;
  message: string;
};

type KickPublicKeyResponse = {
  data?: { public_key?: string };
  public_key?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeSlug(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value)
    ? value.toLowerCase()
    : "unknown";
}

function findCloudflared(): string {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    join(process.resourcesPath, "tools", executable),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable)
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? executable;
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        reject(new Error("Webhook payload is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export class KickChatReceiver {
  private server: Server | null = null;
  private tunnelProcess: ChildProcess | null = null;
  private tunnelUrl = "";
  private messageCount = 0;
  private lastMessageAt: string | null = null;
  private statusMessage = "チャット受信サーバーは停止中です。";
  private publicKeyCache: { value: string; expiresAt: number } | null = null;
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
      running: Boolean(this.server?.listening && this.tunnelProcess && this.tunnelUrl),
      tunnelUrl: this.tunnelUrl,
      webhookUrl: this.tunnelUrl ? `${this.tunnelUrl}/kick/webhook` : "",
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      message: this.statusMessage
    };
  }

  private publishStatus(message?: string): void {
    if (message) this.statusMessage = message;
    this.onStatus(this.getStatus());
  }

  async start(): Promise<ChatReceiverStatus> {
    if (this.server?.listening && this.tunnelProcess && this.tunnelUrl) return this.getStatus();

    await this.startLocalServer();
    const port = this.getListeningPort();
    let child: ChildProcess;
    try {
      child = spawn(findCloudflared(), ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      await this.stopLocalServer();
      throw new Error(`Cloudflare Tunnelを起動できませんでした：${error instanceof Error ? error.message : String(error)}`);
    }

    this.tunnelProcess = child;
    this.publishStatus("公開HTTPS接続を準備しています。");

    return new Promise<ChatReceiverStatus>((resolve, reject) => {
      let settled = false;
      let output = "";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.stop();
        reject(new Error("Cloudflare Tunnelの公開URLを取得できませんでした。ネットワーク接続を確認してください。"));
      }, 45_000);

      const inspectOutput = (chunk: Buffer | string): void => {
        output = (output + String(chunk)).slice(-20_000);
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (!match || settled) return;
        settled = true;
        clearTimeout(timeout);
        this.tunnelUrl = match[0];
        this.publishStatus("受信サーバーと公開HTTPSトンネルが起動しました。");
        resolve(this.getStatus());
      };

      child.stdout?.on("data", inspectOutput);
      child.stderr?.on("data", inspectOutput);
      child.once("error", error => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.tunnelProcess = null;
          void this.stopLocalServer();
          reject(new Error(error.message.includes("ENOENT")
            ? "cloudflared.exe が見つかりません。アプリを最新版に更新してください。"
            : `Cloudflare Tunnelの起動に失敗しました：${error.message}`));
        }
      });
      child.once("close", code => {
        if (this.tunnelProcess !== child) return;
        this.tunnelProcess = null;
        this.tunnelUrl = "";
        void this.stopLocalServer();
        this.publishStatus(`Cloudflare Tunnelが終了しました（終了コード：${String(code)}）。`);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Cloudflare Tunnelが公開URLを作成する前に終了しました。"));
        }
      });
    });
  }

  async stop(): Promise<ChatReceiverStatus> {
    const child = this.tunnelProcess;
    this.tunnelProcess = null;
    this.tunnelUrl = "";
    if (child && !child.killed) child.kill();
    await this.stopLocalServer();
    this.publishStatus("チャット受信サーバーを停止しました。");
    return this.getStatus();
  }

  private async startLocalServer(): Promise<void> {
    if (this.server?.listening) return;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, service: "Kick Live Message Recorder" }));
        return;
      }
      if (request.method !== "POST" || path !== "/kick/webhook") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      void this.handleWebhook(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  private getListeningPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Webhook受信サーバーのポートを取得できません。");
    return address.port;
  }

  private async stopLocalServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async getKickPublicKey(): Promise<string> {
    if (this.publicKeyCache && this.publicKeyCache.expiresAt > Date.now()) {
      return this.publicKeyCache.value;
    }
    const response = await fetch("https://api.kick.com/public/v1/public-key", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Kick公開鍵の取得に失敗しました（HTTP ${response.status}）。`);
    const payload = await response.json() as KickPublicKeyResponse;
    const publicKey = payload.data?.public_key ?? payload.public_key;
    if (typeof publicKey !== "string" || !publicKey.includes("BEGIN PUBLIC KEY")) {
      throw new Error("Kick公開鍵の応答形式が不正です。");
    }
    this.publicKeyCache = { value: publicKey, expiresAt: Date.now() + 60 * 60 * 1000 };
    return publicKey;
  }

  private async handleWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const rawBody = await readRequestBody(request, 2 * 1024 * 1024);
      const messageId = headerValue(request, "Kick-Event-Message-Id");
      const timestamp = headerValue(request, "Kick-Event-Message-Timestamp");
      const signature = headerValue(request, "Kick-Event-Signature");
      const eventType = headerValue(request, "Kick-Event-Type");
      const eventVersion = headerValue(request, "Kick-Event-Version");

      if (!messageId || !timestamp || !signature || !eventType) {
        response.writeHead(400);
        response.end("Missing Kick webhook headers");
        return;
      }

      const publicKey = await this.getKickPublicKey();
      const signedMessage = Buffer.from(`${messageId}.${timestamp}.${rawBody.toString("utf8")}`, "utf8");
      const valid = verifySignature(
        "RSA-SHA256",
        signedMessage,
        { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(signature, "base64")
      );
      if (!valid) {
        response.writeHead(401);
        response.end("Invalid webhook signature");
        return;
      }

      if (this.seenEventIds.has(messageId)) {
        response.writeHead(200);
        response.end("Duplicate event");
        return;
      }

      if (eventType !== "chat.message.sent" || eventVersion !== "1") {
        this.rememberEventId(messageId);
        response.writeHead(200);
        response.end("Event acknowledged");
        return;
      }

      const payload = asRecord(JSON.parse(rawBody.toString("utf8")) as unknown);
      const broadcaster = asRecord(payload.broadcaster);
      const sender = asRecord(payload.sender);
      const identity = asRecord(sender.identity);
      const reply = asRecord(payload.replies_to);
      const badges = Array.isArray(identity.badges)
        ? identity.badges.map(badge => asRecord(badge).text).filter((value): value is string => typeof value === "string")
        : [];
      const emotes = Array.isArray(payload.emotes)
        ? payload.emotes.map(emote => {
            const item = asRecord(emote);
            const positions = Array.isArray(item.positions)
              ? item.positions.map(position => asRecord(position))
                  .filter(position => typeof position.s === "number" && typeof position.e === "number")
                  .map(position => ({ start: position.s as number, end: position.e as number }))
              : [];
            return { emoteId: typeof item.emote_id === "string" ? item.emote_id : "", positions };
          }).filter(emote => emote.emoteId)
        : [];

      const eventDate = typeof payload.created_at === "string" ? new Date(payload.created_at) : new Date(timestamp);
      const createdAt = Number.isNaN(eventDate.getTime()) ? new Date().toISOString() : eventDate.toISOString();
      const message: KickChatMessage = {
        eventId: messageId,
        messageId: typeof payload.message_id === "string" ? payload.message_id : messageId,
        channelSlug: safeSlug(broadcaster.channel_slug),
        broadcasterUserId: typeof broadcaster.user_id === "number" ? broadcaster.user_id : null,
        senderUsername: typeof sender.username === "string" ? sender.username : "unknown",
        senderUserId: typeof sender.user_id === "number" ? sender.user_id : null,
        content: typeof payload.content === "string" ? payload.content : "",
        createdAt,
        receivedAt: new Date().toISOString(),
        usernameColor: typeof identity.username_color === "string" ? identity.username_color : null,
        badges,
        emotes,
        replyToMessageId: typeof reply.message_id === "string" ? reply.message_id : null
      };

      if (this.shouldSaveMessages()) {
        const day = createdAt.slice(0, 10);
        const channelDirectory = join(this.getOutputDirectory(), "Chat", message.channelSlug);
        mkdirSync(channelDirectory, { recursive: true });
        appendFileSync(join(channelDirectory, `${day}.jsonl`), `${JSON.stringify(message)}\n`, "utf8");
      }

      this.rememberEventId(messageId);
      this.messageCount += 1;
      this.lastMessageAt = message.createdAt;
      this.recentMessages.unshift(message);
      if (this.recentMessages.length > 100) this.recentMessages.length = 100;
      this.onMessage(message);
      this.publishStatus();
      response.writeHead(200);
      response.end("OK");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.publishStatus(`Webhook受信エラー：${detail}`);
      response.writeHead(500);
      response.end("Webhook processing failed");
    }
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
