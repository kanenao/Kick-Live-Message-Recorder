import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { broadcastFileStem } from "../electron/recording-filenames.ts";
import { regenerateSavedVodAss, resolveSavedVodJsonl } from "../electron/vod-ass-reexport.ts";

const root = mkdtempSync(join(tmpdir(), "kick-ass-reexport-test-"));
try {
  const slug = "sample";
  const channel = join(root, "Chat", slug);
  mkdirSync(channel, { recursive: true });
  const base = broadcastFileStem({
    slug, displayName: "テスト配信者", kind: "VOD",
    startedAt: "2026-11-18T10:00:00.000Z",
    videoId: "11223344-5566-7788-99aa-bbccddeeff00"
  });
  const source = join(channel, base + ".jsonl");
  const lines = [
    { content: "こんにちは [emote:123:Nice]", timeInSeconds: 5 },
    { content: "ニコ生風テスト", timeInSeconds: 5.5 },
    { content: "[emote:123:Nice]", timeInSeconds: 6 },
    { content: "最後のコメント", timeInSeconds: 30 }
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  writeFileSync(source, lines);
  assert.equal(resolveSavedVodJsonl(source, root).slug, slug);
  const first = await regenerateSavedVodAss(source, root, true, { autoFlow: false, rowLimit: 8 });
  assert.equal(first.validComments, 4);
  assert.equal(first.generatedComments, 3);
  assert.equal(first.skippedComments, 1);
  assert.ok(first.outputPath.endsWith("_nico-manual.ass"));
  const body = readFileSync(first.outputPath, "utf8");
  assert.ok(body.includes("こんにちは"));
  assert.ok(!body.includes("Nice"));
  assert.ok(body.includes("Dialogue: 0,0:00:30.00"), "最終コメントが出力される");
  assert.equal(readFileSync(source, "utf8"), lines, "元のJSONLを保持");
  const second = await regenerateSavedVodAss(source, root, false, { autoFlow: true });
  assert.ok(second.outputPath.endsWith("_nico-auto.ass"));
  assert.ok(readFileSync(second.outputPath, "utf8").includes("Nice"), "emoteのON/OFFが反映される");
  const third = await regenerateSavedVodAss(source, root, true, { autoFlow: true });
  assert.notEqual(third.outputPath, second.outputPath, "同じモードで再生成しても上書きしない");
  assert.ok(existsSync(second.outputPath), "前回のASSを残す");

  const liveSource = join(channel, base.replace("__VOD_", "__LIVE_") + ".jsonl");
  writeFileSync(liveSource, lines);
  assert.throws(() => resolveSavedVodJsonl(liveSource, root), /VOD/);
  assert.throws(() => resolveSavedVodJsonl(join(root, "outside.jsonl"), root), /VOD/);
  assert.throws(() => resolveSavedVodJsonl(join(channel, "..", "..", "outside.jsonl"), root), /VOD/);
  const bad = join(channel, base + "_take2.jsonl");
  writeFileSync(bad, '{"content":"テスト","timeInSeconds":30}\n{"content":"逆転","timeInSeconds":2}\n');
  await assert.rejects(regenerateSavedVodAss(bad, root), /時刻順/);
  const badEmpty = join(channel, base + "_take3.jsonl");
  writeFileSync(badEmpty, "not a JSON record\n");
  await assert.rejects(regenerateSavedVodAss(badEmpty, root), /変換できる/);
  const link = join(channel, base + "_take4.jsonl");
  try {
    symlinkSync(source, link);
    assert.throws(() => resolveSavedVodJsonl(link, root), /不正/);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
  assert.ok(readdirSync(channel).filter(name => name.endsWith(".ass")).length >= 3);
  console.log("保存済みVODからのオフラインASS再生成・emote・非上書き・パス安全性・時刻順テスト成功");
} finally {
  rmSync(root, { recursive: true, force: true });
}
