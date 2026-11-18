import { getRecordingChannelSlug } from "./recording-library";

export type ArticleLogCandidate = {
  name: string;
  path: string;
  channelSlug: string;
  kind: "LIVE" | "VOD";
};

function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/(?:(?:_retry\d+)|(?:_take\d+)|(?:_comments(?:_\d+)?))+$/gi, "");
}

function vodId(stem: string): string | null {
  const match = stem.match(/(?:__VOD_|_VOD_)([a-f0-9-]{20,40})(?:_|$)/i);
  return match ? match[1].toLowerCase() : null;
}

/** Only suggest chat logs from the *same broadcast*, never every log from the channel. */
export function selectAssociatedArticleLogs(
  videoFileName: string,
  slug: string,
  logs: ArticleLogCandidate[]
): string[] {
  const expectedSlug = getRecordingChannelSlug(videoFileName);
  if (!expectedSlug || expectedSlug !== slug.toLowerCase()) return [];
  const videoStem = fileStem(videoFileName);
  const videoId = vodId(videoStem);
  const isVod = videoId !== null || /__VOD(?:_|$)|_VOD_/i.test(videoStem);
  return logs.filter(log => {
    if (log.channelSlug.toLowerCase() !== slug.toLowerCase()) return false;
    if (log.kind !== (isVod ? "VOD" : "LIVE")) return false;
    const candidate = fileStem(log.name);
    if (candidate === videoStem) return true;
    return Boolean(videoId && vodId(candidate) === videoId);
  }).map(log => log.path).slice(0, 31);
}

/** Extract channels from local files, including broadcasters who were never monitored. */
export function getAvailableArticleChannels(
  registeredSlugs: string[], videoNames: string[]
): string[] {
  const results = new Set<string>();
  for (const slug of registeredSlugs) {
    if (/^[a-zA-Z0-9_-]{1,40}$/.test(slug)) results.add(slug.toLowerCase());
  }
  for (const name of videoNames) {
    const slug = getRecordingChannelSlug(name);
    if (slug) results.add(slug);
  }
  return [...results].sort((a,b) => a.localeCompare(b));
}
