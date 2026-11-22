import type { VideoFrameSample } from "./video-frames";

export const LIVE_ARTICLE_FRAME_HISTORY_LIMIT = 7;
export const LIVE_ARTICLE_FRAME_ANALYSIS_LIMIT = LIVE_ARTICLE_FRAME_HISTORY_LIMIT + 1;

export type LiveArticleFrameSampleState = {
  historyFrames: VideoFrameSample[];
  seenCount: number;
};

export type LiveArticleFrameSampleResult = LiveArticleFrameSampleState & {
  frames: VideoFrameSample[];
};

/**
 * Keep a uniform reservoir of historical LIVE frames and always include the
 * newest frame. This preserves broad time coverage without retaining every
 * JPEG from a long broadcast in memory.
 */
export function addLiveArticleFrameSample(
  historyFrames: VideoFrameSample[],
  frame: VideoFrameSample,
  seenCount: number,
  random: () => number = Math.random
): LiveArticleFrameSampleResult {
  if (!frame || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0 ||
      typeof frame.imageBase64 !== "string" || !frame.imageBase64.trim()) {
    const safeHistory = Array.isArray(historyFrames) ? historyFrames.slice(0, LIVE_ARTICLE_FRAME_HISTORY_LIMIT) : [];
    return {
      historyFrames: safeHistory,
      seenCount: Number.isFinite(seenCount) ? Math.max(0, Math.floor(seenCount)) : 0,
      frames: [...safeHistory].sort((a, b) => a.timeSeconds - b.timeSeconds)
    };
  }

  const priorCount = Number.isFinite(seenCount) ? Math.max(0, Math.floor(seenCount)) : 0;
  const nextSeenCount = priorCount + 1;
  const nextHistory = Array.isArray(historyFrames)
    ? historyFrames.filter(item => item && Number.isFinite(item.timeSeconds) &&
      item.timeSeconds >= 0 && typeof item.imageBase64 === "string" && item.imageBase64.trim())
      .slice(0, LIVE_ARTICLE_FRAME_HISTORY_LIMIT)
    : [];

  if (nextHistory.length < LIVE_ARTICLE_FRAME_HISTORY_LIMIT) {
    nextHistory.push(frame);
  } else {
    let randomValue = 0.5;
    try {
      const candidate = random();
      if (Number.isFinite(candidate)) randomValue = Math.max(0, Math.min(0.999999999, candidate));
    } catch {
      // A failed random source must not interrupt LIVE article capture.
    }
    const slot = Math.floor(randomValue * nextSeenCount);
    if (slot < LIVE_ARTICLE_FRAME_HISTORY_LIMIT) nextHistory[slot] = frame;
  }

  // The current frame is always included even when reservoir sampling did not
  // select it. Deduplicate rounded timestamps and keep chronological order.
  const bySecond = new Map<number, VideoFrameSample>();
  for (const sample of nextHistory) bySecond.set(sample.timeSeconds, sample);
  bySecond.set(frame.timeSeconds, frame);
  const frames = [...bySecond.values()]
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .slice(-LIVE_ARTICLE_FRAME_ANALYSIS_LIMIT);

  return { historyFrames: nextHistory, seenCount: nextSeenCount, frames };
}
