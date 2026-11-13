import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isPathInsideDirectory } from "./recording";

export type AudioTranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
const AUDIO_SEGMENT_SECONDS = 45;
const MAX_AUDIO_SECONDS = 2 * 60 * 60;
const MAX_AUDIO_SEGMENTS = Math.ceil(MAX_AUDIO_SECONDS / AUDIO_SEGMENT_SECONDS);

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

function runTool(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      else resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("音声の抽出処理がタイムアウトしました。"));
    }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout = (stdout + String(chunk)).slice(0, 20_000); });
    child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.once("error", error => finish(new Error("FFmpegを起動できません：" + error.message)));
    child.once("close", code => {
      if (code === 0) finish();
      else finish(new Error("音声の抽出に失敗しました。" + (stderr ? " " + stderr.slice(-1200) : `終了コード：${code ?? "不明"}`)));
    });
  });
}

function cleanTranscript(value: string): string {
  let text = value.trim();
  const marker = text.indexOf("<asr_text>");
  if (marker >= 0) text = text.slice(marker + "<asr_text>".length);
  else text = text.replace(/^language\s+[^\r\n]+\s*/i, "");
  return text
    .replace(/<\|[^|]{1,80}\|>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2400);
}

/**
 * Uses the local Ollama Qwen3-ASR model. The model receives short 16 kHz mono
 * WAV segments encoded as base64 in the images field, as required by its Ollama
 * model template. Audio never leaves the configured Ollama endpoint.
 */
export async function transcribeWavBase64(
  wavBase64: string,
  baseUrlInput: string,
  modelInput: string
): Promise<string> {
  if (!wavBase64 || wavBase64.length > 12_000_000) throw new Error("音声チャンクのサイズが上限を超えています。");
  const baseUrl = (baseUrlInput || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = /^[a-zA-Z0-9._:/-]{1,120}$/.test(modelInput) ? modelInput : "frozenlab/qwen3-asr:0.6b";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: "", images: [wavBase64] }],
        options: { temperature: 0, num_ctx: 4096 }
      }),
      signal: AbortSignal.timeout(120_000)
    });
  } catch (error) {
    throw new Error("音声認識モデルへ接続できません。Ollamaの起動と接続URLを確認してください。" +
      (error instanceof Error ? " " + error.message : ""));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (/not found|model.*(missing|does not exist)/i.test(detail)) {
      throw new Error(`音声認識モデル「${model}」がありません。PowerShellで ollama pull ${model} を実行してください。`);
    }
    if (/audio|image|vision|projector|modality|unsupported/i.test(detail)) {
      throw new Error("現在のOllamaではこの音声モデルを実行できません。qwen3a音声入力に対応したOllamaへ更新してください。");
    }
    throw new Error(`Ollama音声認識エラー（HTTP ${response.status}）：${detail.slice(0, 500)}`);
  }
  const payload = await response.json() as { message?: { content?: unknown } };
  if (typeof payload.message?.content !== "string") throw new Error("音声認識モデルから文字起こし結果が返されませんでした。");
  return cleanTranscript(payload.message.content);
}

/**
 * Extracts audio in contiguous 45-second WAV chunks and transcribes each chunk.
 * For very long recordings, processing is capped at the first two hours.
 */
export async function transcribeVideoAudio(
  videoPathInput: string,
  outputDirectoryInput: string,
  baseUrl: string,
  model: string,
  onProgress?: (completed: number, total: number) => void
): Promise<AudioTranscriptSegment[]> {
  if (typeof videoPathInput !== "string" || !videoPathInput.trim()) {
    throw new Error("音声解析する録画動画を選択してください。");
  }
  const root = resolve(outputDirectoryInput);
  const videoPath = resolve(videoPathInput);
  if (!isPathInsideDirectory(videoPath, root) || !VIDEO_EXTENSIONS.has(extname(videoPath).toLowerCase())) {
    throw new Error("音声解析には録画ライブラリ内の動画を選択してください。");
  }
  const fileStats = statSync(videoPath);
  if (!fileStats.isFile() || !fileStats.size) throw new Error("音声解析する録画動画が空か、通常ファイルではありません。");

  const ffprobe = findTool(process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const audioStream = await runTool(ffprobe, [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index",
    "-of", "csv=p=0", videoPath
  ], 20_000);
  if (!audioStream.stdout) return [];

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kick-article-audio-"));
  try {
    const ffmpeg = findTool(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await runTool(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", videoPath, "-t", String(MAX_AUDIO_SECONDS),
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le", "-f", "segment",
      "-segment_time", String(AUDIO_SEGMENT_SECONDS),
      "-segment_format", "wav", "-reset_timestamps", "1",
      join(temporaryDirectory, "audio-%05d.wav")
    ], 15 * 60_000);

    const files = readdirSync(temporaryDirectory)
      .filter(name => /^audio-\d{5}\.wav$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_AUDIO_SEGMENTS);
    const segments: AudioTranscriptSegment[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const filePath = join(temporaryDirectory, files[index]);
      const stats = statSync(filePath);
      if (!stats.isFile() || stats.size < 1600 || stats.size > 8_000_000) continue;
      const wav = readFileSync(filePath);
      const text = await transcribeWavBase64(wav.toString("base64"), baseUrl, model);
      onProgress?.(index + 1, files.length);
      if (!text) continue;
      const startSeconds = index * AUDIO_SEGMENT_SECONDS;
      const audioSeconds = Math.max(0, (wav.length - 44) / 32_000);
      segments.push({
        startSeconds,
        endSeconds: startSeconds + Math.min(AUDIO_SEGMENT_SECONDS, audioSeconds || AUDIO_SEGMENT_SECONDS),
        text
      });
    }
    return segments;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function formatAudioTranscript(segments: AudioTranscriptSegment[], maxLength = 24_000): string {
  const lines = segments
    .filter(segment => Number.isFinite(segment.startSeconds) && typeof segment.text === "string" && segment.text.trim())
    .map(segment => {
      const minutes = Math.floor(segment.startSeconds / 60);
      const seconds = Math.floor(segment.startSeconds % 60);
      return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}] ${segment.text.trim()}`;
    });
  return lines.join("\n").slice(-maxLength);
}
