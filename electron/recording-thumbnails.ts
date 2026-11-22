import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isRecordingLibraryFileParent } from "./recording-folders";

const execFileAsync = promisify(execFile);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
const MAX_IMAGE_BYTES = 220_000;
const MAX_CACHE_FILES = 500;

function isUnder(candidate: string, root: string): boolean {
  const folder = resolve(root);
  const path = resolve(candidate);
  return path.startsWith(folder + sep);
}

export function recordingThumbnailSource(outputDirectory: string, input: unknown): {
  path: string; size: number; mtimeMs: number
} | null {
  if (typeof input !== "string" || input.length > 4096) return null;
  const root = resolve(outputDirectory);
  const path = resolve(input);
  if (!isUnder(path, root) || !VIDEO_EXTENSIONS.has(extname(path).toLowerCase()) ||
      !isRecordingLibraryFileParent(root, path)) return null;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1024) return null;
    // Refuse a symlinked parent directory that escapes the recording root.
    if (!isUnder(realpathSync(path), realpathSync(root))) return null;
    return { path, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch { return null; }
}

export function thumbnailCacheName(source: { path: string; size: number; mtimeMs: number }): string {
  return createHash("sha256")
    .update([source.path, source.size, source.mtimeMs].join("\u0000"))
    .digest("hex") + ".jpg";
}

function locateFfmpeg(): string | null {
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [join(process.resourcesPath, "tools", executable)] : []),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable)
  ];
  return candidates.find(path => existsSync(path)) ?? null;
}

function trimThumbnailCache(cacheDirectory: string): void {
  try {
    const files = readdirSync(cacheDirectory)
      .filter(name => /^[a-f0-9]{64}\.jpg$/.test(name))
      .map(name => ({ name, mtime: statSync(join(cacheDirectory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(MAX_CACHE_FILES)) {
      try { unlinkSync(join(cacheDirectory, file.name)); } catch { /* best effort */ }
    }
  } catch { /* thumbnail cleanup must not affect recordings */ }
}

const pending = new Map<string, Promise<string | null>>();
let lastCacheTrim = 0;

export async function recordingVideoThumbnail(
  outputDirectory: string, cacheDirectory: string, input: unknown, isRecording: (path: string) => boolean
): Promise<string | null> {
  const source = recordingThumbnailSource(outputDirectory, input);
  if (!source || isRecording(source.path)) return null;
  const ffmpeg = locateFfmpeg();
  const targetDirectory = join(cacheDirectory, "recording-thumbnails");
  const cacheFile = join(targetDirectory, thumbnailCacheName(source));

  const readCached = (): string | null => {
    try {
      const stats = lstatSync(cacheFile);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1024 || stats.size > MAX_IMAGE_BYTES) return null;
      return "data:image/jpeg;base64," + readFileSync(cacheFile).toString("base64");
    } catch { return null; }
  };
  const existing = readCached();
  if (existing) return existing;
  if (!ffmpeg) return null;
  const inProgress = pending.get(cacheFile);
  if (inProgress) return inProgress;

  const promise = (async () => {
    try {
      mkdirSync(targetDirectory, { recursive: true });
      // A low resolution still from the user's saved video. Never download
      // stock images or use Kick's unrelated stream preview as a replacement.
      const args = [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-ss", "00:00:01", "-i", source.path,
        "-frames:v", "1", "-vf",
        "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
        "-q:v", "5", "-y", cacheFile
      ];
      await execFileAsync(ffmpeg, args, { timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 });
      // The source may have been moved or removed during frame extraction.
      if (!recordingThumbnailSource(outputDirectory, source.path)) return null;
      if (Date.now() - lastCacheTrim > 10 * 60 * 1000) {
        lastCacheTrim = Date.now();
        trimThumbnailCache(targetDirectory);
      }
      return readCached();
    } catch {
      // Corrupt/unfinished recordings must display a placeholder, not crash
      // the entire recording library.
      try { unlinkSync(cacheFile); } catch { /* ignore */ }
      return null;
    }
  })();
  pending.set(cacheFile, promise);
  try { return await promise; } finally { pending.delete(cacheFile); }
}
