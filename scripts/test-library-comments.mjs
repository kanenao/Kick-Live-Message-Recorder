import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentCommentMessages } from "../electron/comment-video.ts";

const root = mkdtempSync(join(tmpdir(), "kick-recorder-library-"));
try {
  const channel = join(root, "Chat", "sample_channel");
  mkdirSync(channel, { recursive: true });
  const olderPath = join(channel, "2026-11-13.jsonl");
  const newerPath = join(channel, "2026-11-14.jsonl");
  const record = (eventId, senderUsername, content, createdAt) => JSON.stringify({
    eventId, channelSlug: "sample_channel", senderUsername, content, createdAt, usernameColor: "#55cc88"
  });
  writeFileSync(olderPath, [
    record("old-1", "alice", "older message one", "2026-11-13T10:00:00.000Z"),
    record("old-2", "bob", "older message two", "2026-11-13T10:01:00.000Z")
  ].join("\n") + "\n", "utf8");
  writeFileSync(newerPath, [
    record("new-1", "carol", "newest message", "2026-11-14T10:00:00.000Z"),
    "{broken json"
  ].join("\n") + "\n", "utf8");
  const oldTime = new Date("2026-11-13T12:00:00.000Z");
  const newTime = new Date("2026-11-14T12:00:00.000Z");
  utimesSync(olderPath, oldTime, oldTime);
  utimesSync(newerPath, newTime, newTime);

  const latest = await listRecentCommentMessages(root, "sample_channel", 2);
  assert.deepEqual(latest.map(item => item.eventId), ["new-1", "old-2"]);
  assert.equal(latest[0].senderUsername, "carol");
  assert.equal(latest[0].usernameColor, "#55cc88");
  assert.deepEqual(await listRecentCommentMessages(root, "another_channel", 100), []);
  await assert.rejects(() => listRecentCommentMessages(root, "../outside", 100), /チャンネル名/);
  const bounded = await listRecentCommentMessages(root, "sample_channel", 5000);
  assert.ok(bounded.length <= 200);
  console.log("録画ライブラリのコメント読込テスト成功");
} finally {
  rmSync(root, { recursive: true, force: true });
}
