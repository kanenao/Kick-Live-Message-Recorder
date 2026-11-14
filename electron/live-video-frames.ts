import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { VideoFrameSample } from "./video-frames";
import { classifyLiveCaptureExit, getLiveAudioCaptureOffsetSeconds, hasLiveAudioCaptureProgressStalled, isPermanentLiveAudioCaptureError, LIVE_AUDIO_CAPTURE_STALL_TIMEOUT_MS, LIVE_AUDIO_CAPTURE_WATCHDOG_INTERVAL_MS, nextLiveAudioCaptureRetryDelayMs } from "./live-capture-policy";

export type LiveAudioChunk = { timeSeconds: number; wavBase64: string };

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

function resolveLiveStreamUrl(slug: string, isCancelled: () => boolean, onChild: (child: ChildProcess) => void): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const channelUrl = "https://kick.com/" + encodeURIComponent(slug);
    const child = spawn(findTool(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"), [
      "--no-warnings", "--no-playlist", "--format", "best", "--get-url", channelUrl
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    onChild(child);
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
 * Only sampled JPEG frames are emitted; callers keep a rolling window and stop the process with the returned callback.
 */
export function startLiveVideoFrameCapture(
  slugInput: string,
  onFrame: (frame: VideoFrameSample) => void,
  onStatus: (status: LiveVideoFrameStatus) => void,
  onAudioChunk?: (chunk: LiveAudioChunk) => void,
  onAudioError?: (message: string) => void,
  initialOffsetSeconds = 0
): () => Promise<void> {
  if (typeof slugInput !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(slugInput)) {
    throw new Error("LIVE映像を解析するKickチャンネル名が不正です。");
  }
  const slug = slugInput.toLowerCase();
  const captureRequestedAt = Date.now();
  const requestedOffsetSeconds = Number.isFinite(initialOffsetSeconds)
    ? Math.max(0, Math.min(7 * 24 * 60 * 60, initialOffsetSeconds))
    : 0;
  let captureOffsetSeconds = requestedOffsetSeconds;
  let cancelled = false;
  let finished = false;
  let resolverChild: ChildProcess | null = null;
  let ffmpegChild: ChildProcess | null = null;
  let audioChild: ChildProcess | null = null;
  let audioResolverChild: ChildProcess | null = null;
  let audioRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let audioRetryResolve: (() => void) | null = null;
  let audioStopped = false;
  let audioGeneration = 0;
  let audioDirectory = "";
  let audioSegmentCount = 0;
  let audioFinishedResolve: (() => void) | null = null;
  let audioFinished: Promise<void> = Promise.resolve();
  const finishAudioCapture = (): void => {
    const resolver = audioFinishedResolve as (() => void) | null;
    audioFinishedResolve = null;
    if (resolver) resolver();
  };
  const stopAudioCapture = (): void => {
    audioStopped = true;
    if (audioRetryTimer) clearTimeout(audioRetryTimer);
    audioRetryTimer = null;
    const resolveRetry = audioRetryResolve;
    audioRetryResolve = null;
    resolveRetry?.();
    audioResolverChild?.kill();
    audioResolverChild = null;
    audioChild?.kill();
  };
  const waitForAudioRetry = (delayMs: number): Promise<void> => new Promise(resolvePromise => {
    if (cancelled || finished || audioStopped) {
      resolvePromise();
      return;
    }
    audioRetryResolve = resolvePromise;
    audioRetryTimer = setTimeout(() => {
      audioRetryTimer = null;
      audioRetryResolve = null;
      resolvePromise();
    }, delayMs);
  });
  const processedAudioFiles = new Set<string>();
  let frameCount = 0;
  const publish = (status: LiveVideoFrameStatus["status"], message: string): void => {
    onStatus({ status, frameCount, message });
  };
  const stop = (): Promise<void> => {
    if (!cancelled) {
      cancelled = true;
      resolverChild?.kill();
      ffmpegChild?.kill();
      stopAudioCapture();
      if (!finished) publish("stopped", "LIVE映像・音声の取得を停止しました。");
    }
    return audioFinished;
  };

  publish("starting", "録画せずにLIVE映像の解析接続を準備しています。");
  void (async () => {
    try {
      const streamUrl = await resolveLiveStreamUrl(slug, () => cancelled, child => { resolverChild = child; });
      resolverChild = null;
      if (cancelled) return;
      // URL解決にかかった時間も加え、手動開始した途中参加LIVEでも配信全体の時刻に合わせる。
      captureOffsetSeconds = requestedOffsetSeconds + (Date.now() - captureRequestedAt) / 1000;
      const ffmpeg = findTool(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

      // 音声は45秒ごとの16kHzモノラルWAVに分割する。音声FFmpegは映像とは独立して
      // 再接続させ、一時切断で音声取得だけが永久停止しないようにする。
      if (onAudioChunk) {
        audioDirectory = mkdtempSync(join(tmpdir(), "kick-live-article-audio-"));
        audioFinished = new Promise<void>(resolvePromise => { audioFinishedResolve = resolvePromise; });
        const flushAudioSegments = (listPath: string, generationOffsetSeconds: number): void => {
          if (!audioDirectory || !existsSync(listPath)) return;
          let entries: string[];
          try { entries = readFileSync(listPath, "utf8").split(/\r?\n/).filter(Boolean); }
          catch { return; }
          for (const entry of entries) {
            const listedName = (entry.split(",")[0] ?? "").replace(/^["']|["']$/g, "");
            const name = basename(listedName);
            if (!/^audio-g\d{4}-\d{5}\.wav$/i.test(name) || processedAudioFiles.has(name)) continue;
            const filePath = join(audioDirectory, name);
            try {
              const wav = readFileSync(filePath);
              if (wav.length < 1600 || wav.length > 8_000_000) continue;
              const match = name.match(/audio-g\d{4}-(\d{5})\.wav/i);
              const segmentIndex = match ? Number(match[1]) : 0;
              try {
                onAudioChunk({
                  timeSeconds: Math.max(0, generationOffsetSeconds + segmentIndex * 45),
                  wavBase64: wav.toString("base64")
                });
              } catch { continue; }
              processedAudioFiles.add(name);
              audioSegmentCount += 1;
              try { unlinkSync(filePath); } catch { /* The temporary folder is removed when capture ends. */ }
              publish("capturing", "LIVE映像の代表フレーム累計" + frameCount + "枚・音声区間" + audioSegmentCount + "件を取得中です。");
            } catch { /* A segment still being finalized will be picked up on the next poll. */ }
          }
        };
        const runAudioCapture = async (initialStreamUrl: string): Promise<void> => {
          let nextStreamUrl: string | null = initialStreamUrl;
          let retryAttempt = 0;
          while (!cancelled && !finished && !audioStopped) {
            let currentStreamUrl = nextStreamUrl;
            nextStreamUrl = null;
            if (!currentStreamUrl) {
              try {
                currentStreamUrl = await resolveLiveStreamUrl(slug, () => cancelled || finished || audioStopped, child => { audioResolverChild = child; });
              } catch (error) {
                if (cancelled || finished || audioStopped) break;
                const detail = error instanceof Error ? error.message : String(error);
                if (isPermanentLiveAudioCaptureError(detail)) {
                  onAudioError?.("LIVE音声の再接続を続行できないエラーです：" + detail.slice(0, 350));
                  break;
                }
                retryAttempt += 1;
                const delayMs = nextLiveAudioCaptureRetryDelayMs(retryAttempt);
                onAudioError?.("LIVE音声の接続先URLを再取得できませんでした。" + detail.slice(0, 250) + " " +
                  Math.ceil(delayMs / 1000) + "秒後に再接続します（試行 " + retryAttempt + "）。");
                await waitForAudioRetry(delayMs);
                continue;
              } finally {
                audioResolverChild = null;
              }
            }
            if (cancelled || finished || audioStopped || !currentStreamUrl) break;
            audioGeneration += 1;
            const generationName = "g" + String(audioGeneration).padStart(4, "0");
            const listPath = join(audioDirectory, "segments-" + generationName + ".csv");
            const outputPattern = join(audioDirectory, "audio-" + generationName + "-%05d.wav");
            const generationOffsetSeconds = getLiveAudioCaptureOffsetSeconds(requestedOffsetSeconds, captureRequestedAt, Date.now());
            const segmentCountBefore = audioSegmentCount;
            let audioProcess: ChildProcess;
            try {
              audioProcess = spawn(ffmpeg, [
                "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-i", currentStreamUrl, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", "45",
                "-segment_format", "wav", "-reset_timestamps", "1",
                "-progress", "pipe:1", "-nostats",
                "-segment_list", listPath, "-segment_list_type", "csv", outputPattern
              ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              if (isPermanentLiveAudioCaptureError(detail)) {
                onAudioError?.("LIVE音声のFFmpegを起動できません：" + detail.slice(0, 350));
                break;
              }
              retryAttempt += 1;
              const delayMs = nextLiveAudioCaptureRetryDelayMs(retryAttempt);
              onAudioError?.("LIVE音声のFFmpeg起動に失敗しました。" + detail.slice(0, 250) + " " +
                Math.ceil(delayMs / 1000) + "秒後に再試行します（試行 " + retryAttempt + "）。");
              await waitForAudioRetry(delayMs);
              continue;
            }
            audioChild = audioProcess;
            let audioStderr = "";
            let progressBuffer = "";
            let lastProgressAt = Date.now();
            let lastOutputTimeUs = -1;
            let audioStalled = false;
            audioProcess.stdout?.on("data", chunk => {
              const combined = (progressBuffer + String(chunk)).slice(-8192);
              const lines = combined.split(/\r?\n/);
              progressBuffer = lines.pop() ?? "";
              for (const line of lines) {
                const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
                if (!match) continue;
                const outputTimeUs = Number(match[1]);
                if (Number.isFinite(outputTimeUs) && outputTimeUs > lastOutputTimeUs) {
                  lastOutputTimeUs = outputTimeUs;
                  lastProgressAt = Date.now();
                }
              }
            });
            audioProcess.stderr?.on("data", chunk => {
              audioStderr = (audioStderr + String(chunk)).slice(-3000);
            });
            const pollTimer = setInterval(() => flushAudioSegments(listPath, generationOffsetSeconds), 2500);
            const watchdogTimer = setInterval(() => {
              if (hasLiveAudioCaptureProgressStalled(lastProgressAt, Date.now())) {
                audioStalled = true;
                audioProcess.kill();
              }
            }, LIVE_AUDIO_CAPTURE_WATCHDOG_INTERVAL_MS);
            const exit = await new Promise<{ code: number | null; error?: string }>(resolvePromise => {
              let settled = false;
              const settle = (result: { code: number | null; error?: string }): void => {
                if (settled) return;
                settled = true;
                resolvePromise(result);
              };
              let processError: string | undefined;
              audioProcess.once("error", error => {
                processError = error.message;
                audioProcess.kill();
              });
              audioProcess.once("close", code => settle({ code, error: processError }));
            });
            clearInterval(pollTimer);
            clearInterval(watchdogTimer);
            if (audioChild === audioProcess) audioChild = null;
            flushAudioSegments(listPath, generationOffsetSeconds);
            try { if (existsSync(listPath)) unlinkSync(listPath); } catch { /* Best-effort temporary-file cleanup. */ }
            if (cancelled || finished || audioStopped) break;
            if (audioSegmentCount > segmentCountBefore) retryAttempt = 0;
            const detail = audioStalled
              ? "LIVE音声FFmpegの進捗が" + Math.floor(LIVE_AUDIO_CAPTURE_STALL_TIMEOUT_MS / 1000) + "秒以上停止したため、音声接続だけを再起動しました。"
              : exit.error
                ? "FFmpeg音声プロセスの実行エラー：" + exit.error
                : "LIVE音声ストリームの取得が終了しました（終了コード：" + String(exit.code ?? "不明") + "）。" +
                  (audioStderr ? " " + audioStderr.slice(-700) : "");
            if (isPermanentLiveAudioCaptureError(detail)) {
              onAudioError?.("LIVE音声を再接続できない状態です：" + detail.slice(0, 450));
              break;
            }
            retryAttempt += 1;
            const delayMs = nextLiveAudioCaptureRetryDelayMs(retryAttempt);
            onAudioError?.(detail.slice(0, 300) + " " + Math.ceil(delayMs / 1000) +
              "秒後に音声ストリームを再接続します（試行 " + retryAttempt + "）。");
            await waitForAudioRetry(delayMs);
          }
        };
        void runAudioCapture(streamUrl).catch(error => {
          if (!cancelled && !finished && !audioStopped) {
            onAudioError?.("LIVE音声の取得処理でエラーが発生しました：" +
              (error instanceof Error ? error.message : String(error)).slice(0, 350));
          }
        }).finally(() => {
          if (audioDirectory) rmSync(audioDirectory, { recursive: true, force: true });
          audioDirectory = "";
          finishAudioCapture();
        });
      }

      const child = spawn(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", streamUrl,
        "-an", "-sn", "-dn",
        "-vf", "fps=1/25,scale=w='min(960,iw)':h=-2",
        "-q:v", "6",
        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      ffmpegChild = child;
      if (cancelled) {
        child.kill();
        return;
      }
      publish("capturing", onAudioChunk
        ? "LIVE映像の代表フレームと音声を同時に解析しています。録画ファイルは作成しません。"
        : "LIVE映像から代表フレームを抽出しています。録画ファイルは作成しません。");
      let buffer = Buffer.alloc(0);
      let stderr = "";
      const startedCaptureAt = Date.now();
      child.stdout?.on("data", chunk => {
        if (cancelled) return;
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        if (buffer.length > 12_000_000 && !buffer.includes(Buffer.from([0xff, 0xd8]))) {
          buffer = Buffer.alloc(0);
          return;
        }
        while (!cancelled) {
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
            timeSeconds: Math.max(0, Math.round(captureOffsetSeconds + (Date.now() - startedCaptureAt) / 1000)),
            imageBase64: jpeg.toString("base64")
          };
          frameCount += 1;
          onFrame(frame);
          publish("capturing", `LIVE映像の代表フレームを継続取得中です（累計${frameCount}枚）。記事のAI分析には直近8枚を使用します。`);
        }
      });
      child.stderr?.on("data", chunk => {
        stderr = (stderr + String(chunk)).slice(-3000);
      });
      child.once("error", error => {
        if (cancelled || finished) return;
        finished = true;
        stopAudioCapture();
        publish("error", "FFmpegでLIVE映像を開けませんでした：" + error.message);
      });
      child.once("close", code => {
        if (cancelled || finished) return;
        finished = true;
        stopAudioCapture();
        const exitStatus = classifyLiveCaptureExit(code, frameCount);
        if (exitStatus === "completed") {
          publish("completed", `LIVE映像の取得が終了しました。代表フレーム累計${frameCount}枚を取得しました。`);
        } else {
          publish("error", "LIVE映像の接続が予期せず終了しました。" +
            (stderr ? " " + stderr.slice(-800) : ` 終了コード：${code ?? "不明"}`) +
            (frameCount > 0 ? `（終了前に${frameCount}枚取得）` : ""));
        }
      });
    } catch (error) {
      if (cancelled || finished) return;
      finished = true;
      stopAudioCapture();
      publish("error", error instanceof Error ? error.message : String(error));
    }
  })();

  return stop;
}
