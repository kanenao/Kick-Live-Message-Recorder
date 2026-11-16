/**
 * Extract a channel slug from filenames produced by the recorder and comment-video
 * generator. Also accepts plain channel-name filenames as a safe fallback.
 */
export function getRecordingChannelSlug(fileName: string): string | null {
  if (typeof fileName !== "string" || fileName.length > 260) return null;
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const modern = baseName.match(/^.{1,48}__([a-zA-Z0-9_-]{1,40})__\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}__(?:LIVE|VOD_[a-f0-9-]{20,40})/i)
    ?? baseName.match(/^.{1,48}__([a-zA-Z0-9_-]{1,40})__date-unknown__(?:LIVE|VOD_[a-f0-9-]{20,40})/i);
  if (modern) return modern[1].toLowerCase();
  const match = baseName.match(/^([a-zA-Z0-9_-]+?)(?:_VOD)?_\d{8}_\d{6}(?:_retry\d+)?(?:_comments(?:_\d+)?)?$/i);
  const batchVod = baseName.match(/^([a-zA-Z0-9_-]+?)_VOD_[a-f0-9-]{20,40}_.+$/i);
  const fallback = match || batchVod || /_\d{8}(?:_|$)/.test(baseName) ? null : baseName.match(/^([a-zA-Z0-9_-]{1,40})$/);
  const slug = match?.[1] ?? batchVod?.[1] ?? fallback?.[1];
  return slug ? slug.toLowerCase() : null;
}
