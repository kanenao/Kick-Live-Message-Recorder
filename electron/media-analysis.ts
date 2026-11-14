import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

export type MediaToolSettings = {
  ffmpegPath?: string;
  whisperCliPath?: string;
  whisperModelPath?: string;
};

export type MediaToolStatus = {
  ffmpegAvailable: boolean;
  ffmpegPath: string;
  whisperAvailable: boolean;
  whisperCliPath: string;
  whisperModelAvailable: boolean;
  whisperModelPath: string;
  visionModelRequired: string;
  setupNotes: string[];
};

export type LiveMediaAnalysis = {
  analyzedAt: string;
  frameBase64s: string[];
  transcript: string;
  warnings: string[];
};

type ProcessResult = { code: number; stdout: string; stderr: string };
type OutputResult = { ok: boolean; detail: string };

function existingFile(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // Ignore stale or inaccessible paths and continue to the next candidate.
    }
  }
  return "";
}

function searchPath(names: string[]): string {
  const directories = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = existingFile(names.map(name => join(directory, name)));
    if (candidate) return candidate;
  }
  return "";
}

export function getMediaToolStatus(
  settings: MediaToolSettings,
  userDataDirectory: string,
  resourcesDirectory: string
): MediaToolStatus {
  const configuredFfmpeg = typeof settings.ffmpegPath === "string" ? settings.ffmpegPath.trim() : "";
  const configuredWhisper = typeof settings.whisperCliPath === "string" ? settings.whisperCliPath.trim() : "";
  const configuredModel = typeof settings.whisperModelPath === "string" ? settings.whisperModelPath.trim() : "";

  const ffmpegPath = existingFile([
    configuredFfmpeg,
    join(resourcesDirectory, "tools", "ffmpeg.exe"),
    join(userDataDirectory, "tools", "ffmpeg.exe"),
    join(process.cwd(), "vendor", "win-x64", "ffmpeg.exe"),
    join(process.cwd(), "vendor", "ffmpeg.exe"),
    searchPath(process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"])
  ]);

  const whisperCliPath = existingFile([
    configuredWhisper,
    join(resourcesDirectory, "tools", "whisper-cli.exe"),
    join(userDataDirectory, "tools", "whisper-cli.exe"),
    join(process.cwd(), "vendor", "win-x64", "whisper-cli.exe"),
    join(process.cwd(), "vendor", "whisper-cli.exe"),
    searchPath(process.platform === "win32" ? ["whisper-cli.exe", "main.exe"] : ["whisper-cli"])
  ]);

  const whisperModelPath = existingFile([
    configuredModel,
    join(resourcesDirectory, "models", "ggml-base.bin"),
    join(userDataDirectory, "models", "ggml-base.bin"),
    join(process.cwd(), "vendor", "models", "ggml-base.bin"),
    process.env.WHISPER_MODEL_PATH
  ]);

  const setupNotes: string[] = [];
  if (!ffmpegPath) setupNotes.push("FFmpegが未設定です。ffmpeg.exeを選択してください。");
  if (!whisperCliPath) setupNotes.push("Whisper.cppのwhisper-cli.exeが未設定です。");
  if (!whisperModelPath) setupNotes.push("日本語対応のggml-base.binモデルが未設定です。");

  return {
    ffmpegAvailable: Boolean(ffmpegPath),
    ffmpegPath,
    whisperAvailable: Boolean(whisperCliPath),
    whisperCliPath,
    whisperModelAvailable: Boolean(whisperModelPath),
    whisperModelPath,
    visionModelRequired: "qwen2.5vl:3b",
    setupNotes
  };
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? { code: -1, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* process may already have exited */ }
      finish(new Error("メディア解析プロセスがタイムアウトしました。"));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-12000); });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-12000); });
    child.once("error", error => finish(error));
    child.once("close", code => finish(undefined, { code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function outputSize(path: string): number {
  try {
    return existsSync(path) && statSync(path).isFile() ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

/**
 * A live recording file may be observed while yt-dlp is still appending HLS
 * segments. Retry once after a short pause when the current file edge is not
 * yet decodable. Each attempt starts with a fresh output file, so a partial
 * JPEG/WAV from a failed attempt cannot be mistaken for a successful result.
 */
async function runFfmpegOutput(
  executable: string,
  args: string[],
  outputPath: string,
  minimumBytes: number,
  timeoutMs: number
): Promise<OutputResult> {
  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* overwritten with -y below */ }
    try {
      const processResult = await runCommand(executable, args, timeoutMs);
      const size = outputSize(outputPath);
      if (size >= minimumBytes) {
        return {
          ok: true,
          detail: processResult.code === 0 ? "" : "FFmpegは警告付きで出力しました：" + processResult.stderr.trim().slice(-350)
        };
      }
      lastDetail = processResult.stderr.trim().slice(-500) ||
        (processResult.code === 0 ? "出力ファイルが空、または小さすぎます。" : "終了コード " + processResult.code);
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt === 0) await wait(1_200);
  }
  return { ok: false, detail: lastDetail || "FFmpegが有効な出力を作成できませんでした。" };
}

function ffmpegInputArgs(offsetSeconds: number, videoPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts+discardcorrupt",
    "-analyzeduration", "10M",
    "-probesize", "10M",
    "-sseof", String(offsetSeconds),
    "-i", videoPath
  ];
}

export async function analyzeLiveRecordingMedia(input: {
  slug: string;
  videoPath: string;
  outputDirectory: string;
  tools: MediaToolSettings;
  userDataDirectory: string;
  resourcesDirectory: string;
}): Promise<LiveMediaAnalysis> {
  const result: LiveMediaAnalysis = {
    analyzedAt: new Date().toISOString(),
    frameBase64s: [],
    transcript: "",
    warnings: []
  };
  if (!/^[a-zA-Z0-9_]{1,25}$/.test(input.slug)) {
    result.warnings.push("配信チャンネル名が不正なため、メディア解析をスキップしました。");
    return result;
  }
  if (!existsSync(input.videoPath)) {
    result.warnings.push("録画中の映像ファイルをまだ確認できません。");
    return result;
  }

  const initialSize = outputSize(input.videoPath);
  if (initialSize < 64 * 1024) {
    result.warnings.push("録画ファイルがまだ小さいため、映像・音声の解析を次の周期へ延期します。");
    return result;
  }

  const status = getMediaToolStatus(input.tools, input.userDataDirectory, input.resourcesDirectory);
  if (!status.ffmpegAvailable) {
    result.warnings.push("FFmpegが見つからないため、映像・音声を抽出できません。設定画面でffmpeg.exeを指定してください。");
    return result;
  }

  const tempDirectory = join(input.outputDirectory, "MediaAnalysis", ".work");
  mkdirSync(tempDirectory, { recursive: true });
  const suffix = Date.now().toString(36) + "-" + process.pid;
  const filePrefix = input.slug + "-" + suffix;
  const frameOffsets = [-55, -30, -8];
  const framePaths = frameOffsets.map((_, index) =>
    join(tempDirectory, filePrefix + "-frame-" + index + ".jpg")
  );
  const audioPath = join(tempDirectory, filePrefix + ".wav");
  const transcriptPrefix = join(tempDirectory, filePrefix);
  const transcriptPath = transcriptPrefix + ".txt";

  try {
    // Do not launch three decoders against a growing file at once. Sequential
    // extraction reduces disk contention and avoids competing read positions.
    for (let index = 0; index < framePaths.length; index += 1) {
      const framePath = framePaths[index];
      const args = [
        ...ffmpegInputArgs(frameOffsets[index], input.videoPath),
        "-map", "0:v:0",
        "-frames:v", "1",
        "-vf", "scale=1280:-2",
        "-q:v", "4",
        "-y", framePath
      ];
      const frame = await runFfmpegOutput(status.ffmpegPath, args, framePath, 1024, 25_000);
      if (frame.ok) {
        if (frame.detail) result.warnings.push("映像フレーム " + (index + 1) + "： " + frame.detail);
        try {
          result.frameBase64s.push(readFileSync(framePath).toString("base64"));
        } catch (error) {
          result.warnings.push("映像フレームを読み込めませんでした：" + (error instanceof Error ? error.message : String(error)));
        }
      } else {
        result.warnings.push("映像フレーム " + (index + 1) + " の抽出に失敗しました：" + frame.detail);
      }
    }

    if (result.frameBase64s.length === 0) {
      result.warnings.push("録画中ファイルから映像フレームを取得できませんでした。録画が安定してから次の周期に再試行します。");
    } else if (result.frameBase64s.length < framePaths.length) {
      result.warnings.push("映像フレームは一部のみ取得できました。取得できた画面だけを解析します。");
    }

    if (!status.whisperAvailable || !status.whisperModelAvailable) {
      result.warnings.push("音声文字起こしにはWhisper.cpp本体とggml-base.binが必要です。設定画面で両方を指定してください。");
    } else {
      const audioArgs = [
        ...ffmpegInputArgs(-75, input.videoPath),
        "-map", "0:a:0?",
        "-vn",
        "-t", "60",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-y", audioPath
      ];
      const audio = await runFfmpegOutput(status.ffmpegPath, audioArgs, audioPath, 16_000, 35_000);
      if (audio.ok) {
        if (audio.detail) result.warnings.push("音声抽出： " + audio.detail);
        try {
          const transcription = await runCommand(status.whisperCliPath, [
            "-m", status.whisperModelPath,
            "-f", audioPath,
            "-l", "ja",
            "-nt", "-np",
            "-otxt",
            "-of", transcriptPrefix
          ], 180_000);
          if (existsSync(transcriptPath)) {
            result.transcript = readFileSync(transcriptPath, "utf8")
              .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
              .trim()
              .slice(0, 12_000);
          } else if (transcription.stdout.trim()) {
            result.transcript = transcription.stdout.trim().slice(0, 12_000);
          }
          if (transcription.code !== 0) {
            result.warnings.push("Whisper.cppは終了コード " + transcription.code + " を返しました：" + transcription.stderr.trim().slice(-500));
          }
          if (!result.transcript) result.warnings.push("今回の音声区間から文字起こし結果を取得できませんでした。");
        } catch (error) {
          result.warnings.push("音声文字起こしに失敗しました：" + (error instanceof Error ? error.message : String(error)));
        }
      } else {
        result.warnings.push("音声データを抽出できませんでした：" + audio.detail);
      }
    }
  } finally {
    // Whisper may create .txt/.srt/.vtt/.json/.csv sidecars depending on build.
    // Remove every file produced for this sampling cycle, not just the WAV/JPEG.
    try {
      for (const name of readdirSync(tempDirectory)) {
        if (!name.startsWith(filePrefix)) continue;
        const path = join(tempDirectory, name);
        try { if (existsSync(path) && statSync(path).isFile()) unlinkSync(path); } catch { /* cleanup is best effort */ }
      }
    } catch { /* cleanup is best effort */ }
  }

  const finalSize = outputSize(input.videoPath);
  if (finalSize < initialSize) {
    result.warnings.push("解析中に録画ファイルのサイズが変わりました。録画ファイルの切り替えが発生した可能性があります。");
  }
  return result;
}
