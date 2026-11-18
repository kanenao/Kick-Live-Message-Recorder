import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendKickChatJsonl, readRecentKickChatJsonl, MAX_RECENT_CHAT_TAIL_BYTES } from "../electron/chat-log-safety.ts";

const root = mkdtempSync(join(tmpdir(), "kick-chat-log-test-"));
try {
  const start = { eventId: "test:1", createdAt: "2026-11-18T17:00:00.000Z", content: "日本語😊" };
  assert.deepEqual(appendKickChatJsonl(root, "test", "2026-11-18", start), { ok: true });
  assert.deepEqual(readRecentKickChatJsonl(join(root, "Chat", "test", "2026-11-18.jsonl")), [start]);
  assert.equal(appendKickChatJsonl(root, "test", "../outside", start).ok, false, "Unsafe stem is rejected");
  assert.equal(appendKickChatJsonl(root, "../outside", "date", start).ok, false, "Unsafe channel is rejected");

  // Deterministic disk error without relying on platform-specific chmod.
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "leave me alone");
  const failed = appendKickChatJsonl(blocker, "test", "today", start);
  assert.equal(failed.ok, false, "Writing beneath a regular file returns an error instead of throwing");

  const dir = join(root, "Chat", "test");
  const bigFile = join(dir, "big.jsonl");
  const lines = Array.from({ length: 15_000 }, (_, index) =>
    JSON.stringify({
      eventId: "test:" + index,
      createdAt: new Date(Date.parse("2026-11-01T00:00:00Z") + index * 1000).toISOString(),
      content: "日本語😊" + "x".repeat(210)
    })
  );
  writeFileSync(bigFile, lines.join("\n") + "\n", "utf8");
  assert.ok(Buffer.byteLength(lines.join("\n")) > MAX_RECENT_CHAT_TAIL_BYTES * 4);
  const last = readRecentKickChatJsonl(bigFile, 15);
  assert.equal(last.length, 15);
  assert.equal(last[0].eventId, "test:14999");
  assert.equal(last[14].eventId, "test:14985");
  assert.ok(last.every(message => message.content.includes("😊")), "UTF-8 is preserved");
  appendFileSync(bigFile, "invalid-json\n" +
    JSON.stringify({ createdAt: "2026-11-18T17:00:00Z" }) + "\n" +
    JSON.stringify({ eventId: "bad-date", createdAt: "not-a-date" }) + "\n", "utf8");
  assert.equal(readRecentKickChatJsonl(bigFile, 1)[0].eventId, "test:14999",
    "Damaged and invalid entries are discarded");
  const veryLong = join(dir, "huge-line.jsonl");
  writeFileSync(veryLong, "{" + "x".repeat(MAX_RECENT_CHAT_TAIL_BYTES + 1000));
  assert.deepEqual(readRecentKickChatJsonl(veryLong), [], "Partial giant line does not exhaust memory");
  if (process.platform !== "win32") {
    const link = join(dir, "shortcut.jsonl");
    symlinkSync(bigFile, link);
    assert.deepEqual(readRecentKickChatJsonl(link), [], "Symlink is not followed");
  }
  assert.deepEqual(readRecentKickChatJsonl(join(dir, "not-found.jsonl")), []);

  const source = (await import("node:fs")).readFileSync(new URL("../electron/chat.ts", import.meta.url), "utf8");
  assert.match(source, /appendKickChatJsonl\(/, "The socket listener protects all JSONL writes");
  assert.match(source, /readRecentKickChatJsonl<KickChatMessage>/, "The UI reads a bounded JSONL tail");
  assert.doesNotMatch(source, /readFileSync\(join\(channelDirectory, file\)/,
    "Reading the entire log must never be reintroduced");
  console.log("Kickコメント：保存失敗の隔離・巨大JSONLの末尾限定読込・破損ログの回帰テスト成功");
} finally {
  rmSync(root, { recursive: true, force: true });
}
