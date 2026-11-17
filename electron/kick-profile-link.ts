/**
 * Build only an official Kick channel URL from the internal channel slug.
 * Display names, URLs, query strings and other untrusted values are rejected.
 */
export function kickProfileUrl(input: unknown): string {
  if (typeof input !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(input)) {
    throw new Error("Kick配信者のチャンネル名が正しくありません。");
  }
  return "https://kick.com/" + input.toLowerCase();
}
