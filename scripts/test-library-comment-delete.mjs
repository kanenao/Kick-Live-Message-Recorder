import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trashCommentLogFile, validateCommentLogForDeletion } from "../electron/comment-log-delete.ts";

const root = mkdtempSync(join(tmpdir(), "kick-comment-delete-"));
const outside = mkdtempSync(join(tmpdir(), "kick-unrelated-"));
try {
  const channelDir = join(root, "Chat", "streamer_1");
  mkdirSync(channelDir, { recursive: true });
  const log = join(channelDir, "streamer_1__2026-11-17_10-00-00__LIVE.jsonl");
  const video = join(root, "streamer_1.mp4");
  const aiArticle = join(root, "article.json");
  const txt = join(channelDir, "streamer_1.txt");
  writeFileSync(log, '{"content":"hello"}\n');
  writeFileSync(video, "recording data");
  writeFileSync(aiArticle, '{"headline":"test"}');
  writeFileSync(txt, "text");
  assert.equal(validateCommentLogForDeletion(root, log), log);

  const neverTrash = async () => { throw new Error("must not trash"); };
  await assert.rejects(() => trashCommentLogFile(root, log, () => true, neverTrash), /コメント取得中/);
  assert.ok(existsSync(log), "Active live comment must remain");
  for (const path of [
    video, aiArticle, txt, join(outside, "other.jsonl"), join(channelDir, "..", "..", "other.jsonl"),
    join(root, "Chat", "streamer_1", "sub", "nested.jsonl"), join(root, "Chat", "streamer_1.jsonl")
  ]) {
    await assert.rejects(() => trashCommentLogFile(root, path, () => false, neverTrash),
      /コメントログ/, "Only a log directly under Chat/<slug> can be removed");
  }
  const symlink = join(channelDir, "linked.jsonl");
  const externalLog = join(outside, "outside.jsonl");
  writeFileSync(externalLog, "outside");
  try {
    symlinkSync(externalLog, symlink, "file");
    await assert.rejects(() => trashCommentLogFile(root, symlink, () => false, neverTrash), /通常のコメントログ/);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }

  const destination = join(outside, "recycled.jsonl");
  const result = await trashCommentLogFile(root, log, () => false, async path => { renameSync(path, destination); });
  assert.equal(result.name, "streamer_1__2026-11-17_10-00-00__LIVE.jsonl");
  assert.equal(result.ok, true);
  assert.ok(!existsSync(log), "Only the selected comment log should be moved");
  assert.ok(existsSync(destination), "The log can be restored from its destination");
  assert.ok(existsSync(video), "The related video must remain");
  assert.ok(existsSync(aiArticle), "AI articles must not be deleted");
  assert.ok(existsSync(txt), "Companion comment formats must not be deleted");
  await assert.rejects(() => trashCommentLogFile(root, log, () => false, neverTrash), /見つからない/);
} finally {
  rmSync(root, { force: true, recursive: true });
  rmSync(outside, { force: true, recursive: true });
}

const app = await import("node:fs").then(fs => fs.readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8"));
assert.match(app, /deleteCommentLogFromLibrary\(log\)/, "Each JSONL row must have a delete action");
assert.match(app, /window\.confirm\(/, "Deletion needs explicit user confirmation");
assert.match(app, /setRecordingSessions\(current => current\.map\(session => \(\{[\s\S]*?logs: session\.logs\.filter/, "Update broadcast log counts immediately");
assert.match(app, /setSelectedCommentLogPaths\(current => current\.filter/, "Remove deleted file from comment-video selection");

console.log("録画ライブラリのコメントログ削除・安全性・既存動画・AI記事保護テスト成功");
