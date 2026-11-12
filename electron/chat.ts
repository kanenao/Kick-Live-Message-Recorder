import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { verify as verifySignature } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SavedKickChatMessage = {
  messageId: string;
  slug: string;
  broadcaster: string;
  user: string;
  text: string;
  timestamp: string;
  receivedAt: string;
  badges: string[];
  emotes: Array<{ emoteId: string; start: number; end: number }>;
};

export type ChatServiceStatus = {
  serverRunning: boolean;
  tunnelRunning: boolean;
  localUrl: string;
  publicUrl: string;
  receivedCount: number;
  lastMessageAt: string | null;
  message: string;
};

export type ChatServiceEvent =
  | { type: "status"; status: ChatServiceStatus }
  | { type: "message"; message: SavedKickChatMessage };

type KickPerson = {
  username?: unknown;
  channel_slug?: unknown;
  user_id?: unknown;
  is_anonymous?: unknown;
  identity?: { badges?: Array<{ text?: unknown; type?: unknown }> } | null;
};

type KickChatPayload = {
  message_id?: unknown;
  broadcaster?: KickPerson;
  sender?: KickPerson;
  content?: unknown;
  created_at?: unknown;
  emotes?: Array<{ emote_id?: unknown; positions?: Array<{ s?: unknown; e?: unknown }> }>;
};

const WEBHOOK_PATH = "/kick/webhook";
const MAX_BODY_BYTES = 1024 * 1024;

function asText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, max) : "";
}

function safeSlug(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(value)
    ? value.toLowerCase()
    : "";
}

function dateForFile(value: string): string {
  const date = new Date(value);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    valid.getFullYear(),
    String(valid.getMonth() + 1).padStart(2, "0"),
    String(valid.getDate()).padStart(2, "0")
  ].join("");
}

function respond(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: status >= 200 && status < 300, message: body }));
}

