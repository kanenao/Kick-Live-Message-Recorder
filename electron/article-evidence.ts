/**
 * Evidence shown with AI stream articles. Entries describe actual captured inputs,
 * not claims that an AI model understood or verified their contents.
 */
export type ArticleEvidenceEvent = {
  source: "chat" | "audio" | "video";
  timeSeconds: number;
  detail: string;
};
export type TimedArticleComment = { at: string; text: string; timeInSeconds?: number };
export type TimedArticleAudio = { startSeconds: number; text: string };
export type TimedArticleVideo = { timeSeconds: number };

function validSecond(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 7 * 24 * 3600
    ? Math.floor(value) : null;
}
function textExcerpt(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\[emote:[^\]]+\]/gi, " ")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 140);
}
function evenlySpaced<T>(items: T[], maximum: number): T[] {
  if (maximum <= 0) return [];
  if (items.length <= maximum) return items;
  if (maximum === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: maximum }, (_, i) =>
    items[Math.round(i * (items.length - 1) / (maximum - 1))]);
}
function uniqueSorted(entries: ArticleEvidenceEvent[]): ArticleEvidenceEvent[] {
  const seen = new Set<string>();
  return entries.filter(item => {
    const key = item.source + "|" + item.timeSeconds + "|" + item.detail;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.timeSeconds - b.timeSeconds || a.source.localeCompare(b.source));
}
function selectEvidence(entries: ArticleEvidenceEvent[], maximum: number): ArticleEvidenceEvent[] {
  const limit = Math.max(0, Math.min(36, Math.floor(maximum)));
  if (limit <= 0) return [];
  const sorted = uniqueSorted(entries);
  if (sorted.length <= limit) return sorted;
  const groups = (["chat", "audio", "video"] as const)
    .map(source => sorted.filter(item => item.source === source)).filter(group => group.length > 0);
  const quota = Math.max(1, Math.floor(limit / groups.length));
  let selection = uniqueSorted(groups.flatMap(group => evenlySpaced(group, quota)));
  if (selection.length < limit) {
    const keys = new Set(selection.map(item => item.source + "|" + item.timeSeconds + "|" + item.detail));
    const remaining = sorted.filter(item => !keys.has(item.source + "|" + item.timeSeconds + "|" + item.detail));
    selection = uniqueSorted([...selection, ...evenlySpaced(remaining, limit - selection.length)]);
  }
  return selection.slice(0, limit);
}

export function buildArticleEvidenceTimeline(
  startedAt: string,
  comments: TimedArticleComment[],
  audioSegments: TimedArticleAudio[],
  videoFrames: TimedArticleVideo[],
  maximum = 18
): ArticleEvidenceEvent[] {
  const startMs = Date.parse(startedAt);
  const entries: ArticleEvidenceEvent[] = [];
  for (const comment of comments) {
    const detail = textExcerpt(comment.text);
    if (!detail) continue;
    const absoluteMs = Date.parse(comment.at);
    const seconds = typeof comment.timeInSeconds === "number"
      ? validSecond(comment.timeInSeconds)
      : Number.isFinite(startMs) && Number.isFinite(absoluteMs)
        ? validSecond((absoluteMs - startMs) / 1000) : null;
    if (seconds !== null) entries.push({ source: "chat", timeSeconds: seconds, detail });
  }
  for (const segment of audioSegments) {
    const second = validSecond(segment.startSeconds);
    const detail = textExcerpt(segment.text);
    if (second !== null && detail) entries.push({ source: "audio", timeSeconds: second, detail });
  }
  for (const frame of videoFrames) {
    const second = validSecond(frame.timeSeconds);
    if (second !== null) entries.push({
      source: "video", timeSeconds: second, detail: "録画の代表フレームを取得（映像内容の解釈はAI解析結果を参照）"
    });
  }
  return selectEvidence(entries, maximum);
}

/** Merge LIVE batches without displaying the same evidence twice. */
export function mergeArticleEvidenceTimeline(
  previous: ArticleEvidenceEvent[],
  next: ArticleEvidenceEvent[],
  maximum = 18
): ArticleEvidenceEvent[] {
  const valid = [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]
    .filter((entry): entry is ArticleEvidenceEvent =>
      Boolean(entry && ["chat", "audio", "video"].includes(entry.source) &&
        validSecond(entry.timeSeconds) !== null &&
        typeof entry.detail === "string" && entry.detail.length > 0));
  return selectEvidence(valid.map(item => ({
    source: item.source, timeSeconds: Math.floor(item.timeSeconds), detail: textExcerpt(item.detail)
  })).filter(item => item.detail), maximum);
}

export function formatArticleEvidenceTime(seconds: number): string {
  const safe = validSecond(seconds) ?? 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return [hours, minutes, remainder].map(value => String(value).padStart(2, "0")).join(":");
}
