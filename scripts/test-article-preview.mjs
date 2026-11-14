import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteArticlePreview,
  readArticlePreviewDataUrl,
  saveArticlePreviewFrame
} from "../electron/article-preview.ts";

const directory = mkdtempSync(join(tmpdir(), "kick-article-preview-test-"));
try {
  const articleId = "sample_channel_20261114_120000";
  const bytes = Buffer.alloc(512, 0x44);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  const base64 = bytes.toString("base64");

  const saved = saveArticlePreviewFrame(directory, articleId, {
    timeSeconds: 83.9,
    imageBase64: base64
  });
  assert.equal(saved.videoPreviewAvailable, true);
  assert.equal(saved.videoPreviewTimeSeconds, 83);
  assert.match(saved.videoPreviewUpdatedAt, /^\d{4}-/);
  assert.equal(readArticlePreviewDataUrl(directory, articleId), "data:image/jpeg;base64," + base64);

  const filePath = join(directory, articleId + ".preview.jpg");
  assert.equal(statSync(filePath).size, bytes.length);
  assert.deepEqual(readFileSync(filePath), bytes);

  assert.throws(
    () => saveArticlePreviewFrame(directory, "../outside", { timeSeconds: 1, imageBase64: base64 }),
    /記事IDが不正/
  );
  assert.throws(
    () => saveArticlePreviewFrame(directory, articleId, { timeSeconds: 1, imageBase64: "not-base64!" }),
    /画像データが不正/
  );
  assert.equal(readArticlePreviewDataUrl(directory, "../outside"), undefined);

  deleteArticlePreview(directory, articleId);
  assert.equal(readArticlePreviewDataUrl(directory, articleId), undefined);
  console.log("配信AI新聞の放送画面保存テスト成功（JPEG検証・保存・再読込・記事ID保護・削除）");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
