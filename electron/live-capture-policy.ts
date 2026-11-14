export type LiveCaptureExitStatus = "completed" | "error";

export function classifyLiveCaptureExit(exitCode: number | null, frameCount: number): LiveCaptureExitStatus {
  return exitCode === 0 && Number.isFinite(frameCount) && frameCount > 0 ? "completed" : "error";
}

export function nextManualCaptureRetryDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(60_000, 10_000 * 2 ** Math.min(safeAttempt - 1, 3));
}

export function detachCaptureIfCurrent<T>(
  captures: Map<string, T>,
  slug: string,
  capture: T
): boolean {
  if (captures.get(slug) !== capture) return false;
  captures.delete(slug);
  return true;
}
