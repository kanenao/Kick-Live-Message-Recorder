import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { listRecordingFiles, type RecordingFile } from "./recording";
import { listCommentLogFiles, type CommentLogFile } from "./comment-video";
import { listStreamArticles, type StreamArticle } from "./articles";
import { getRecordingChannelSlug } from "../src/shared/recording-library";

export type LibrarySession = {
  id: string;
  slug: string;
  kind: "LIVE" | "VOD";
  startedAt: string;
  endedAt?: string;
  title: string;
  videos: RecordingFile[];
  logs: CommentLogFile[];
  article?: StreamArticle;
  status: "saved" | "interrupted" | "failed" | "unknown";
  warnings: string[];
  commentAssociation: "exact" | "none";
};

type SessionMetadata = {
  schemaVersion?: number;
  id?: string;
  slug?: string;
  kind?: "LIVE" | "VOD";
  startedAt?: string;
  finishedAt?: string;
  status?: "recording" | "completed" | "stopped" | "failed";
  sourceUrl?: string;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov"]);
const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{1,180}$/;
const VOD_UUID = "[a-f0-9-]{20,40}";

function parseStamp(input: string): string | null {
  const match = input.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2])-1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2])-1 &&
    date.getDate() === Number(match[3]) && date.getHours() === Number(match[4]) &&
    date.getMinutes() === Number(match[5]) && date.getSeconds() === Number(match[6])
    ? date.toISOString() : null;
}

export function classifyRecordingFile(fileName: string, modifiedAt: string): {
  id: string; slug: string; kind: "LIVE" | "VOD"; startedAt: string
} | null {
  if (typeof fileName !== "string" || !VIDEO_EXTENSIONS.has(extname(fileName).toLowerCase())) return null;
  const base = fileName.slice(0, -extname(fileName).length);
  const batch = base.match(new RegExp("^([a-zA-Z0-9_-]{1,40})_VOD_("+ VOD_UUID +")_.+$", "i"));
  if (batch) {
    const slug = batch[1].toLowerCase();
    return { id: slug + "_VOD_" + batch[2].toLowerCase(), slug, kind: "VOD", startedAt: modifiedAt };
  }
  const legacyVod = base.match(/^([a-zA-Z0-9_-]{1,40})_VOD_(\d{8}_\d{6})(?:_retry\d+)?(?:_comments(?:_\d+)?)?$/i);
  if (legacyVod) {
    const slug = legacyVod[1].toLowerCase();
    return { id: slug + "_VOD_" + legacyVod[2], slug, kind: "VOD", startedAt: parseStamp(legacyVod[2]) ?? modifiedAt };
  }
  const live = base.match(/^([a-zA-Z0-9_-]{1,40})_(\d{8}_\d{6})(?:_retry\d+)?(?:_comments(?:_\d+)?)?$/i);
  if (live) {
    const slug = live[1].toLowerCase();
    return { id: slug + "_" + live[2], slug, kind: "LIVE", startedAt: parseStamp(live[2]) ?? modifiedAt };
  }
  const slug = getRecordingChannelSlug(fileName);
  if (!slug) return null;
  return { id: slug + "_legacy_" + base.slice(0, 90), slug, kind: "LIVE", startedAt: modifiedAt };
}

function readSessionMetadata(root: string): SessionMetadata[] {
  const folder = join(resolve(root), "RecordingSessions");
  if (!existsSync(folder)) return [];
  const result: SessionMetadata[] = [];
  for (const name of readdirSync(folder).filter(file => file.endsWith(".json")).slice(0, 3000)) {
    const id = name.slice(0, -5);
    if (!SESSION_ID_REGEX.test(id)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(folder, name), "utf8")) as SessionMetadata;
      if (raw.schemaVersion !== 1 || raw.id !== id ||
          typeof raw.slug !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(raw.slug) ||
          !["LIVE", "VOD"].includes(raw.kind ?? "") ||
          typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) continue;
      result.push(raw);
    } catch {
      // A partially written/obsolete metadata file cannot hide other recordings.
    }
  }
  return result;
}

function safePath(value: string): string {
  return resolve(value).toLowerCase();
}

