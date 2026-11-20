/**
 * Ollama/vision models sometimes repeat identical Japanese descriptions for
 * each extracted frame. Collapse repeated prose, without changing the source
 * transcript, comments or the persisted original article.
 */
function signature(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[\s\u3000「」『』【】“”"'‘’（）()\[\]、。．.!！？?:：;；・\-―_]/g, "");
}

function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const key = a.slice(i, i + 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const key = b.slice(i, i + 2);
    const available = counts.get(key) ?? 0;
    if (available > 0) {
      counts.set(key, available - 1);
      matches += 1;
    }
  }
  return 2 * matches / (a.length + b.length - 2);
}

function sameMeaningRepeated(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Short material can be meaningfully repeated (quotes, reactions, names).
  // Use approximate matching only for whole, substantial descriptions.
  if (Math.min(a.length, b.length) < 24) return false;
  // Episode numbers, viewers and timecodes often distinguish REAL events.
  // Do not confuse two time-stamped scenes merely because their wording matches.
  const numbersA = a.match(/\\d+/g)?.join("|") ?? "";
  const numbersB = b.match(/\\d+/g)?.join("|") ?? "";
  if (numbersA !== numbersB) return false;
  if ((a.includes(b) || b.includes(a)) &&
      Math.min(a.length, b.length) >= 32) return true;
  // Keep borderline look-alikes; a changed word can change the reported event.
  return bigramSimilarity(a, b) >= 0.96;
}

function sentencePieces(text: string): string[] {
  return text.replace(/\r\n?/g, "\n")
    .split(/(?<=[。！？!?])\s*|\n+/u)
    .map(piece => piece.trim()).filter(Boolean);
}

function pushUniqueText(piece: string, seen: string[], output: string[]): void {
  const key = signature(piece);
  if (!key || seen.some(previous => sameMeaningRepeated(previous, key))) return;
  seen.push(key);
  output.push(piece);
}

/** Removes repeated long sentences inside a single model-produced string. */
export function deduplicateArticleSentences(text: unknown, maxLength = 1200): string {
  if (typeof text !== "string" || !text.trim()) return "";
  const pieces = sentencePieces(text);
  const seen: string[] = [];
  const output: string[] = [];
  for (const piece of pieces) pushUniqueText(piece, seen, output);
  return output.join(" ").trim().slice(0, Math.max(0, maxLength));
}

/**
 * Deduplicates article paragraphs and video scene descriptions. The optional
 * preceding summary suppresses scene sentences already stated in that summary.
 */
export function deduplicateArticleList(
  source: unknown,
  maximum = 8,
  maximumLength = 1000,
  precedingSummary = ""
): string[] {
  if (!Array.isArray(source)) return [];
  const seen = sentencePieces(deduplicateArticleSentences(precedingSummary, 12000))
    .map(signature).filter(Boolean);
  const output: string[] = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const parts = sentencePieces(item);
    const kept: string[] = [];
    for (const part of parts) pushUniqueText(part, seen, kept);
    const cleaned = kept.join(" ").trim().slice(0, maximumLength);
    if (cleaned) output.push(cleaned);
    if (output.length >= maximum) break;
  }
  return output;
}
