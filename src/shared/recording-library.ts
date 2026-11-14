/**
 * Extract a channel slug from filenames produced by the recorder and comment-video
 * generator. Also accepts plain channel-name filenames as a safe fallback.
 */
export function getRecordingChannelSlug(fileName: string): string | null {
  if (typeof fileName !== "string" || fileName.length > 260) return null;
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const match = baseName.match(/^([a-zA-Z0-9_-]+?)(?:_VOD)?_\d{8}_\d{6}(?:_retry\d+)?(?:_comments(?:_\d+)?)?$/i);
  const fallback = match || /_\\d{8}(?:_|$)/.test(baseName) ? null : baseName.match(/^([a-zA-Z0-9_-]{1,40})$/);
  const slug = match?.[1] ?? fallback?.[1];
  return slug ? slug.toLowerCase() : null;
}
