/** Kick emote markers are removed only when building ASS, never in JSONL or TXT. */
export function formatKickEmoteTokens(content: string, removeEmotes: boolean): string {
  return content.replace(/\[emote:\d+:([^\]\r\n]+)\]/g, (_token, name: string) =>
    removeEmotes ? " " : name
  ).replace(/[ \t]{2,}/g, " ").trim();
}
