/**
 * A downloader can exit with code 0 while Kick is still LIVE.
 * This decision belongs to the LIVE session, not to the process exit code.
 */
export type LiveProbeResult = { isLive: boolean; startedAt: string | null } | null;
export const LIVE_RECORDING_STALL_TIMEOUT_MS = 180_000;
export const LIVE_RECORDING_WATCHDOG_INTERVAL_MS = 30_000;
export const LIVE_RECORDING_FORCE_KILL_TIMEOUT_MS = 20_000;

export function hasLiveRecordingStalled(lastByteGrowthAt: number, now: number): boolean {
  return Number.isFinite(lastByteGrowthAt) && Number.isFinite(now) &&
    now - lastByteGrowthAt >= LIVE_RECORDING_STALL_TIMEOUT_MS;
}

export type LiveRecoveryDecision = {
  action: "complete" | "retry" | "error";
  nextFailures: number;
  message: string;
};

export function decideLiveRecordingRecovery(input: {
  probe: LiveProbeResult;
  expectedStreamStartedAt: string | null;
  code: number | null;
  savedFileCount: number;
  runtimeMs: number;
  attemptProducedVideo: boolean;
  failuresUsed: number;
  maxFailures: number;
  fatalError: boolean;
  stalled: boolean;
}): LiveRecoveryDecision {
  const { probe, expectedStreamStartedAt, savedFileCount, runtimeMs, attemptProducedVideo, failuresUsed,
    maxFailures, fatalError, stalled, code } = input;

  if (fatalError) {
    return { action: "error", nextFailures: failuresUsed, message: "録画に必要な実行ファイルの起動・接続に失敗しました。" };
  }
  if (probe && !probe.isLive) {
    return savedFileCount > 0
      ? { action: "complete", nextFailures: failuresUsed, message: "配信終了を確認し、録画を完了しました。" }
      : { action: "error", nextFailures: failuresUsed, message: "配信は終了していますが、動画ファイルは保存されていません。" };
  }
  if (probe?.isLive && expectedStreamStartedAt && probe.startedAt &&
      Number.isFinite(Date.parse(expectedStreamStartedAt)) &&
      Number.isFinite(Date.parse(probe.startedAt)) &&
      Date.parse(expectedStreamStartedAt) !== Date.parse(probe.startedAt)) {
    // Do not append an unrelated next broadcast to the current session.
    return savedFileCount > 0
      ? { action: "complete", nextFailures: failuresUsed, message: "別の配信が始まったため、前の録画を確定しました。" }
      : { action: "error", nextFailures: failuresUsed, message: "配信が切り替わりましたが、前の録画が保存されていません。" };
  }

  // A segment that captured video for >= 60s is a successful recovery period:
  // don't let the lifetime retry count kill a long stream several hours later.
  const nextFailures = runtimeMs >= 60_000 && attemptProducedVideo ? 1 : failuresUsed + 1;
  if (nextFailures > maxFailures) {
    return { action: "error", nextFailures,
      message: "LIVE録画の連続再接続が上限に達しました。保存済みの分割ファイルは残します。" };
  }

  const why = stalled ? "録画の書き込みが一定時間止まりました"
    : code === 0 ? "配信終了前に録画プロセスが終了しました"
    : "録画接続が切れました";
  const confidence = probe?.isLive ? "Kick APIで配信継続を確認" : "配信状態を確認できないため暫定的に";
  return { action: "retry", nextFailures,
    message: `${why}（${confidence}、再接続します）。` };
}
