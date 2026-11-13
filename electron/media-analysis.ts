import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
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
  frameBase64: string;
  transcript: string;
  warnings: string[];
};

type ProcessResult = { code: number; stdout: string; stderr: string };

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
    child.once("close", (code) => finish(undefined, { code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
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
    frameBase64: "",
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

  const status = getMediaToolStatus(input.tools, input.userDataDirectory, input.resourcesDirectory);
  if (!status.ffmpegAvailable) {
    result.warnings.push("FFmpegが見つからないため、映像・音声を抽出できません。設定画面でffmpeg.exeを指定してください。");
    return result;
  }

  const tempDirectory = join(input.outputDirectory, "MediaAnalysis", ".work");
  mkdirSync(tempDirectory, { recursive: true });
  const suffix = Date.now().toString(36) + "-" + process.pid;
  const framePath = join(tempDirectory, input.slug + "-" + suffix + ".jpg");
  const audioPath = join(tempDirectory, input.slug + "-" + suffix + ".wav");
  const transcriptPrefix = join(tempDirectory, input.slug + "-" + suffix);
  const transcriptPath = transcriptPrefix + ".txt";

  try {
    try {
      const frame = await runCommand(status.ffmpegPath, [
        "-hide_banner", "-loglevel", "error",
        "-sseof", "-8", "-i", input.videoPath,
        "-frames:v", "1", "-vf", "scale=1280:-2",
        "-q:v", "4", "-y", framePath
      ], 25_000);
      if (frame.code !== 0 && frame.stderr.trim()) {
        result.warnings.push("映像フレーム抽出： " + frame.stderr.trim().slice(-500));
      }
      if (existsSync(framePath) && statSync(framePath).size > 1024) {
        result.frameBase64 = readFileSync(framePath).toString("base64");
      } else {
        result.warnings.push("録画中ファイルから映像フレームを取得できませんでした。録画が安定してから再試行します。");
      }
    } catch (error) {
      result.warnings.push("映像フレーム抽出に失敗しました：" + (error instanceof Error ? error.message : String(error)));
    }

    if (!status.whisperAvailable || !status.whisperModelAvailable) {
      result.warnings.push("音声文字起こしにはWhisper.cpp本体とggml-base.binが必要です。設定画面で両方を指定してください。");
    } else {
      try {
        const audio = await runCommand(status.ffmpegPath, [
          "-hide_banner", "-loglevel", "error",
          "-sseof", "-75", "-i", input.videoPath,
          "-t", "60", "-vn", "-ac", "1", "-ar", "16000",
          "-c:a", "pcm_s16le", "-y", audioPath
        ], 35_000);
        if (audio.code !== 0 && audio.stderr.trim()) {
          result.warnings.push("音声抽出： " + audio.stderr.trim().slice(-500));
        }
        if (existsSync(audioPath) && statSync(audioPath).size > 16_000) {
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
          if (transcription.code !== 0 && !result.transcript) {
            result.warnings.push("Whisper.cppの文字起こしに失敗しました：" + transcription.stderr.trim().slice(-700));
          }
          if (!result.transcript) result.warnings.push("今回の音声区間から文字起こし結果を取得できませんでした。");
        } else {
          result.warnings.push("音声データを抽出できませんでした。無音・録画開始直後・ファイル書き込み中の可能性があります。");
        }
      } catch (error) {
        result.warnings.push("音声文字起こしに失敗しました：" + (error instanceof Error ? error.message : String(error)));
      }
    }
  } finally {
    for (const path of [framePath, audioPath, transcriptPath]) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* temporary data cleanup is best effort */ }
    }
  }

  return result;
}
