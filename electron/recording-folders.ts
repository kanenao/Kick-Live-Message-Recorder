import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const RECORDINGS_FOLDER = "Recordings";
export const COMPOSED_FOLDER = "CommentVideos";

/** Stable slug-based paths survive a broadcaster's Kick display-name changes. */
export function normalizedRecordingSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value)) {
    throw new Error("配信者のチャンネル名が正しくありません。");
  }
  return value.toLowerCase();
}

function regularDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

function ensureRegularDirectory(path: string): void {
  if (!regularDirectory(path)) {
    // No directory symlinks or junctions: do not let the renderer's channel
    // name redirect a recording into another location.
    try { mkdirSync(path); } catch { /* handle below, including EEXIST */ }
    if (!regularDirectory(path)) {
      throw new Error("保存先フォルダーが通常のフォルダーではありません：" + path);
    }
  }
}

export function recordingChannelFolder(
  outputDirectory: string,
  slug: unknown,
  kind: "recording" | "composed" = "recording"
): string {
  const channel = normalizedRecordingSlug(slug);
  const root = resolve(outputDirectory);
  ensureRegularDirectory(root);
  const parent = join(root, kind === "recording" ? RECORDINGS_FOLDER : COMPOSED_FOLDER);
  ensureRegularDirectory(parent);
  const folder = join(parent, channel);
  ensureRegularDirectory(folder);
  return folder;
}

/**
 * Only enumerate explicitly supported, one-level directories:
 * legacy <root>/*.mp4, legacy CommentVideos/*.mp4, and
 * Recordings/<slug>/*.mp4 / CommentVideos/<slug>/*.mp4.
 * Never recursively walk arbitrary user folders or symbolic links.
 */
export function recordingLibraryDirectories(outputDirectory: string): string[] {
  const root = resolve(outputDirectory);
  if (!regularDirectory(root)) return [];
  const directories = [root];
  for (const parentName of [RECORDINGS_FOLDER, COMPOSED_FOLDER]) {
    const parent = join(root, parentName);
    if (!regularDirectory(parent)) continue;
    if (parentName === COMPOSED_FOLDER) directories.push(parent);
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true }).slice(0, 2000)) {
        if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,40}$/.test(entry.name)) continue;
        const folder = join(parent, entry.name);
        if (regularDirectory(folder)) directories.push(folder);
      }
    } catch { /* Folder may be removed while the library refreshes. */ }
  }
  return directories;
}

export function isRecordingLibraryFileParent(outputDirectory: string, filePath: string): boolean {
  const parent = resolve(dirname(filePath));
  return recordingLibraryDirectories(outputDirectory).some(folder => resolve(folder) === parent);
}
