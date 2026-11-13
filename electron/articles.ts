import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { isPathInsideDirectory } from "./recording";

export type StreamArticle = {
  id: string;
  slug: string;
  displayName: string;
  headline: string;
  category: string;
  startedAt: string;
  durationSeconds: number;
  commentCount: number;
  uniqueCommenters: number;
  keywords: string[];
  paragraphs: string[];
  sourceVideo: string;
  sourceLogs: string[];
  createdAt: string;
  status?: "live" | "completed";
  aiGenerated?: boolean;
  aiSummary?: string;
  highlights?: string[];
  lastAiUpdateAt?: string | null;
  viewerCount?: number;
  peakViewerCount?: number;
  aiError?: string;
};

type ChatLine = {
  content?: unknown;
  message?: unknown;
  senderUsername?: unknown;
  username?: unknown;
  createdAt?: unknown;
  timeInSeconds?: unknown;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
const STOP_WORDS = new Set(["これ", "それ", "ここ", "こと", "もの", "さん", "する", "いる", "ある", "ない", "です", "ます", "www", "草", "ｗｗｗ"]);

function safeSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value)) {
    throw new Error("配信者名が不正です。");
  }
  return value.toLowerCase();
}

function extractStartDate(fileName: string, fallback: Date): Date {
  const match = fileName.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_retry\d+)?\.[^.]+$/i);
  if (!match) return fallback;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}ーぁ-んァ-ヶ一-龠]+/gu, " ");
  return normalized.split(/\s+/).filter(word => word.length >= 2 && word.length <= 24 && !STOP_WORDS.has(word));
}

function makeParagraphs(displayName: string, category: string, commentCount: number, uniqueCommenters: number, keywords: string[], samples: string[]): string[] {
  const topic = keywords.length ? `コメントでは「${keywords.slice(0, 4).join("・")}」などの話題に関する反応が目立ちました。` : "コメントの内容から特定の話題を十分に抽出できなかったため、配信内容の詳細な分析は控えています。";
  const activity = commentCount > 0
    ? `配信中には${commentCount.toLocaleString("ja-JP")}件のコメントが記録され、${uniqueCommenters.toLocaleString("ja-JP")}人の投稿者が参加しました。視聴者の反応を手掛かりに、配信内で話題となった場面を振り返ります。`
    : "対応するコメントログが見つからなかったため、コメント数や視聴者の反応は集計できていません。";
  const quote = samples.length
    ? `ログからは「${samples[0].slice(0, 90)}」といった投稿も確認できます。これは保存されたコメントの一例であり、配信者本人の発言を示すものではありません。`
    : "コメント本文のサンプルがないため、視聴者の具体的な反応は掲載していません。";
  return [
    `${displayName}は${category ? `「${category}」カテゴリで` : ""}配信を実施しました。本記事は録画ファイル名と保存済みコメントログをもとに、配信の記録を自動整理したものです。`,
    activity,
    topic,
    quote,
    "※本記事はローカルの録画・コメントログから機械的に作成した記録記事です。コメントの話題抽出は簡易的な集計であり、配信映像の内容をAIが視聴・理解した要約ではありません。"
  ];
}

