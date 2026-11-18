import { createReadStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseBroadcastFileStem } from "./recording-filenames";
import { createVodChatAssHeader, VodChatAssComposer } from "./vod-chat-ass";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 250_000;
const MAX_SECONDS = 7 * 24 * 60 * 60;

type SavedVodAssResult = {
  ok: true;
  outputPath: string;
  sourcePath: string;
  validComments: number;
  generatedComments: number;
  skippedComments: number;
};

/** Accept only existing VOD JSONL files in Chat/<channel>. No arbitrary file paths or symlinks. */
export function resolveSavedVodJsonl(input: unknown, outputDirectory: string): { path: string; slug: string } {
  if (typeof input !== "string" || input.length < 1 || input.length > 4096) {
    throw new Error("再変換するVODコメントファイルを選んでください。");
  }
  const root = resolve(outputDirectory, "Chat");
  const path = resolve(input);
  const folder = dirname(path);
  const slug = basename(folder);
  const filename = basename(path);
  const identity = parseBroadcastFileStem(filename);
  const isVod = identity?.kind === "VOD" || /^VOD_/i.test(filename);
  if (dirname(folder) !== root || !/^[a-z0-9_-]{1,40}$/i.test(slug)
    || extname(filename).toLowerCase() !== ".jsonl"
    || !isVod || (identity && identity.slug !== slug.toLowerCase())) {
    throw new Error("保存済みのVODコメントJSONLだけを選択してください。");
  }
  const rootStat = lstatSync(root);
  const folderStat = lstatSync(folder);
  const fileStat = lstatSync(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !folderStat.isDirectory() || folderStat.isSymbolicLink()
    || !fileStat.isFile() || fileStat.isSymbolicLink()
    || fileStat.size < 1 || fileStat.size > MAX_FILE_BYTES) {
    throw new Error("VODコメントJSONLが不正、またはサイズ上限を超えています。");
  }
  return { path, slug: slug.toLowerCase() };
}

async function* readJsonl(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.trim()) yield line.replace(/^\uFEFF/, "");
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

function parseMessage(line: string): { timeInSeconds: number; content: string } | null {
  try {
    const raw: unknown = JSON.parse(line);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.content !== "string" || !value.content.trim()
      || typeof value.timeInSeconds !== "number" || !Number.isFinite(value.timeInSeconds)
      || value.timeInSeconds < 0 || value.timeInSeconds > MAX_SECONDS - 30) return null;
    return { timeInSeconds: value.timeInSeconds, content: value.content };
  } catch {
    return null;
  }
}

/** Reuse local VOD chat without Kick API calls; preserve the original JSONL and all existing ASS files. */
export async function regenerateSavedVodAss(
  inputPath: unknown, outputDirectory: string, removeEmotes = true, assOptions: unknown = {}
): Promise<SavedVodAssResult> {
  const { path, slug } = resolveSavedVodJsonl(inputPath, outputDirectory);
  const original = lstatSync(path);
  let records = 0;
  let validComments = 0;
  let maxSeconds = 0;
  let previousSeconds = Number.NEGATIVE_INFINITY;

  // Scan once for the end of the subtitle timeline. The JSONL does not contain VOD duration.
  for await (const line of readJsonl(path)) {
    records += 1;
    if (records > MAX_RECORDS) throw new Error("コメントが25万件を超えています。ログを分割してください。");
    const message = parseMessage(line);
    if (!message) continue;
    if (message.timeInSeconds < previousSeconds) {
      throw new Error("コメントの時刻順が不正です。JSONLを時刻順に整えてください。");
    }
    validComments += 1;
    previousSeconds = message.timeInSeconds;
    maxSeconds = message.timeInSeconds;
  }
  if (!validComments) throw new Error("ASSに変換できるコメントがありません。VOD用のJSONLを確認してください。");
  if (original.size !== lstatSync(path).size || original.mtimeMs !== lstatSync(path).mtimeMs) {
    throw new Error("コメントログが処理中に更新されたため、再生成を中止しました。");
  }

  const stem = basename(path, extname(path)).slice(0, 185);
  const directory = dirname(path);
  const mode = assOptions && typeof assOptions === "object"
    && (assOptions as { autoFlow?: unknown }).autoFlow === false ? "manual" : "auto";
  let outputPath = "";
  for (let take = 1; take <= 10000; take += 1) {
    const suffix = take === 1 ? "" : "_" + take;
    const candidate = join(directory, stem + "_nico-" + mode + suffix + ".ass");
    if (!existsSync(candidate)) { outputPath = candidate; break; }
  }
  if (!outputPath) throw new Error("ASSファイル名を確保できませんでした。");
  const temporaryPath = join(directory, "." + randomUUID() + ".ass.tmp");
  // Include a short post-roll because the end of the VOD is not present in the JSONL.
  const duration = Math.min(MAX_SECONDS, Math.max(1, maxSeconds + 30));
  const composer = new VodChatAssComposer(duration, removeEmotes, assOptions);
  let generatedComments = 0;
  try {
    writeFileSync(temporaryPath, createVodChatAssHeader(slug, "保存済みVODコメント") + "\n", { encoding: "utf8", flag: "wx" });
    let batch: string[] = [];
    for await (const line of readJsonl(path)) {
      const message = parseMessage(line);
      if (!message) continue;
      const dialogue = composer.createDialogue(message);
      if (dialogue) {
        batch.push(dialogue);
        generatedComments += 1;
      }
      if (batch.length >= 1500) {
        appendFileSync(temporaryPath, batch.join("\n") + "\n", "utf8");
        batch = [];
      }
    }
    if (batch.length) appendFileSync(temporaryPath, batch.join("\n") + "\n", "utf8");
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink()
      || original.size !== after.size || original.mtimeMs !== after.mtimeMs) {
      throw new Error("変換中にコメントログが更新されたため保存しませんでした。");
    }
    if (existsSync(outputPath)) throw new Error("出力先ASSがすでに存在します。もう一度実行してください。");
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return {
    ok: true, sourcePath: path, outputPath,
    validComments, generatedComments,
    skippedComments: records - generatedComments
  };
}