export class KickChatReceiver {
  private server: Server | null = null;
  private tunnel: ChildProcess | null = null;
  private localPort = 0;
  private publicUrl = "";
  private outputDirectory = "";
  private receivedCount = 0;
  private lastMessageAt: string | null = null;
  private message = "チャット受信サーバーは停止中です。";
  private publicKeyCache: { pem: string; expiresAt: number } | null = null;
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly onEvent: (event: ChatServiceEvent) => void) {}

  getStatus(): ChatServiceStatus {
    return {
      serverRunning: Boolean(this.server?.listening),
      tunnelRunning: Boolean(this.tunnel && !this.tunnel.killed),
      localUrl: this.localPort ? `http://127.0.0.1:${this.localPort}${WEBHOOK_PATH}` : "",
      publicUrl: this.publicUrl ? this.publicUrl + WEBHOOK_PATH : "",
      receivedCount: this.receivedCount,
      lastMessageAt: this.lastMessageAt,
      message: this.message
    };
  }

  private publish(message?: string): void {
    if (message) this.message = message;
    this.onEvent({ type: "status", status: this.getStatus() });
  }

  async startServer(outputDirectory: string): Promise<ChatServiceStatus> {
    if (this.server?.listening) return this.getStatus();
    this.outputDirectory = outputDirectory;
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(error => {
        console.error("Kick webhook request failed:", error);
        respond(res, 500, "受信処理に失敗しました。");
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Webhook受信ポートを取得できませんでした。"));
          return;
        }
        this.localPort = address.port;
        resolve();
      });
    });
    this.publish("ローカルWebhook受信サーバーを起動しました。");
    return this.getStatus();
  }

  async startTunnel(userDataDirectory: string): Promise<ChatServiceStatus> {
    if (!this.server?.listening || !this.localPort) {
      throw new Error("先にチャット受信サーバーを起動してください。");
    }
    if (this.tunnel && !this.tunnel.killed) return this.getStatus();

    const executable = this.findCloudflared(userDataDirectory);
    this.publicUrl = "";
    this.publish("Cloudflare Tunnelを起動しています。");
    const child = spawn(executable, [
      "tunnel",
      "--url", `http://127.0.0.1:${this.localPort}`,
      "--no-autoupdate"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.tunnel = child;

    return new Promise<ChatServiceStatus>((resolve, reject) => {
      let settled = false;
      let outputTail = "";
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(this.getStatus());
      };
      const parseOutput = (chunk: Buffer | string): void => {
        outputTail = (outputTail + String(chunk)).slice(-12000);
        const match = outputTail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !this.publicUrl) {
          this.publicUrl = match[0];
          this.publish("公開URLを取得しました。Kick DeveloperのWebhook URL欄へ登録してください。");
          finish();
        }
      };
      child.stdout?.on("data", parseOutput);
      child.stderr?.on("data", parseOutput);
      child.once("error", error => {
        this.tunnel = null;
        this.publish(`cloudflaredを起動できませんでした：${error.message}`);
        finish(new Error(error.message.includes("ENOENT")
          ? "cloudflared.exe が見つかりません。最新版のWindowsインストーラーを使用してください。"
          : `Cloudflare Tunnelを起動できません：${error.message}`));
      });
      child.once("close", code => {
        if (this.tunnel === child) this.tunnel = null;
        if (!this.publicUrl) {
          this.publish(`Cloudflare Tunnelが終了しました（終了コード：${String(code)}）。`);
          finish(new Error("Cloudflare Tunnelが公開URLを取得する前に終了しました。"));
        } else {
          this.publish("Cloudflare Tunnelが停止しました。");
        }
      });
      const timer = setTimeout(() => {
        if (!this.publicUrl) {
          try { child.kill(); } catch { /* 終了済み */ }
          this.tunnel = null;
          this.publish("Cloudflare Tunnelの公開URLを取得できませんでした。ネットワークを確認してください。");
          finish(new Error("Cloudflare Tunnelの起動がタイムアウトしました。"));
        }
      }, 30_000);
      timer.unref();
    });
  }

  stop(): ChatServiceStatus {
    if (this.tunnel) {
      try { this.tunnel.kill(); } catch { /* 終了済み */ }
      this.tunnel = null;
    }
    if (this.server) {
      try { this.server.close(); } catch { /* 終了済み */ }
      this.server = null;
    }
    this.localPort = 0;
    this.publicUrl = "";
    this.publish("チャット受信サーバーとCloudflare Tunnelを停止しました。");
    return this.getStatus();
  }

  listMessages(inputSlug: unknown, limit = 500): SavedKickChatMessage[] {
    const slug = safeSlug(inputSlug);
    if (!slug) throw new Error("チャンネル名が不正です。");
    const directory = join(this.outputDirectory || process.cwd(), "ChatLogs");
    if (!existsSync(directory)) return [];
    const max = Math.max(1, Math.min(5000, limit));
    const files = readdirSync(directory)
      .filter(name => name.toLowerCase().startsWith(slug + "_") && name.toLowerCase().endsWith(".jsonl"))
      .map(name => ({ path: join(directory, name) }))
      .sort((a, b) => {
        try { return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs; } catch { return 0; }
      });
    const messages: SavedKickChatMessage[] = [];
    for (const file of files) {
      try {
        const lines = readFileSync(file.path, "utf8").split(/\r?\n/).filter(Boolean);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const parsed = JSON.parse(lines[index]) as SavedKickChatMessage;
            if (parsed.slug === slug) messages.push(parsed);
            if (messages.length >= max) break;
          } catch { /* 破損行は読み飛ばす */ }
        }
      } catch { /* 読み取り中に消えたログは読み飛ばす */ }
      if (messages.length >= max) break;
    }
    return messages.reverse();
  }

  private findCloudflared(userDataDirectory: string): string {
    const candidates = [
      join(process.resourcesPath, "tools", "cloudflared.exe"),
      join(process.cwd(), "vendor", "win-x64", "cloudflared.exe"),
      join(userDataDirectory, "tools", "cloudflared.exe")
    ];
    return candidates.find(path => existsSync(path)) ?? "cloudflared.exe";
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && (req.url === "/" || req.url === WEBHOOK_PATH)) {
      respond(res, 200, "Kick webhook receiver is ready.");
      return;
    }
    if (req.method !== "POST" || req.url !== WEBHOOK_PATH) {
      respond(res, 404, "Not found.");
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        respond(res, 413, "Webhook payload is too large.");
        req.destroy();
        return;
      }
      chunks.push(buffer);
    }
    const rawBody = Buffer.concat(chunks);
    const messageId = String(req.headers["kick-event-message-id"] || "");
    const timestamp = String(req.headers["kick-event-message-timestamp"] || "");
    const signature = String(req.headers["kick-event-signature"] || "");
    const eventType = String(req.headers["kick-event-type"] || "");
    const version = String(req.headers["kick-event-version"] || "");

    if (!messageId || !timestamp || !signature) {
      respond(res, 401, "署名ヘッダーがありません。");
      return;
    }
    if (!this.verifyWebhookSignature(messageId, timestamp, rawBody, signature, await this.getPublicKey())) {
      respond(res, 401, "Webhook署名を検証できませんでした。");
      return;
    }
    if (this.seenMessageIds.has(messageId)) {
      respond(res, 200, "重複イベントを確認済みです。");
      return;
    }
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 10000) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }

    if (eventType !== "chat.message.sent" || version !== "1") {
      respond(res, 200, "対象外イベントを受け付けました。");
      return;
    }

    let payload: KickChatPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as KickChatPayload;
    } catch {
      respond(res, 400, "JSON形式が不正です。");
      return;
    }
    const slug = safeSlug(payload.broadcaster?.channel_slug);
    const text = asText(payload.content, 2000);
    const id = asText(payload.message_id, 128) || messageId;
    if (!slug || !text) {
      respond(res, 400, "配信者またはコメント本文がありません。");
      return;
    }

    const timestampText = asText(payload.created_at, 64) || timestamp;
    const message: SavedKickChatMessage = {
      messageId: id,
      slug,
      broadcaster: asText(payload.broadcaster?.username, 80) || slug,
      user: asText(payload.sender?.username, 80) || "匿名ユーザー",
      text,
      timestamp: timestampText,
      receivedAt: new Date().toISOString(),
      badges: Array.isArray(payload.sender?.identity?.badges)
        ? payload.sender!.identity!.badges!.map(badge => asText(badge.text || badge.type, 40)).filter(Boolean).slice(0, 12)
        : [],
      emotes: Array.isArray(payload.emotes)
        ? payload.emotes.slice(0, 40).flatMap(emote => {
            const emoteId = asText(emote.emote_id, 64);
            return emote.positions?.slice(0, 20).map(position => ({
              emoteId,
              start: Number(position.s) || 0,
              end: Number(position.e) || 0
            })) ?? [];
          })
        : []
    };

    const directory = join(this.outputDirectory, "ChatLogs");
    mkdirSync(directory, { recursive: true });
    const filePath = join(directory, `${slug}_${dateForFile(timestampText)}.jsonl`);
    appendFileSync(filePath, JSON.stringify(message) + "\n", { encoding: "utf8", mode: 0o600 });
    this.receivedCount += 1;
    this.lastMessageAt = message.receivedAt;
    this.message = `${slug} のコメントを保存しました（${this.receivedCount.toLocaleString("ja-JP")}件）。`;
    this.onEvent({ type: "message", message });
    this.publish();
    respond(res, 200, "受信しました。");
  }

  private async getPublicKey(): Promise<string> {
    if (this.publicKeyCache && this.publicKeyCache.expiresAt > Date.now()) return this.publicKeyCache.pem;
    const response = await fetch("https://api.kick.com/public/v1/public-key", {
      headers: { Accept: "application/json, text/plain" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Kick公開鍵の取得に失敗しました（HTTP ${response.status}）。`);
    const raw = await response.text();
    let pem = raw;
    try {
      const parsed = JSON.parse(raw) as { public_key?: unknown; data?: { public_key?: unknown } };
      pem = typeof parsed.public_key === "string" ? parsed.public_key
        : typeof parsed.data?.public_key === "string" ? parsed.data.public_key
        : raw;
    } catch { /* endpoint may return PEM as plain text */ }
    if (!pem.includes("BEGIN PUBLIC KEY")) throw new Error("Kick公開鍵の形式を認識できませんでした。");
    this.publicKeyCache = { pem, expiresAt: Date.now() + 60 * 60 * 1000 };
    return pem;
  }

  private verifyWebhookSignature(messageId: string, timestamp: string, rawBody: Buffer, signature: string, publicKey: string): boolean {
    try {
      const signed = Buffer.concat([
        Buffer.from(messageId + "." + timestamp + ".", "utf8"),
        rawBody
      ]);
      return verifySignature("RSA-SHA256", signed, publicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }
}
