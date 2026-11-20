import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  normalizedRecordingSlug, recordingChannelFolder,
  recordingLibraryDirectories, isRecordingLibraryFileParent
} from "../electron/recording-folders.ts";
import { deleteRecordingFile, listRecordingFiles } from "../electron/recording.ts";
import { listLibrarySessions } from "../electron/library-sessions.ts";

const root = mkdtempSync(join(tmpdir(), "kick-streamer-library-"));
const external = mkdtempSync(join(tmpdir(), "kick-streamer-outside-"));
try {
  assert.equal(normalizedRecordingSlug("DaibutuTV2"), "daibututv2");
  for (const unsafe of ["../someone", "a/b", "a\\b", "COM1/thing", "", "x".repeat(41), null]) {
    assert.throws(() => normalizedRecordingSlug(unsafe), /チャンネル名/, String(unsafe));
  }

  const one = recordingChannelFolder(root, "DaibutuTV2");
  const two = recordingChannelFolder(root, "Other_Streamer");
  const merged = recordingChannelFolder(root, "DaibutuTV2", "composed");
  assert.equal(one, join(root, "Recordings", "daibututv2"));
  assert.equal(two, join(root, "Recordings", "other_streamer"));
  assert.equal(merged, join(root, "CommentVideos", "daibututv2"));
  assert.equal(recordingChannelFolder(root, "daibututv2"), one, "Folder key stays stable after name changes");

  const legacy = join(root, "daibututv2_20261118_120000.mp4");
  const legacyCommentVideo = join(root, "CommentVideos", "other_streamer_20261118_120000_comments.mp4");
  const modern = join(one, "だいぶつ__daibututv2__2026-11-20_19-00-00__LIVE.mp4");
  const other = join(two, "other_streamer_20261120_190000.mp4");
  const composed = join(merged, "だいぶつ__daibututv2__2026-11-20_19-00-00__LIVE_comments.mp4");
  for (const file of [legacy, modern, other, composed, legacyCommentVideo]) writeFileSync(file, Buffer.alloc(1800));
  const paths = listRecordingFiles(root).map(f => f.path);
  assert.equal(paths.length, 5, "新旧の動画とコメント合成を両方一覧へ表示");
  for (const file of [legacy, modern, other, composed, legacyCommentVideo]) {
    assert.ok(paths.includes(file), "録画ライブラリへ残す: " + basename(file));
    assert.equal(isRecordingLibraryFileParent(root, file), true);
  }
  const sessions = listLibrarySessions(root);
  assert.ok(sessions.some(s => s.slug === "daibututv2" && s.videos.some(v => v.path === modern)));
  assert.ok(sessions.some(s => s.slug === "other_streamer" && s.videos.some(v => v.path === other)));

  const nestedUnknown = join(root, "SecretData");
  mkdirSync(nestedUnknown);
  const ignored = join(nestedUnknown, "sample_20261118_130000.mp4");
  writeFileSync(ignored, Buffer.alloc(1800));
  assert.ok(!listRecordingFiles(root).some(f => f.path === ignored), "無関係のフォルダーは走査しない");
  assert.throws(() => deleteRecordingFile(root, ignored, () => false), /場所/, "無関係の動画は削除対象にしない");

  const chat = join(root, "Chat", "daibututv2");
  mkdirSync(chat, { recursive: true });
  const protectedFile = join(chat, "sample_20261118_130000.mp4");
  writeFileSync(protectedFile, Buffer.alloc(1800));
  assert.throws(() => deleteRecordingFile(root, protectedFile, () => false), /場所/, "コメントフォルダーの内容は録画削除から守る");

  assert.throws(() => deleteRecordingFile(root, modern, () => true), /録画中/, "録画中の配信ファイルは削除できない");
  assert.deepEqual(deleteRecordingFile(root, modern, () => false), { ok: true, name: basename(modern) });
  assert.equal(existsSync(modern), false, "新ディレクトリの動画だけ削除");
  assert.equal(existsSync(legacy), true, "旧保存先の動画は変更しない");
  assert.equal(existsSync(composed), true, "合成ファイルを削除せず維持する");

  const externalFile = join(external, "outside.mp4");
  writeFileSync(externalFile, Buffer.alloc(1800));
  assert.throws(() => deleteRecordingFile(root, externalFile, () => false), /場所/);
  const maliciousRoot = mkdtempSync(join(root, "unsafe-"));
  try {
    mkdirSync(join(maliciousRoot, "Recordings"));
    const badFolder = join(maliciousRoot, "Recordings", "bad");
    try {
      symlinkSync(external, badFolder, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => recordingChannelFolder(maliciousRoot, "bad"), /通常のフォルダー/,
        "シンボリックリンクの配信者フォルダーを拒否");
      assert.ok(!recordingLibraryDirectories(maliciousRoot).includes(badFolder));
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  } finally {
    rmSync(maliciousRoot, { recursive: true, force: true });
  }

  const recordingSource = readFileSync(new URL("../electron/recording.ts", import.meta.url), "utf8");
  const vodSource = readFileSync(new URL("../electron/vod-download-queue.ts", import.meta.url), "utf8");
  const composeSource = readFileSync(new URL("../electron/comment-video.ts", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
  assert.match(recordingSource, /const videoDirectory = recordingChannelFolder\(outputDirectory, slug\)/);
  assert.match(recordingSource, /join\(session\.outputDirectory, "RecordingSessions"\)/,
    "旧セッション情報はそのままルートへ保存して照合できる");
  assert.match(vodSource, /recordingChannelFolder\(directory, item\.slug\)/,
    "VOD一括取得も配信者別フォルダーに出力");
  assert.match(composeSource, /recordingChannelFolder\(directory, slug, "composed"\)/,
    "コメント付き動画も配信者別に出力");
  assert.match(appSource, /動画：Recordings\/\{group\.slug\}/,
    "ライブラリのカードに保存先を表示");
  assert.match(appSource, /保存先を開く/,
    "配信者フォルダーへエクスプローラーから移動できる");
  console.log("Kick録画ライブラリ：配信者別フォルダー・旧動画互換・VOD/合成・削除保護テスト成功");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
}
