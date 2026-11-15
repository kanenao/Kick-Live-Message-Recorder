export type ReleaseNotesBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

export type ReleaseNoteInline = { kind: "text" | "strong" | "code"; value: string };

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", bull: "•", copy: "©"
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, key: string) => {
    if (key.startsWith("#")) {
      const isHex = key[1]?.toLowerCase() === "x";
      const point = Number.parseInt(key.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) {
        return String.fromCodePoint(point);
      }
      return "";
    }
    return named[key.toLowerCase()] ?? entity;
  });
}

/** Render GitHub HTML release notes as React text, never injecting remote HTML. */
function normalizeReleaseNoteMarkup(input: string): string {
  return decodeHtmlEntities(input
    .replace(/<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => "\n\n" + "#".repeat(Number(level)) + " ")
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)\s*>/gi, "**")
    .replace(/<code\b[^>]*>/gi, "`")
    .replace(/<\/code\s*>/gi, "`")
    .replace(/<\/?(?:p|div|section|article|ul|ol|blockquote|pre|table|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim());
}

export function parseReleaseNotes(input: string): ReleaseNotesBlock[] {
  const lines = normalizeReleaseNoteMarkup(input).split("\n");
  const blocks: ReleaseNotesBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    const value = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (value) blocks.push({ kind: "paragraph", text: value });
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const item = /^(?:[-*+•]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(item[1]);
      else blocks.push({ kind: "list", items: [item[1]] });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

export function splitReleaseNoteInline(value: string): ReleaseNoteInline[] {
  const parts: ReleaseNoteInline[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ kind: "text", value: value.slice(cursor, start) });
    const token = match[0];
    const isStrong = token.startsWith("**");
    parts.push({
      kind: isStrong ? "strong" : "code",
      value: token.slice(isStrong ? 2 : 1, isStrong ? -2 : -1)
    });
    cursor = start + token.length;
  }
  if (cursor < value.length) parts.push({ kind: "text", value: value.slice(cursor) });
  return parts;
}
