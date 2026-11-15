import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteStreamArticle, getStreamArticlePreview, isValidStreamArticleId, listStreamArticles
} from "../electron/articles.ts";

const outputDirectory = mkdtempSync(join(tmpdir(), "kick-article-delete-test-"));
const articleRoot = join(outputDirectory, "Articles");
const mixedCaseFolder = join(articleRoot, "Punikerochan");
const normalFolder = join(articleRoot, "punikerochan");
const writeArticle = (directory, id, slug, extra = {}) => {
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, id + ".json");
  writeFileSync(filePath, JSON.stringify({
    id, slug, displayName: "punikerochan", headline: "削除テスト記事",
    startedAt: "2026-11-15T12:00:00.000Z", paragraphs: ["テスト記事"],
    sourceVideo: "", sourceLogs: [], ...extra
  }));
  return filePath;
};

try {
  const legacyId = "Punikerochan_legacy-session_2026";
  const normalId = "punikerochan_20261116T021000Z";
  const sourceVideo = join(outputDirectory, "punikerochan_20261115_120000.mp4");
  const sourceLog = join(outputDirectory, "Chat", "Punikerochan", "chat.jsonl");
  mkdirSync(join(outputDirectory, "Chat", "Punikerochan"), { recursive: true });
  writeFileSync(sourceVideo, "keep-video");
  writeFileSync(sourceLog, '{"content":"keep-chat"}');

  // A crash can leave status="live" after the actual session has ended.
  const legacyArticle = writeArticle(mixedCaseFolder, legacyId, "Punikerochan", {
    status: "live", sourceVideo, sourceLogs: [sourceLog]
  });
  const normalArticle = writeArticle(normalFolder, normalId, "punikerochan");
  const jpeg = Buffer.alloc(256, 0x44);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  jpeg[jpeg.length - 2] = 0xff; jpeg[jpeg.length - 1] = 0xd9;
  const legacyPreview = join(mixedCaseFolder, legacyId + ".preview.jpg");
  writeFileSync(legacyPreview, jpeg);

  assert.equal(isValidStreamArticleId("punikerochan", legacyId), true);
  assert.equal(isValidStreamArticleId("punikerochan", normalId), true);
  assert.equal(isValidStreamArticleId("punikerochan", "other_20261115_120000"), false);
  assert.equal(isValidStreamArticleId("punikerochan", "punikerochan_../outside"), false);
  assert.equal(isValidStreamArticleId("punikerochan", "punikerochan_" + "a".repeat(80)), false);

  assert.deepEqual(new Set(listStreamArticles(outputDirectory, "Punikerochan").map(a => a.id)), new Set([legacyId, normalId]));
  assert.equal(
    getStreamArticlePreview(outputDirectory, "punikerochan", legacyId),
    "data:image/jpeg;base64," + jpeg.toString("base64")
  );
  assert.equal(getStreamArticlePreview(outputDirectory, "Punikerochan", normalId), null);

  assert.deepEqual(deleteStreamArticle(outputDirectory, "punikerochan", legacyId), { ok: true, id: legacyId });
  assert.equal(existsSync(legacyArticle), false, "Legacy article JSON must be deleted.");
  assert.equal(existsSync(legacyPreview), false, "The associated preview must be deleted.");
  assert.equal(existsSync(normalArticle), true, "Other articles must stay.");
  assert.equal(existsSync(sourceVideo), true, "Original videos must stay.");
  assert.equal(existsSync(sourceLog), true, "Original chat logs must stay.");
  assert.equal(getStreamArticlePreview(outputDirectory, "punikerochan", legacyId), null);
  assert.deepEqual(deleteStreamArticle(outputDirectory, "Punikerochan", normalId), { ok: true, id: normalId });

  // Reject ambiguity instead of deleting an arbitrary duplicate in a differently-cased folder.
  const duplicateId = "punikerochan_duplicate_2026";
  const copyA = writeArticle(mixedCaseFolder, duplicateId, "Punikerochan");
  const copyB = writeArticle(normalFolder, duplicateId, "punikerochan");
  assert.throws(() => deleteStreamArticle(outputDirectory, "punikerochan", duplicateId), /複数/);
  assert.throws(() => getStreamArticlePreview(outputDirectory, "punikerochan", duplicateId), /複数/);
  assert.equal(existsSync(copyA), true);
  assert.equal(existsSync(copyB), true);

  // Reject a forged JSON payload even if its filename looks valid.
  const forgedId = "punikerochan_20261116_030000";
  const forgedPath = writeArticle(normalFolder, forgedId, "unrelated_broadcaster");
  assert.throws(() => deleteStreamArticle(outputDirectory, "punikerochan", forgedId), /一致しない/);
  assert.equal(getStreamArticlePreview(outputDirectory, "punikerochan", forgedId), null);
  assert.equal(existsSync(forgedPath), true);

  assert.throws(() => deleteStreamArticle(outputDirectory, "punikerochan", "../outside"), /記事IDが不正/);
  assert.throws(() => getStreamArticlePreview(outputDirectory, "punikerochan", "punikerochan_../outside"), /記事.*IDが不正/);
  console.log("配信AI新聞の記事削除テスト成功（複数フォルダー・旧ID・LIVE残留・放送画像・誤削除防止・動画/コメント保持）");
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
