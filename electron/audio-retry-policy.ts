const PERMANENT_ERROR_PATTERNS = [
  /音声認識モデル.+ありません/,
  /画像入力に対応していません/,
  /qwen3a音声入力に対応/,
  /サイズが上限を超えています/,
  /HTTP\s+(?:400|401|403|404|405|413|415|422)\b/i
];

const TRANSIENT_ERROR_PATTERNS = [
  /HTTP\s+(?:408|425|429|5\d\d)\b/i,
  /接続できません/,
  /タイムアウト|timed?\s*out|timeout/i,
  /ECONN(?:REFUSED|RESET|ABORTED|TIMEDOUT)|ENOTFOUND|EAI_AGAIN/i,
  /fetch failed|network|socket hang up|connection reset|connection refused/i
];

export function isRetryableAudioTranscriptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message.trim()) return false;
  if (PERMANENT_ERROR_PATTERNS.some(pattern => pattern.test(message))) return false;
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function getAudioTranscriptionRetryDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(60_000, 5_000 * 2 ** Math.min(safeAttempt - 1, 4));
}
