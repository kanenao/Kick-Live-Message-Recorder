import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateStreamArticle, listStreamArticles } from "../electron/articles.ts";

const root = mkdtempSync(join(tmpdir(), "kick-ai-news-history-"));
try {
  const videoDir = join(root, "Recordings", "sample");
  mkdirSync(videoDir, { recursive: true });
  const videoPath = join(videoDir, "配信者__sample__2026-11-18_19-00-00__LIVE.mp4");
  writeFileSync(videoPath, "not-a-real-video");
  const input = { videoPath, slug: "sample", displayName: "配信者", headline: "記事の初回版" };
  const first = await generateStreamArticle(input, root);
  assert.equal(first.status, "completed");
  assert.equal(first.headline, "記事の初回版");
  const firstFile = join(root, "Articles", "sample", first.id + ".json");
  const preserved = readFileSync(firstFile, "utf8");
  const second = await generateStreamArticle({ ...input, headline: "記事の再生成版" }, root);
  assert.notEqual(second.id, first.id, "再生成した記事には別のIDを割り当てる");
  assert.ok(second.id.startsWith(first.id + "_rev"), "追加版の識別子が付く");
  assert.equal(readFileSync(firstFile, "utf8"), preserved, "初回の記事を一切書き換えない");
  assert.ok(existsSync(join(root, "Articles", "sample", second.id + ".json")));
  assert.deepEqual(new Set(listStreamArticles(root, "sample").map(a => a.id)), new Set([first.id, second.id]));
  console.log("配信AI新聞：再生成時の上書き防止・履歴保持・記事一覧テスト成功");
} finally {
  rmSync(root, { recursive: true, force: true });
}
