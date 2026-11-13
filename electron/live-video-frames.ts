import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VideoFrameSample } from "./video-frames";

export type LiveVideoFrameStatus = {
  status: "starting" | "capturing" | "completed" | "stopped" | "error";
  frameCount: number;
  message: string;
};

function findTool(executable: "ffmpeg.exe" | "ffmpeg" | "yt-dlp.exe" | "yt-dlp"): string {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : process.cwd();
  const candidates = [
    join(resources, "tools", executable),
    join(process.cwd(), "vendor", "win-x64", executable),
    join(process.cwd(), "vendor", executable),
    executable
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? executable;
}

function resolveLiveStreamUrl(slug: string, isCancelled: () => boolean): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const channelUrl = "https://kick.com/" + encodeURIComponent(slug);
    const child = spawn(findTool(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"), [
      "--no-warnings", "--no-playlist", "--format", "best", "--get-url", channelUrl
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("LIVE映像の接続先URL取得がタイムアウトしました。"));
    }, 40_000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else {
        const candidate = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
        let parsed: URL;
        try { parsed = new URL(candidate); } catch {
          rejectPromise(new Error("KickのLIVE映像URLを取得できませんでした。配信が公開中か確認してください。"));
          return;
        }
        if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
          rejectPromise(new Error("Kickから安全でないLIVE映像URLが返されました。"));
          return;
        }
        resolvePromise(parsed.toString());
      }
    };
    child.stdout?.on("data", chunk => {
      stdout = (stdout + String(chunk)).slice(0, 20_000);
    });
    child.stderr?.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-3000);
    });
    child.once("error", error => finish(new Error("yt-dlpを起動できません：" + error.message)));
    child.once("close", code => {
      if (isCancelled()) return finish(new Error("LIVE映像の取得を停止しました。"));
      if (code === 0) finish();
      else finish(new Error("KickのLIVE映像URL取得に失敗しました。" + (stderr ? " " + stderr.slice(-800) : "")));
    });
  });
}

/**
 * Decodes a live HLS stream without saving a full recording.
 * Only sampled JPEG frames are emitted; the stream process is stopped after eight frames or on cancel.
 */
export function startLiveVideoFrameCapture(
  slugInput: string,
  onFrame: (frame: VideoFrameSample) => void,
  onStatus: (status: LiveVideoFrameStatus) => void
): () => void {
  if (typeof slugInput !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(slugInput)) {
    throw new Error("LIVE映像を解析するKickチャンネル名が不正です。");
  }
  const slug = slugInput.toLowerCase();
  let cancelled = false;
  let finished = false;
  let ffmpegChild: ChildProcess | null = null;
  const frames: VideoFrameSample[] = [];
  const publish = (status: LiveVideoFrameStatus["status"], message: string): void => {
    onStatus({ status, frameCount: frames.length, message });
  };
  const stop = (): void => {
    if (cancelled) return;
    cancelled = true;
    ffmpegChild?.kill();
    if (!finished) publish("stopped", "LIVE映像の取得を停止しました。");
  };

  publish("starting", "録画せずにLIVE映像の解析接続を準備しています。");
  void (async () => {
    try {
      const streamUrl = await resolveLiveStreamUrl(slug, () => cancelled);
      if (cancelled) return;
      const ffmpeg = findTool(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
      const child = spawn(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", streamUrl,
        "-an", "-sn", "-dn",
        "-vf", "fps=1/25,scale=w='min(960,iw)':h=-2",
        "-frames:v", "8", "-q:v", "6",
        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      ffmpegChild = child;
      if (cancelled) {
        child.kill();
        return;
      }
      publish("capturing", "LIVE映像から代表フレームを抽出しています。録画ファイルは作成しません。");
      let buffer = Buffer.alloc(0);
      let stderr = "";
      const startedCaptureAt = Date.now();
      child.stdout?.on("data", chunk => {
        if (cancelled || frames.length >= 8) return;
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        if (buffer.length > 12_000_000 && !buffer.includes(Buffer.from([0xff, 0xd8]))) {
          buffer = Buffer.alloc(0);
          return;
        }
        while (!cancelled && frames.length < 8) {
          const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          if (start < 0) {
            buffer = buffer.subarray(Math.max(0, buffer.length - 1));
            break;
          }
          const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
          if (end < 0) {
            if (start > 0) buffer = buffer.subarray(start);
            break;
          }
          const jpeg = buffer.subarray(start, end + 2);
          buffer = buffer.subarray(end + 2);
          if (jpeg.length < 100 || jpeg.length > 3_000_000) continue;
          const frame: VideoFrameSample = {
            timeSeconds: Math.max(0, Math.round((Date.now() - startedCaptureAt) / 1000)),
            imageBase64: jpeg.toString("base64")
          };
          frames.push(frame);
          onFrame(frame);
          publish("capturing", `LIVE映像の代表フレームを取得しました（${frames.length}/8枚）。`);
          if (frames.length >= 8) {
            finished = true;
            child.kill();
            publish("completed", "LIVE映像の代表フレーム8枚を取得しました。");
          }
        }
      });
      child.stderr?.on("data", chunk => {
        stderr = (stderr + String(chunk)).slice(-3000);
      });
      child.once("error", error => {
        if (cancelled || finished) return;
        finished = true;
        publish("error", "FFmpegでLIVE映像を開けませんでした：" + error.message);
      });
      child.once("close", code => {
        if (cancelled || finished) return;
        finished = true;
        if (frames.length > 0) {
          publish("completed", `LIVE映像から${frames.length}枚の代表フレームを取得しました。`);
        } else {
          publish("error", "LIVE映像から画像を取得できませんでした。" + (stderr ? " " + stderr.slice(-800) : ` 終了コード：${code ?? "不明"}`));
        }
      });
    } catch (error) {
      if (cancelled || finished) return;
      finished = true;
      publish("error", error instanceof Error ? error.message : String(error));
    }
  })();

  return stop;
}
