/**
 * Human-readable Kick recording names. Keep the stable channel slug beside the
 * display name so the library can identify renamed broadcasters without API calls.
 *
 * Example: だいぶつ__daibututv2__2026-11-16_20-54-47__LIVE.mp4
 * Example: だいぶつ__daibututv2__2026-11-16_20-54-47__VOD_1111...jsonl
 */
export type BroadcastFileIdentity = {
  slug: string;
  displayName: string;
  startedAt: string | null;
  kind: "LIVE" | "VOD";
  videoId?: string;
};

export function safeKickDisplayName(value: unknown, slug: string): string {
  const raw = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  const result = raw.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/__+/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/g, "")
    .slice(0, 48).trim();
  if (!result || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result)) return slug;
  return result;
}

export function broadcastFileDate(startedAt: string | Date | null | undefined): string {
  const date = startedAt instanceof Date ? startedAt : typeof startedAt === "string" ? new Date(startedAt) : null;
  if (!date || !Number.isFinite(date.getTime())) return "date-unknown";
  const pad = (value: number) => String(value).padStart(2, "0");
  // Windows machine local time, matching the dates shown in the Japanese app.
  return [date.getFullYear(), "-", pad(date.getMonth() + 1), "-", pad(date.getDate()),
    "_", pad(date.getHours()), "-", pad(date.getMinutes()), "-", pad(date.getSeconds())].join("");
}

export function broadcastFileStem(identity: BroadcastFileIdentity): string {
  const slug = identity.slug.toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(slug)) throw new Error("Kickのチャンネル名が不正です。");
  const vod = identity.kind === "VOD"
    ? "_"+(typeof identity.videoId === "string" && /^[a-f0-9-]{20,40}$/i.test(identity.videoId)
      ? identity.videoId.toLowerCase() : (() => { throw new Error("VODのIDが不正です。"); })())
    : "";
  return safeKickDisplayName(identity.displayName, slug) + "__" + slug + "__" +
    broadcastFileDate(identity.startedAt) + "__" + identity.kind + vod;
}

const NEW_FILE = /^(.{1,48})__([a-z0-9_-]{1,40})__(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}|date-unknown)__(LIVE|VOD(?:_[a-f0-9-]{20,40})?)(?:_take\d+)?(?:_retry\d+)?(?:_comments(?:_\d+)?)?$/i;

export function parseBroadcastFileStem(filename: string): {
  slug: string; kind: "LIVE" | "VOD"; startedAt: string | null; videoId?: string; displayName: string
} | null {
  if (typeof filename !== "string" || filename.length > 240) return null;
  const base = filename.replace(/\.[^.]+$/, "");
  const match = base.match(NEW_FILE);
  if (!match) return null;
  const date = match[3] === "date-unknown" ? null : new Date(match[3].replace(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/,
    "$1-$2-$3T$4:$5:$6"
  ));
  if (date && !Number.isFinite(date.getTime())) return null;
  const kind = match[4].toUpperCase().startsWith("VOD") ? "VOD" : "LIVE";
  return {
    slug: match[2].toLowerCase(), displayName: match[1], kind,
    startedAt: date ? date.toISOString() : null,
    ...(kind === "VOD" && match[4].includes("_") ? { videoId: match[4].slice(4).toLowerCase() } : {})
  };
}