export function buildRecordingSessions(
  recordings: RecordingFile[],
  commentLogs: CommentLogFile[],
  articles: StreamArticle[],
  metadata: SessionMetadata[] = []
): LibrarySession[] {
  const sessions = new Map<string, LibrarySession>();
  function ensure(id: string, slug: string, kind: "LIVE" | "VOD", startedAt: string): LibrarySession {
    let entry = sessions.get(id);
    if (!entry) {
      entry = { id, slug, kind, startedAt, title: "", videos: [], logs: [], status: "unknown",
        warnings: [], commentAssociation: "none" };
      sessions.set(id, entry);
    }
    return entry;
  }
  for (const meta of metadata) {
    if (!meta.id || !meta.slug || !meta.kind || !meta.startedAt) continue;
    const s = ensure(meta.id, meta.slug.toLowerCase(), meta.kind, meta.startedAt);
    s.startedAt = meta.startedAt;
    if (meta.finishedAt && Number.isFinite(Date.parse(meta.finishedAt))) s.endedAt = meta.finishedAt;
    if (meta.status === "failed" || meta.status === "stopped") s.status = meta.status === "failed" ? "failed" : "interrupted";
    if (meta.status === "completed") s.status = "saved";
    if (meta.status === "recording") s.warnings.push("録画の終了確認がありません。アプリが異常終了した可能性があります。");
  }
  for (const file of recordings) {
    const parsed = classifyRecordingFile(file.name, file.modifiedAt);
    if (!parsed) continue;
    const s = ensure(parsed.id, parsed.slug, parsed.kind, parsed.startedAt);
    s.videos.push(file);
    if (s.status !== "interrupted" && s.status !== "failed") s.status = file.size > 0 ? "saved" : "unknown";
    if (file.size === 0) s.warnings.push("サイズ0の動画ファイルがあります。");
  }

  const byVideoPath = new Map<string, LibrarySession>();
  for (const s of sessions.values()) {
    for (const file of s.videos) byVideoPath.set(safePath(file.path), s);
  }
  for (const article of articles) {
    if (!article || typeof article.slug !== "string" || typeof article.id !== "string") continue;
    const slug = article.slug.toLowerCase();
    const source = typeof article.sourceVideo === "string" ? safePath(article.sourceVideo) : "";
    // Archived articles point at a real video; some LIVE articles retain an output prefix.
    let s = source ? byVideoPath.get(source) : undefined;
    if (!s && source) {
      s = [...sessions.values()].find(item => item.slug === slug &&
        item.videos.some(v => safePath(v.path).startsWith(source + ".")));
    }
    if (!s) {
      const date = Number.isFinite(Date.parse(article.startedAt)) ? article.startedAt : article.createdAt;
      s = ensure(slug + "_article_" + article.id, slug, "LIVE", date);
    }
    if (!s.article || Date.parse(article.createdAt) > Date.parse(s.article.createdAt)) s.article = article;
    if (!s.title) s.title = article.streamTitle || article.headline || "";
  }

  for (const log of commentLogs) {
    if (!log || typeof log.channelSlug !== "string") continue;
    const slug = log.channelSlug.toLowerCase();
    const vod = log.kind === "VOD" ? log.name.match(new RegExp("^VOD_("+ VOD_UUID +")_", "i")) : null;
    if (vod) {
      const id = slug + "_VOD_" + vod[1].toLowerCase();
      const s = ensure(id, slug, "VOD", log.modifiedAt);
      s.logs.push(log);
      s.commentAssociation = "exact";
      continue;
    }
    if (log.kind === "LIVE") {
      // JSONL for LIVE is stored by calendar day, not by broadcast. Never
      // attribute an entire daily log to a specific video without evidence.
      const date = log.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1] ?? log.name;
      const s = ensure(slug + "_chat_" + date, slug, "LIVE", log.modifiedAt);
      s.logs.push(log);
      s.commentAssociation = "none";
      if (!s.warnings.includes("日別コメントのため、録画ごとの対応は未確認です。")) {
        s.warnings.push("日別コメントのため、録画ごとの対応は未確認です。");
      }
      continue;
    }
    const s = ensure(slug + "_unlinked_" + basename(log.name, extname(log.name)), slug, log.kind, log.modifiedAt);
    s.logs.push(log);
  }

  for (const s of sessions.values()) {
    if (s.article?.sourceLogs?.length) {
      for (const log of commentLogs) {
        if (log.channelSlug.toLowerCase() !== s.slug || s.logs.some(item => item.path === log.path)) continue;
        if (s.article.sourceLogs.some(path => safePath(path) === safePath(log.path))) {
          s.logs.push(log);
          s.commentAssociation = "exact";
        }
      }
    }
    if (s.status === "saved" && !s.videos.some(v => v.size > 0)) {
      s.status = "failed";
      s.warnings.push("完了記録はありますが、動画が見つかりません。");
    }
    s.videos.sort((a,b) => Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt));
    s.logs.sort((a,b) => Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt));
    if (!s.videos.length && s.logs.length) s.warnings.push("動画が見つかりません。コメントのみ保存されています。");
  }
  return [...sessions.values()].sort((a,b) =>
    Date.parse(b.startedAt || "0") - Date.parse(a.startedAt || "0")).slice(0, 3000);
}

export function listLibrarySessions(outputDirectory: string): LibrarySession[] {
  return buildRecordingSessions(
    listRecordingFiles(outputDirectory),
    listCommentLogFiles(outputDirectory),
    listStreamArticles(outputDirectory),
    readSessionMetadata(outputDirectory)
  );
}
