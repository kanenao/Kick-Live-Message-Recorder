import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep disk failures out of the WebSocket message handler. A full or locked
 * recording drive must not crash chat receiving or lose in-memory messages.
 */
export function appendKickChatJsonl(
  outputDirectory: string,
  channelSlug: string,
  fileStem: string,
  message: unknown
): { ok: true } | { ok: false; error: string } {
  try {
    if (!/^[a-z0-9_]{1,25}$/.test(channelSlug) ||
        !fileStem || fileStem.length > 220 ||
        fileStem === "." || fileStem === ".." ||
        /[\\/\x00-\x1f\x7f]/.test(fileStem)) {
      throw new Error("ログの保存先名が不正です。");
    }
    const directory = join(outputDirectory, "Chat", channelSlug);
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, fileStem + ".jsonl"), JSON.stringify(message) + "\n", "utf8");
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: detail.slice(0, 240) };
  }
}

export const MAX_RECENT_CHAT_TAIL_BYTES = 512 * 1024;

/**
 * Read only the end of a JSONL chat log to avoid loading multi-GB streaming
 * logs on every "recent comments" refresh. Silently skip damaged partial lines.
 */
export function readRecentKickChatJsonl<T extends { eventId: string; createdAt: string }>(
  filePath: string,
  limit = 100
): T[] {
  const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  let descriptor: number | null = null;
  try {
    const info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink()) return [];
    descriptor = openSync(filePath, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0) return [];
    const count = Math.min(stats.size, MAX_RECENT_CHAT_TAIL_BYTES);
    const buffer = Buffer.alloc(count);
    const bytesRead = readSync(descriptor, buffer, 0, count, stats.size - count);
    let contents = buffer.subarray(0, bytesRead).toString("utf8");
    if (stats.size > count) {
      // The first line began before the read window and may contain a broken
      // UTF-8 character or incomplete JSON. Discard it in full.
      const firstLineEnd = contents.indexOf("\n");
      if (firstLineEnd < 0) return [];
      contents = contents.slice(firstLineEnd + 1);
    }
    const result: T[] = [];
    for (const line of contents.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry && typeof entry.eventId === "string" && entry.eventId.length > 0 &&
            typeof entry.createdAt === "string" && Number.isFinite(Date.parse(entry.createdAt))) {
          result.push(entry as T);
          if (result.length >= maximum) break;
        }
      } catch { /* Ignore malformed or incomplete JSONL lines. */ }
    }
    return result;
  } catch {
    // The file may have been deleted or rotated during the refresh.
    return [];
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}
