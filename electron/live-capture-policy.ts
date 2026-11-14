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


export function nextLiveAudioCaptureRetryDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(60_000, 5_000 * 2 ** Math.min(safeAttempt - 1, 4));
}

export function isPermanentLiveAudioCaptureError(message: string): boolean {
  return /\bENOENT\b|matches no streams|does not contain any stream|unrecognized option|option .+ not found|unable to find a suitable output format/i.test(message);
}

export function getLiveAudioCaptureOffsetSeconds(
  initialOffsetSeconds: number,
  captureRequestedAtMs: number,
  generationStartedAtMs: number
): number {
  const base = Number.isFinite(initialOffsetSeconds) ? Math.max(0, initialOffsetSeconds) : 0;
  const elapsed = Number.isFinite(captureRequestedAtMs) && Number.isFinite(generationStartedAtMs)
    ? Math.max(0, (generationStartedAtMs - captureRequestedAtMs) / 1000)
    : 0;
  return base + elapsed;
}


export const LIVE_AUDIO_CAPTURE_STALL_TIMEOUT_MS = 90_000;
export const LIVE_AUDIO_CAPTURE_WATCHDOG_INTERVAL_MS = 15_000;

export function hasLiveAudioCaptureProgressStalled(
  lastProgressAtMs: number,
  nowMs: number,
  timeoutMs = LIVE_AUDIO_CAPTURE_STALL_TIMEOUT_MS
): boolean {
  if (!Number.isFinite(lastProgressAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return false;
  }
  return nowMs - lastProgressAtMs >= timeoutMs;
}
