/** The duration of an archive must never be replaced with time since the broadcast started. */
export function articleDurationForSave(
  startedAt: string, currentSeconds: number, status: "live" | "completed" | undefined,
  nowMilliseconds: number
): number {
  if (status === "live") {
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start) || !Number.isFinite(nowMilliseconds)) return 0;
    return Math.max(0, Math.floor((nowMilliseconds - start) / 1000));
  }
  return Number.isFinite(currentSeconds) ? Math.max(0, Math.floor(currentSeconds)) : 0;
}
