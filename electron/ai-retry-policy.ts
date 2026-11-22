const PERMANENT_ERROR_PATTERNS = [
  /HTTP\s+(?:400|401|403|404|405|413|415|422)\b/i,
  /OpenAI APIキーを保存/,
  /モデル.+(?:ありません|見つかりません)/,
  /Vision対応モデルへ変更/
];

const TRANSIENT_ERROR_PATTERNS = [
  /HTTP\s+(?:408|425|429|5\d\d)\b/i,
  /接続できません|タイムアウト|timeout|timed out/i,
  /ECONN(?:REFUSED|RESET|ABORTED|TIMEDOUT)|ENOTFOUND|EAI_AGAIN/i,
  /fetch failed|network|socket hang up|connection reset|connection refused/i
];

export const MAX_FINAL_AI_ANALYSIS_RETRIES = 2;

/** Retry only errors that may clear without changing model or credentials. */
export function isRetryableAiAnalysisError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message.trim() || PERMANENT_ERROR_PATTERNS.some(pattern => pattern.test(message))) return false;
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function getAiAnalysisRetryDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(15_000, 2_000 * 2 ** Math.min(safeAttempt - 1, 3));
}
