/** Shared geometric scheduler for Nico-style ASS, used for live recordings and VOD. */
export type NicoAssLane = {
  start: number; end: number; width: number; speed: number; entryX: number;
};

export type NicoAssProfile = {
  speed: number; entryOffsetPx: number; gapPx: number; moveSeconds: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Estimate recent comments with an exponential 2.4s decay so bursts fade away. */
export function updateNicoAssActivity(previous: number, elapsedSeconds: number): number {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  return clamp(previous * Math.exp(-elapsed / 2.4) + 1, 1, 80);
}

/** Text length controls speed; recent density adjusts the right-hand entry and timing. */
export function computeNicoAssProfile(
  screenWidth: number, textWidth: number, fontSize: number, activity: number
): NicoAssProfile {
  const width = clamp(Number.isFinite(screenWidth) ? screenWidth : 1920, 320, 7680);
  const contentWidth = clamp(Number.isFinite(textWidth) ? textWidth : 100, 1, 30000);
  const density = clamp(Number.isFinite(activity) ? activity : 1, 1, 80);
  const entryOffsetPx = Math.round(clamp(12 + Math.min(90, density * 1.6), 12, 110));
  const moveSeconds = clamp(
    6.1 + Math.min(1.2, (contentWidth / width) * 0.42) - Math.min(1.35, density * 0.038),
    4.3, 7.3
  );
  const speed = (width + entryOffsetPx + contentWidth) / moveSeconds;
  const gapPx = Math.round(clamp(fontSize * 0.65 + density * 0.65, 24, 72));
  return { speed, entryOffsetPx, gapPx, moveSeconds };
}

export type NicoAssReservation = {
  laneIndex: number; start: number; end: number; travelSeconds: number;
};

/**
 * Keep the posting time if possible. In busy moments, delay entrance at most
 * maxHoldSeconds, but never let a following comment catch the previous text.
 * The check accounts for the entire period where both subtitles are visible.
 */
export function reserveNicoAssLane(
  lanes: ReadonlyArray<NicoAssLane | null>,
  requestedStart: number,
  mediaEnd: number,
  entryX: number,
  width: number,
  speed: number,
  gap: number,
  maxHoldSeconds: number,
  preferredLane = 0
): NicoAssReservation | null {
  if (!lanes.length || ![requestedStart, mediaEnd, entryX, width, speed, gap].every(Number.isFinite)
    || speed <= 0 || width <= 0 || requestedStart < 0 || requestedStart >= mediaEnd) return null;
  const travelSeconds = (entryX + width) / speed;
  const maxHold = clamp(Number.isFinite(maxHoldSeconds) ? maxHoldSeconds : 0, 0, 1.5);
  const stepCount = Math.ceil(maxHold / 0.1);
  for (let step = 0; step <= stepCount; step += 1) {
    const start = Math.round((requestedStart + Math.min(maxHold, step * 0.1)) * 1000) / 1000;
    const end = Math.min(mediaEnd, start + travelSeconds);
    if (end - start < 0.01) continue;
    for (let offset = 0; offset < lanes.length; offset += 1) {
      const index = ((preferredLane + offset) % lanes.length + lanes.length) % lanes.length;
      const previous = lanes[index];
      if (!previous || start >= previous.end) {
        return { laneIndex: index, start, end, travelSeconds };
      }
      // A future reservation already exists, so an earlier comment must not cross it.
      if (start < previous.start) continue;
      const overlapSeconds = Math.max(0, Math.min(previous.end, end) - start);
      const previousTrailingEdge = previous.entryX + previous.width -
        previous.speed * (start - previous.start);
      const initialGap = entryX - previousTrailingEdge;
      const minimumGap = initialGap + Math.min(0, (previous.speed - speed) * overlapSeconds);
      if (minimumGap + 0.001 >= gap) return { laneIndex: index, start, end, travelSeconds };
    }
  }
  return null;
}
