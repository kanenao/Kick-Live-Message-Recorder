import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { recordingThumbnailSource } from "./recording-thumbnails";

const execFileAsync = promisify(execFile);
const MAX_FRAMES = 30;
const MAX_FRAME_BYTES = 170_000;
const MAX_CACHE_FOLDERS = 80;

export type RecordingStoryboardFrame = { timeSeconds: number; imageDataUrl: string };
export type RecordingStoryboard = {
  durationSeconds: number;
  frames: RecordingStoryboardFrame[];
};

/** Sample the entire recording, not just its first few minutes. */
export function planStoryboardTimes(durationSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 14 * 24 * 3600) return [];
  // Long VODs get a filmstrip like the Nico live journal (up to 30 images).
  const count = Math.min(MAX_FRAMES, Math.max(6, Math.ceil(durationSeconds / 420)));
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const seconds = Math.round(Math.max(0, Math.min(
      durationSeconds - 0.05, durationSeconds * (i + 0.5) / count
    )) * 10) / 10;
    if (values.at(-1) !== seconds) values.push(seconds);
  }
  return values;
}

function bundledTool(executable: "ffmpeg" | "ffprobe"): string {
  const name = executable + (process.platform === "win32" ? ".exe" : "");
  return [
    ...(typeof process.resourcesPath === "string" ? [join(process.resourcesPath, "tools", name)] : []),
    join(process.cwd(), "vendor", "win-x64", name),
    join(process.cwd(), "vendor", name),
  ].find(path => existsSync(path)) ?? name;
}

function readJpeg(filePath: string): string | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 200 || stat.size > MAX_FRAME_BYTES) return null;
    const bytes = readFileSync(filePath);
    if (bytes[0] !== 255 || bytes[1] !== 216 ||
        bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return null;
    return "data:image/jpeg;base64," + bytes.toString("base64");
  } catch {
    return null;
  }
}

function trimOldStoryboards(root: string): void {
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map(entry => ({ name: entry.name, modifiedAt: statSync(join(root, entry.name)).mtimeMs }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    for (const dir of dirs.slice(MAX_CACHE_FOLDERS)) {
      try { rmSync(join(root, dir.name), { recursive: true, force: true }); } catch { /* preserve recordings */ }
    }
  } catch { /* a cache failure must not affect the video library */ }
}

const inFlight = new Map<string, Promise<RecordingStoryboard>>();

export async function recordingVideoStoryboard(
  outputDirectory: string,
  cacheDirectory: string,
  input: unknown,
  isRecording: (path: string) => boolean
): Promise<RecordingStoryboard> {
  const source = recordingThumbnailSource(outputDirectory, input);
  if (!source) throw new Error("動画が見つからないか、録画ライブラリ外のファイルです。");
  if (isRecording(source.path)) throw new Error("録画中の動画は完了後に場面プレビューを生成できます。");

  const key = createHash("sha256").update(
    [source.path, source.size, source.mtimeMs, "storyboard-v1"].join("\u0000")
  ).digest("hex");
  const processing = inFlight.get(key);
  if (processing) return processing;

  const run = async (): Promise<RecordingStoryboard> => {
    const ffprobe = bundledTool("ffprobe");
    let duration: number;
    try {
      const probe = await execFileAsync(ffprobe, [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", source.path
      ], { timeout: 20_000, windowsHide: true, maxBuffer: 10_000 });
      duration = Number(probe.stdout.trim());
    } catch {
      throw new Error("動画の再生時間を取得できません。FFprobeが利用できるか確認してください。");
    }
    const times = planStoryboardTimes(duration);
    if (!times.length) throw new Error("動画の再生時間が不正なため、場面プレビューを作れません。");
    const ffmpeg = bundledTool("ffmpeg");
    const root = join(cacheDirectory, "recording-storyboards");
    const folder = join(root, key);
    mkdirSync(folder, { recursive: true });
    const frames: RecordingStoryboardFrame[] = [];
    for (let index = 0; index < times.length; index++) {
      if (!recordingThumbnailSource(outputDirectory, source.path) || isRecording(source.path)) {
        throw new Error("動画が移動されたか録画が開始されたため、場面抽出を中断しました。");
      }
      const timeSeconds = times[index];
      const target = join(folder, String(index).padStart(3, "0") + ".jpg");
      let imageDataUrl = readJpeg(target);
      if (!imageDataUrl) {
        try {
          await execFileAsync(ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-ss", timeSeconds.toFixed(1), "-i", source.path,
            "-map", "0:v:0", "-frames:v", "1",
            "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
            "-q:v", "7", target
          ], { timeout: 25_000, windowsHide: true, maxBuffer: 64 * 1024 });
          imageDataUrl = readJpeg(target);
        } catch {
          // A corrupt interval should not stop thumbnails from other time ranges.
        }
      }
      if (imageDataUrl) frames.push({ timeSeconds, imageDataUrl });
      else try { unlinkSync(target); } catch { /* missing or invalid cache image */ }
    }
    if (!frames.length) {
      throw new Error("場面画像を抽出できませんでした。録画ファイルとFFmpegを確認してください。");
    }
    trimOldStoryboards(root);
    return { durationSeconds: Math.round(duration), frames };
  };

  const promise = run();
  inFlight.set(key, promise);
  try { return await promise; }
  finally { inFlight.delete(key); }
}