export function listStreamArticles(outputDirectory: string, slugInput?: unknown): StreamArticle[] {
  const root = resolve(outputDirectory);
  const articleRoot = join(root, "Articles");
  if (!existsSync(articleRoot)) return [];
  const slugFilter = typeof slugInput === "string" && slugInput ? safeSlug(slugInput) : null;
  const results: StreamArticle[] = [];
  const folders = readdirSync(articleRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  for (const folder of folders) {
    if (slugFilter && folder.name.toLowerCase() !== slugFilter) continue;
    const directory = join(articleRoot, folder.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
      try {
        const article = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as StreamArticle;
        if (article && article.slug === folder.name && typeof article.headline === "string" && Array.isArray(article.paragraphs)) results.push(article);
      } catch { /* 破損した記事ファイルは一覧から除外 */ }
    }
  }
  return results.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function deleteStreamArticle(outputDirectory: string, slugInput: unknown, idInput: unknown): { ok: true; id: string } {
  const slug = safeSlug(slugInput);
  if (typeof idInput !== "string" || !new RegExp(`^${slug}_\\d{8}_\\d{6}import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { isPathInsideDirectory } from "./recording";

export type StreamArticle = {
  id: string;
  slug: string;
  displayName: string;
  headline: string;
  category: string;
  startedAt: string;
  durationSeconds: number;
  commentCount: number;
  uniqueCommenters: number;
  keywords: string[];
  paragraphs: string[];
  sourceVideo: string;
  sourceLogs: string[];
  createdAt: string;
  status?: "live" | "completed";
  aiGenerated?: boolean;
  aiSummary?: string;
  highlights?: string[];
  lastAiUpdateAt?: string | null;
  viewerCount?: number;
  peakViewerCount?: number;
  aiError?: string;
};

type ChatLine = {
  content?: unknown;
  message?: unknown;
  senderUsername?: unknown;
  username?: unknown;
  createdAt?: unknown;
  timeInSeconds?: unknown;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
const STOP_WORDS = new Set(["これ", "それ", "ここ", "こと", "もの", "さん", "する", "いる", "ある", "ない", "です", "ます", "www", "草", "ｗｗｗ"]);

function safeSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value)) {
    throw new Error("配信者名が不正です。");
  }
  return value.toLowerCase();
}

function extractStartDate(fileName: string, fallback: Date): Date {
  const match = fileName.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_retry\d+)?\.[^.]+$/i);
  if (!match) return fallback;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}ーぁ-んァ-ヶ一-龠]+/gu, " ");
  return normalized.split(/\s+/).filter(word => word.length >= 2 && word.length <= 24 && !STOP_WORDS.has(word));
}

function makeParagraphs(displayName: string, category: string, commentCount: number, uniqueCommenters: number, keywords: string[], samples: string[]): string[] {
  const topic = keywords.length ? `コメントでは「${keywords.slice(0, 4).join("・")}」などの話題に関する反応が目立ちました。` : "コメントの内容から特定の話題を十分に抽出できなかったため、配信内容の詳細な分析は控えています。";
  const activity = commentCount > 0
    ? `配信中には${commentCount.toLocaleString("ja-JP")}件のコメントが記録され、${uniqueCommenters.toLocaleString("ja-JP")}人の投稿者が参加しました。視聴者の反応を手掛かりに、配信内で話題となった場面を振り返ります。`
    : "対応するコメントログが見つからなかったため、コメント数や視聴者の反応は集計できていません。";
  const quote = samples.length
    ? `ログからは「${samples[0].slice(0, 90)}」といった投稿も確認できます。これは保存されたコメントの一例であり、配信者本人の発言を示すものではありません。`
    : "コメント本文のサンプルがないため、視聴者の具体的な反応は掲載していません。";
  return [
    `${displayName}は${category ? `「${category}」カテゴリで` : ""}配信を実施しました。本記事は録画ファイル名と保存済みコメントログをもとに、配信の記録を自動整理したものです。`,
    activity,
    topic,
    quote,
    "※本記事はローカルの録画・コメントログから機械的に作成した記録記事です。コメントの話題抽出は簡易的な集計であり、配信映像の内容をAIが視聴・理解した要約ではありません。"
  ];
}

export function listStreamArticles(outputDirectory: string, slugInput?: unknown): StreamArticle[] {
  const root = resolve(outputDirectory);
  const articleRoot = join(root, "Articles");
  if (!existsSync(articleRoot)) return [];
  const slugFilter = typeof slugInput === "string" && slugInput ? safeSlug(slugInput) : null;
  const results: StreamArticle[] = [];
  const folders = readdirSync(articleRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  for (const folder of folders) {
    if (slugFilter && folder.name.toLowerCase() !== slugFilter) continue;
    const directory = join(articleRoot, folder.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
      try {
        const article = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as StreamArticle;
        if (article && article.slug === folder.name && typeof article.headline === "string" && Array.isArray(article.paragraphs)) results.push(article);
      } catch { /* 破損した記事ファイルは一覧から除外 */ }
    }
  }
  return results.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

).test(idInput)) {
    throw new Error("削除する記事IDが不正です。");
  }
  const root = resolve(outputDirectory);
  const directory = join(root, "Articles", slug);
  const filePath = join(directory, `${idInput}.json`);
  if (!isPathInsideDirectory(filePath, directory) || !existsSync(filePath)) {
    throw new Error("記事ファイルが見つかりません。");
  }
  let article: StreamArticle;
  try { article = JSON.parse(readFileSync(filePath, "utf8")) as StreamArticle; }
  catch { throw new Error("記事ファイルを読み取れません。"); }
  if (!article || article.id !== idInput || article.slug !== slug) {
    throw new Error("記事の内容と保存先が一致しないため削除できません。");
  }
  unlinkSync(filePath);
  return { ok: true, id: idInput };
}

export function generateStreamArticle(input: unknown, outputDirectory: string): StreamArticle {
  if (!input || typeof input !== "object") throw new Error("記事の生成情報が不正です。");
  const values = input as { videoPath?: unknown; slug?: unknown; displayName?: unknown; category?: unknown; headline?: unknown; chatPaths?: unknown };
  const root = resolve(outputDirectory);
  if (typeof values.videoPath !== "string" || !isPathInsideDirectory(values.videoPath, root) ||
      !VIDEO_EXTENSIONS.has(extname(values.videoPath).toLowerCase()) || !existsSync(values.videoPath)) {
    throw new Error("録画ライブラリ内の動画を選択してください。");
  }
  const slug = safeSlug(values.slug);
  const displayName = typeof values.displayName === "string" && values.displayName.trim()
    ? values.displayName.trim().slice(0, 100) : slug;
  const category = typeof values.category === "string" ? values.category.trim().slice(0, 80) : "";
  const headline = typeof values.headline === "string" && values.headline.trim()
    ? values.headline.trim().slice(0, 160) : `${displayName}の配信を振り返る`;
  const chatPaths = Array.isArray(values.chatPaths) ? values.chatPaths.slice(0, 31) : [];
  const chatRoot = join(root, "Chat", slug);
  const selected = chatPaths.filter((path): path is string =>
    typeof path === "string" && isPathInsideDirectory(path, chatRoot) && extname(path).toLowerCase() === ".jsonl" && existsSync(path));
  let commentCount = 0;
  const commenters = new Set<string>();
  const counts = new Map<string, number>();
  const samples: string[] = [];
  for (const path of selected) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim() || commentCount >= 250000) continue;
      let item: ChatLine;
      try { item = JSON.parse(line) as ChatLine; } catch { continue; }
      const body = typeof item.content === "string" ? item.content : typeof item.message === "string" ? item.message : "";
      const text = body.trim().slice(0, 1000);
      if (!text) continue;
      commentCount += 1;
      const username = typeof item.senderUsername === "string" ? item.senderUsername : typeof item.username === "string" ? item.username : "";
      if (username) commenters.add(username);
      for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
      if (samples.length < 3 && text.length >= 8 && !/^https?:\/\//i.test(text)) samples.push(text);
    }
  }
  const keywords = [...counts.entries()].filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word);
  const file = statSync(values.videoPath);
  const startedAt = extractStartDate(basename(values.videoPath), file.mtime);
  const id = `${slug}_${startedAt.getFullYear()}${String(startedAt.getMonth()+1).padStart(2,"0")}${String(startedAt.getDate()).padStart(2,"0")}_${String(startedAt.getHours()).padStart(2,"0")}${String(startedAt.getMinutes()).padStart(2,"0")}${String(startedAt.getSeconds()).padStart(2,"0")}`;
  const article: StreamArticle = {
    id, slug, displayName, headline, category, startedAt: startedAt.toISOString(),
    durationSeconds: 0, commentCount, uniqueCommenters: commenters.size, keywords,
    paragraphs: makeParagraphs(displayName, category, commentCount, commenters.size, keywords, samples),
    sourceVideo: values.videoPath, sourceLogs: selected, createdAt: new Date().toISOString()
  };
  const directory = join(root, "Articles", slug);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(article, null, 2), "utf8");
  return article;
}
