import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseBroadcastFileStem } from "./recording-filenames";

/** Resolve a stable channel slug from either new or legacy recording names. */
export function recordingChannelFromFileName(fileName: string): string | null {
  if (typeof fileName !== "string" || fileName.length > 260 || /[\\/]/.test(fileName)) return null;
  const modern = parseBroadcastFileStem(fileName);
  if (modern) return modern.slug;
  const base = fileName.replace(/\.[^.]+$/, "");
  const normal = base.match(/^([a-zA-Z0-9_-]{1,40})(?:_VOD)?_\d{8}_\d{6}(?:_retry\d+)?(?:_comments(?:_\d+)?)?$/i);
  const batch = base.match(/^([a-zA-Z0-9_-]{1,40})_VOD_[a-f0-9-]{20,40}_.+$/i);
  const fallback = !/_\d{8}(?:_|$)/.test(base) ? base.match(/^([a-zA-Z0-9_-]{1,40})$/) : null;
  return (normal?.[1] ?? batch?.[1] ?? fallback?.[1])?.toLowerCase() ?? null;
}

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

/**
 * Recognize only the documented video storage layout without walking every
 * broadcaster folder. Reject symlinked/junction directories even if the final
 * file happens to resolve under the user's output root.
 */
export function isRecordingLibraryFileParent(outputDirectory: string, filePath: string): boolean {
  const root = resolve(outputDirectory);
  const parent = resolve(dirname(filePath));
  const samePath = (a: string, b: string) => process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!regularDirectory(root)) return false;
  if (samePath(parent, root)) return true; // recordings from old α/β releases

  const composed = join(root, COMPOSED_FOLDER);
  if (samePath(parent, composed)) return regularDirectory(composed); // old composed videos

  for (const type of [RECORDINGS_FOLDER, COMPOSED_FOLDER]) {
    const base = join(root, type);
    if (!samePath(resolve(dirname(parent)), base)) continue;
    const slug = parent.slice(base.length + 1);
    return /^[a-zA-Z0-9_-]{1,40}$/.test(slug) &&
      regularDirectory(base) && regularDirectory(parent);
  }
  return false;
}
