import { createReadStream, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type LibraryCommentMessage = {
  eventId: string;
  senderUsername: string;
  content: string;
  createdAt: string;
  usernameColor: string | null;
};

/**
 * Read recent saved chat messages for one channel. The caller cannot supply an
 * arbitrary file path; every log is discovered below Chat/<validated-channel>.
 */
export async function listRecentCommentMessages(
  outputDirectory: string,
  channelSlugInput: unknown,
  limitInput: unknown = 100
): Promise<LibraryCommentMessage[]> {
  if (typeof channelSlugInput !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(channelSlugInput)) {
    throw new Error("チャンネル名が正しくありません。");
  }
  const channelSlug = channelSlugInput.toLowerCase();
  const limit = typeof limitInput === "number" && Number.isFinite(limitInput)
    ? Math.max(1, Math.min(200, Math.round(limitInput)))
    : 100;
  const chatRoot = join(resolve(outputDirectory), "Chat");
  const channelDirectory = join(chatRoot, channelSlug);
  let entries;
  try {
    const rootStat = lstatSync(chatRoot);
    const channelStat = lstatSync(channelDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !channelStat.isDirectory() || channelStat.isSymbolicLink()) return [];
    entries = readdirSync(channelDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const logs = entries.flatMap(entry => {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".jsonl") return [];
    const path = join(channelDirectory, entry.name);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) return [];
      return [{ path, modifiedAt: stats.mtimeMs }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 30).reverse();

  const messages: LibraryCommentMessage[] = [];
  for (const log of logs) {
    try {
      const reader = createInterface({
        input: createReadStream(log.path, { encoding: "utf8" }),
        crlfDelay: Infinity
      });
      try {
        for await (const line of reader) {
          if (!line || line.length > 64 * 1024) continue;
          let value: unknown;
          try { value = JSON.parse(line) as unknown; } catch { continue; }
          if (!value || typeof value !== "object") continue;
          const item = value as Record<string, unknown>;
          const senderUsername = typeof item.senderUsername === "string"
            ? item.senderUsername.trim().slice(0, 100)
            : "";
          const content = typeof item.content === "string" ? item.content.trim().slice(0, 4000) : "";
          const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
          if (!senderUsername || !content || !Number.isFinite(Date.parse(createdAt))) continue;
          if (typeof item.channelSlug === "string" && item.channelSlug.toLowerCase() !== channelSlug) continue;
          messages.push({
            eventId: typeof item.eventId === "string" ? item.eventId.slice(0, 160) : createdAt + ":" + messages.length,
            senderUsername,
            content,
            createdAt,
            usernameColor: typeof item.usernameColor === "string" && /^#[0-9a-f]{3,8}$/i.test(item.usernameColor)
              ? item.usernameColor
              : null
          });
          if (messages.length > limit * 3) messages.splice(0, messages.length - limit * 3);
        }
      } finally {
        reader.close();
      }
    } catch {
      // A log may be removed while the library is loading; continue with the others.
    }
  }

  return messages
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}
