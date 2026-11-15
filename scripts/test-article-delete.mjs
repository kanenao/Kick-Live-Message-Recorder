import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteStreamArticle, isValidStreamArticleId } from "../electron/articles.ts";

const outputDirectory = mkdtempSync(join(tmpdir(), "kick-article-delete-test-"));
try {
  const legacyFolder = join(outputDirectory, "Articles", "Punikerochan");
  mkdirSync(legacyFolder, { recursive: true });
  const legacyId = "Punikerochan_legacy-session_2026";
  const articlePath = join(legacyFolder, legacyId + ".json");
  const previewPath = join(legacyFolder, legacyId + ".preview.jpg");
  const sourceVideo = join(outputDirectory, "punikerochan_20261115_120000.mp4");
  const sourceLog = join(outputDirectory, "Chat", "Punikerochan", "chat.jsonl");
  mkdirSync(join(outputDirectory, "Chat", "Punikerochan"), { recursive: true });
  writeFileSync(sourceVideo, "keep-video");
  writeFileSync(sourceLog, "{\"content\":\"keep-chat\"}");
  writeFileSync(previewPath, Buffer.alloc(256, 0x44));
  writeFileSync(articlePath, JSON.stringify({
    id: legacyId,
    slug: "Punikerochan",
    displayName: "punikerochan",
    headline: "削除テスト記事",
    category: "",
    startedAt: "2026-11-15T12:00:00.000Z",
    durationSeconds: 60,
    commentCount: 1,
    uniqueCommenters: 1,
    keywords: [],
    paragraphs: ["test"],
    sourceVideo,
    sourceLogs: [sourceLog],
    createdAt: "2026-11-15T12:01:00.000Z"
  }));

  assert.equal(isValidStreamArticleId("punikerochan", legacyId), true);
  assert.equal(isValidStreamArticleId("punikerochan", "other_20261115_120000"), false);
  assert.equal(isValidStreamArticleId("punikerochan", "punikerochan_../outside"), false);
  assert.equal(isValidStreamArticleId("punikerochan", "punikerochan_" + "a".repeat(80)), false);

  const result = deleteStreamArticle(outputDirectory, "punikerochan", legacyId);
  assert.deepEqual(result, { ok: true, id: legacyId });
  assert.equal(existsSync(articlePath), false, "The article JSON must be deleted.");
  assert.equal(existsSync(previewPath), false, "The associated newspaper preview must be deleted.");
  assert.equal(existsSync(sourceVideo), true, "The original video must be preserved.");
  assert.equal(existsSync(sourceLog), true, "The original chat log must be preserved.");

  const normalFolder = join(outputDirectory, "Articles", "punikerochan");
  mkdirSync(normalFolder, { recursive: true });
  const normalId = "punikerochan_20261116T021000Z";
  writeFileSync(join(normalFolder, normalId + ".json"), JSON.stringify({
    id: normalId,
    slug: "punikerochan",
    headline: "通常形式の記事",
    paragraphs: []
  }));
  assert.deepEqual(deleteStreamArticle(outputDirectory, "Punikerochan", normalId), { ok: true, id: normalId });
  assert.equal(existsSync(join(normalFolder, normalId + ".json")), false);

  assert.throws(() => deleteStreamArticle(outputDirectory, "punikerochan", "../outside"), /記事IDが不正/);
  console.log("配信AI新聞の記事削除テスト成功（旧形式ID・フォルダー大小文字・パス保護・元動画／コメントログ保持）");
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
