import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingThumbnailSource, thumbnailCacheName, recordingVideoThumbnail } from "../electron/recording-thumbnails.ts";

const directory = mkdtempSync(join(tmpdir(), "kick-thumb-test-"));
const outside = mkdtempSync(join(tmpdir(), "kick-thumb-outside-"));
try {
  const video = join(directory, "recording.mp4");
  writeFileSync(video, Buffer.alloc(4096));
  const info = recordingThumbnailSource(directory, video);
  assert.ok(info && info.size === 4096, "Valid local recording must be accepted");
  assert.match(thumbnailCacheName(info), /^[a-f0-9]{64}\.jpg$/, "Cache names should not leak user paths");
  assert.equal(thumbnailCacheName(info), thumbnailCacheName(info), "Thumbnail cache key should be stable");
  assert.notEqual(thumbnailCacheName({ ...info, mtimeMs: info.mtimeMs + 1 }),
    thumbnailCacheName(info), "Updating a video should invalidate the old thumbnail");

  assert.equal(recordingThumbnailSource(directory, join(outside, "outside.mp4")), null,
    "Absolute paths outside the library must be rejected");
  assert.equal(recordingThumbnailSource(directory, join(directory, "..", "escape.mp4")), null,
    "Path traversal must be rejected");
  assert.equal(recordingThumbnailSource(directory, join(directory, "unknown.txt")), null,
    "Non-video files must be rejected");
  assert.equal(recordingThumbnailSource(directory, 123), null,
    "Invalid renderer input must be rejected");

  const link = join(directory, "linked.mp4");
  try {
    symlinkSync(video, link, "file");
    assert.equal(recordingThumbnailSource(directory, link), null,
      "Symbolic links must not be treated as local recordings");
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  const linkedFolder = join(directory, "linked-folder");
  try {
    mkdirSync(outside, { recursive: true });
    const outsideVideo = join(outside, "outside.mp4");
    writeFileSync(outsideVideo, Buffer.alloc(4096));
    symlinkSync(outside, linkedFolder, process.platform === "win32" ? "junction" : "dir");
    assert.equal(recordingThumbnailSource(directory, join(linkedFolder, "outside.mp4")), null,
      "Symlinked parent folders outside the recording directory must be blocked");
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }

  assert.equal(await recordingVideoThumbnail(directory, join(directory, "cache"), video, () => true), null,
    "Active recordings must not trigger FFmpeg thumbnail extraction");
  assert.equal(statSync(video).size, 4096, "Thumbnail inspection must not modify the source video");
} finally {
  rmSync(directory, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
console.log("動画サムネイルの保存先検証・キャッシュ・録画中保護テスト成功");
