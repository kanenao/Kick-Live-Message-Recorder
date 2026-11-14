import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVideoTimelineAnchor } from "../electron/recording-timeline.ts";

const root = mkdtempSync(join(tmpdir(), "kick-recorder-timeline-test-"));
const metadataDirectory = join(root, "RecordingMetadata");
mkdirSync(metadataDirectory, { recursive: true });

function writeMetadata(videoBase, value) {
  writeFileSync(
    join(metadataDirectory, videoBase + ".json"),
    JSON.stringify(value),
    "utf8"
  );
}

function makeMetadata(videoBase, overrides = {}) {
  return {
    schemaVersion: 1,
    channelSlug: "samplechannel",
    recordingKind: "LIVE",
    filePrefix: videoBase,
    recordingStartedAt: "2026-11-14T03:04:05.000Z",
    recordingStartedAtEpochMs: Date.parse("2026-11-14T03:04:05.000Z"),
    timestampSource: "yt-dlp-process-spawn",
    ...overrides
  };
}

try {
  const expectedStart = Date.parse("2026-11-14T03:04:05.000Z");
  const liveBase = "samplechannel_20261114_030400";
  const liveVideo = join(root, liveBase + ".mp4");
  writeMetadata(liveBase, makeMetadata(liveBase));

  const metadataResult = resolveVideoTimelineAnchor(
    liveVideo, root, expectedStart + 120_000, 120, "SAMPLECHANNEL"
  );
  assert.deepEqual(metadataResult, {
    startMs: expectedStart,
    source: "recording-metadata"
  }, "valid metadata must take priority over the filename and file mtime");

  const isoOnlyBase = "samplechannel_20261114_030500";
  writeMetadata(isoOnlyBase, makeMetadata(isoOnlyBase, {
    recordingStartedAtEpochMs: null
  }));
  const isoResult = resolveVideoTimelineAnchor(
    join(root, isoOnlyBase + ".mp4"), root, expectedStart + 180_000, 120, "samplechannel"
  );
  assert.equal(isoResult.startMs, expectedStart, "ISO timestamp fallback must be supported");
  assert.equal(isoResult.source, "recording-metadata");

  const wrongChannelBase = "samplechannel_20261114_030600";
  writeMetadata(wrongChannelBase, makeMetadata(wrongChannelBase, {
    channelSlug: "anotherchannel"
  }));
  const filenameStart = new Date(2026, 10, 14, 3, 6, 0).getTime();
  const wrongChannelResult = resolveVideoTimelineAnchor(
    join(root, wrongChannelBase + ".mp4"), root, expectedStart + 240_000, 120, "samplechannel"
  );
  assert.deepEqual(wrongChannelResult, {
    startMs: filenameStart,
    source: "filename"
  }, "metadata from another channel must be rejected");

  const wrongPrefixBase = "samplechannel_20261114_030700";
  writeMetadata(wrongPrefixBase, makeMetadata(wrongPrefixBase, {
    filePrefix: "unrelated_20261114_030700"
  }));
  const wrongPrefixResult = resolveVideoTimelineAnchor(
    join(root, wrongPrefixBase + ".mp4"), root, expectedStart + 300_000, 120, "samplechannel"
  );
  assert.equal(wrongPrefixResult.source, "filename", "metadata for another video must be rejected");

  const renamedBase = "manually-renamed-video";
  writeMetadata(renamedBase, { invalid: true });
  const modifiedAt = Date.parse("2026-11-14T05:00:00.000Z");
  const mtimeResult = resolveVideoTimelineAnchor(
    join(root, renamedBase + ".mp4"), root, modifiedAt, 90, "samplechannel"
  );
  assert.deepEqual(mtimeResult, {
    startMs: modifiedAt - 90_000,
    source: "file-mtime"
  }, "invalid metadata and renamed files must use the mtime fallback");

  const legacyBase = "legacy-video";
  const legacyResult = resolveVideoTimelineAnchor(
    join(root, legacyBase + ".mp4"), root, modifiedAt, 45, "samplechannel"
  );
  assert.deepEqual(legacyResult, {
    startMs: modifiedAt - 45_000,
    source: "file-mtime"
  }, "videos without metadata must remain compatible");

  const vodBase = "samplechannel_VOD_20261114_030800";
  writeMetadata(vodBase, makeMetadata(vodBase, { recordingKind: "VOD" }));
  const vodResult = resolveVideoTimelineAnchor(
    join(root, vodBase + ".mp4"), root, modifiedAt, 60, "samplechannel"
  );
  assert.deepEqual(vodResult, {
    startMs: new Date(2026, 10, 14, 3, 8, 0).getTime(),
    source: "filename"
  }, "VOD metadata must not be treated as a LIVE recording anchor");

  const invalidDateBase = "samplechannel_20261340_256199";
  const invalidDateResult = resolveVideoTimelineAnchor(
    join(root, invalidDateBase + ".mp4"), root, modifiedAt, 75, "samplechannel"
  );
  assert.deepEqual(invalidDateResult, {
    startMs: modifiedAt - 75_000,
    source: "file-mtime"
  }, "invalid filename timestamps must fall back to file mtime");

  const corruptBase = "corrupt-video";
  writeFileSync(join(metadataDirectory, corruptBase + ".json"), "{ broken", "utf8");
  const corruptResult = resolveVideoTimelineAnchor(
    join(root, corruptBase + ".mp4"), root, modifiedAt, 30, "samplechannel"
  );
  assert.equal(corruptResult.startMs, modifiedAt - 30_000);
  assert.equal(corruptResult.source, "file-mtime", "corrupt metadata must not break preview or generation");

  console.log("録画タイムライン同期テスト成功（メタデータ優先・チャンネル照合・旧動画フォールバック）");
} finally {
  rmSync(root, { recursive: true, force: true });
}
