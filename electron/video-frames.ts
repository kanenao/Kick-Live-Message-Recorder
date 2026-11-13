import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isPathInsideDirectory } from "./recording";

export type VideoFrameSample = {
  timeSeconds: number;
  imageBase64: string;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);

function findTool(executable: "ffmpeg.exe" | "ffprobe.exe" | "ffmpeg" | "ffprobe"): string {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : process.cwd();
  const candidates = [
    join(resources, "tools", executable),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable),
    executable
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? executable;
}

function runTool(executable: string, args: string[], timeoutMs: number, captureStdout: boolean): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"] });
    } catch (error) {
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(stdout.trim());
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("映像フレーム抽出ツールがタイムアウトしました。"));
    }, timeoutMs);

    if (captureStdout) {
      child.stdout?.on("data", chunk => {
        stdout = (stdout + String(chunk)).slice(0, 20_000);
      });
    }
    child.stderr?.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-3000);
    });
    child.once("error", error => finish(new Error(`映像解析ツールを起動できません：${error.message}`)));
    child.once("close", code => {
      if (code === 0) finish();
      else finish(new Error(`映像解析ツールが終了コード ${code ?? "不明"} で停止しました。${stderr ? " " + stderr : ""}`));
    });
  });
}

function validateArticleVideoPath(videoPathInput: string, outputDirectoryInput: string): string {
  if (typeof videoPathInput !== "string" || !videoPathInput.trim()) {
    throw new Error("解析する録画動画を選択してください。");
  }
  const root = resolve(outputDirectoryInput);
  const videoPath = resolve(videoPathInput);
  if (!isPathInsideDirectory(videoPath, root) || !VIDEO_EXTENSIONS.has(extname(videoPath).toLowerCase())) {
    throw new Error("解析には録画ライブラリ内の動画を選択してください。");
  }
  let fileStats;
  try {
    fileStats = lstatSync(videoPath);
  } catch {
    throw new Error("解析する録画動画が見つかりません。");
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || !statSync(videoPath).size) {
    throw new Error("解析する録画動画が通常のファイルではないか、空です。");
  }
  return videoPath;
}

async function probeVideoDuration(videoPath: string): Promise<number> {
  const ffprobe = findTool(process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const durationText = await runTool(ffprobe, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", videoPath
  ], 20_000, true);
  const duration = Number(durationText);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("動画の再生時間を取得できません。FFprobeで動画を読み取れるか確認してください。");
  }
  return duration;
}

export async function getVideoDurationSeconds(videoPathInput: string, outputDirectoryInput: string): Promise<number> {
  const videoPath = validateArticleVideoPath(videoPathInput, outputDirectoryInput);
  return probeVideoDuration(videoPath);
}

export async function extractVideoFrames(videoPathInput: string, outputDirectoryInput: string): Promise<VideoFrameSample[]> {
  const videoPath = validateArticleVideoPath(videoPathInput, outputDirectoryInput);
  const duration = await probeVideoDuration(videoPath);
  const ffmpeg = findTool(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

  // Long videos get more evenly distributed samples, capped at eight frames.
  const frameCount = Math.min(8, Math.max(3, Math.ceil(duration / 90)));
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kick-article-frames-"));
  const frames: VideoFrameSample[] = [];
  try {
    for (let index = 0; index < frameCount; index += 1) {
      const timeSeconds = Math.max(0, Math.min(duration - 0.1, duration * ((index + 0.5) / frameCount)));
      const framePath = join(temporaryDirectory, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      await runTool(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", timeSeconds.toFixed(3), "-i", videoPath,
        "-map", "0:v:0", "-frames:v", "1",
        "-vf", "scale=w='min(960,iw)':h=-2",
        "-q:v", "6", framePath
      ], 60_000, false);
      if (!existsSync(framePath)) continue;
      const frameStats = statSync(framePath);
      if (!frameStats.isFile() || frameStats.size < 100 || frameStats.size > 3_000_000) continue;
      frames.push({ timeSeconds: Math.round(timeSeconds), imageBase64: readFileSync(framePath).toString("base64") });
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  if (frames.length === 0) {
    throw new Error("動画から解析用の画像を抽出できませんでした。動画形式やFFmpegの対応状況を確認してください。");
  }
  return frames;
}
