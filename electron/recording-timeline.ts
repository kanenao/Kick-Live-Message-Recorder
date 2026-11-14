import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export type VideoTimelineSyncSource = "recording-metadata" | "filename" | "file-mtime";

export type VideoTimelineAnchor = {
  startMs: number;
  source: VideoTimelineSyncSource;
};

function parseFilenameStartMs(videoBase: string): number {
  const match = videoBase.match(/_(\d{8})_(\d{6})(?:_retry\d+)?$/);
  if (!match) return Number.NaN;
  const stamp = match[1] + match[2];
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6)) - 1;
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(8, 10));
  const minute = Number(stamp.slice(10, 12));
  const second = Number(stamp.slice(12, 14));
  const parsed = new Date(year, month, day, hour, minute, second);
  return parsed.getFullYear() === year && parsed.getMonth() === month &&
    parsed.getDate() === day && parsed.getHours() === hour &&
    parsed.getMinutes() === minute && parsed.getSeconds() === second
    ? parsed.getTime()
    : Number.NaN;
}

export function resolveVideoTimelineAnchor(
  videoPath: string,
  outputDirectory: string,
  videoModifiedAtMs: number,
  durationSeconds: number,
  expectedChannelSlug?: string
): VideoTimelineAnchor {
  const videoBase = basename(videoPath, extname(videoPath));
  const metadataPath = join(resolve(outputDirectory), "RecordingMetadata", videoBase + ".json");
  try {
    if (existsSync(metadataPath)) {
      const metadataStats = lstatSync(metadataPath);
      if (metadataStats.isFile() && !metadataStats.isSymbolicLink()) {
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
        const metadataStartMs = typeof metadata.recordingStartedAtEpochMs === "number" &&
          Number.isFinite(metadata.recordingStartedAtEpochMs)
          ? metadata.recordingStartedAtEpochMs
          : typeof metadata.recordingStartedAt === "string"
            ? Date.parse(metadata.recordingStartedAt)
            : Number.NaN;
        const channelMatches = !expectedChannelSlug ||
          (typeof metadata.channelSlug === "string" &&
            metadata.channelSlug.toLowerCase() === expectedChannelSlug.toLowerCase());
        if (
          metadata.schemaVersion === 1 &&
          metadata.recordingKind === "LIVE" &&
          metadata.filePrefix === videoBase &&
          channelMatches &&
          Number.isFinite(metadataStartMs)
        ) {
          return { startMs: metadataStartMs, source: "recording-metadata" };
        }
      }
    }
  } catch {
    // 古い・破損したメタデータは無視し、従来の時刻推定へフォールバックする。
  }

  const filenameStartMs = parseFilenameStartMs(videoBase);
  if (Number.isFinite(filenameStartMs)) {
    return { startMs: filenameStartMs, source: "filename" };
  }
  return {
    startMs: videoModifiedAtMs - durationSeconds * 1000,
    source: "file-mtime"
  };
}
