/**
 * A time-locked, bounded approximation of the ASS compositor, for the live
 * Canvas/video preview. Never writes to the user's original recording or logs.
 */
export type PreviewPosition = "scroll" | "top" | "bottom" | "command";

export type TimedPreviewComment = {
  seconds: number;
  content: string;
  username?: string;
  color?: string;
  position?: "scroll" | "top" | "bottom";
};

export type LivePreviewSettings = {
  fontSize: number;
  fontFamily: string;
  durationSeconds: number;
  speedPercent: number;
  rowLimit: number;
  collisionGap: number;
  opacity: number;
  position: PreviewPosition;
  autoFlow: boolean;
  showUsername: boolean;
};

export type ScheduledPreviewComment = {
  text: string;
  color: string;
  startSeconds: number;
  endSeconds: number;
  position: "scroll" | "top" | "bottom";
  xPixelsPerSecond: number;
  approximateWidth: number;
  lane: number;
  y: number;
  fontSize: number;
};

const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;

function textWidth(text: string, fontSize: number): number {
  return [...text].reduce((sum, character) => {
    const code = character.codePointAt(0) ?? 0;
    return sum + fontSize * (code <= 255 ? 0.57 : code >= 0x1f000 ? 1.1 : 1);
  }, 0);
}

export function buildTimedCommentSchedule(
  comments: TimedPreviewComment[],
  widthInput: number,
  heightInput: number,
  options: LivePreviewSettings
): ScheduledPreviewComment[] {
  const width = clamp(widthInput, 160, 7680, 1280);
  const height = clamp(heightInput, 90, 4320, 720);
  const fontSize = clamp(options.fontSize, 16, 80, 48) * (height / 1080);
  const lineHeight = Math.max(fontSize * 1.42, 12);
  const limitByHeight = Math.max(1, Math.floor((height - fontSize / 2) / lineHeight));
  const lanes = options.autoFlow ? Math.min(20, limitByHeight) :
    Math.min(Math.floor(clamp(options.rowLimit, 1, 20, 14)), limitByHeight);
  const fixedLanes = Math.max(1, Math.min(6, Math.floor(height * 0.3 / lineHeight)));
  const duration = clamp(options.durationSeconds, 2, 15, 6);
  const speedPercent = clamp(options.speedPercent, 50, 200, 100);
  const gap = clamp(options.collisionGap, 0, 200, 24) * width / 1920;
  const laneAvailable = {
    scroll: Array<number>(lanes).fill(0),
    top: Array<number>(fixedLanes).fill(0),
    bottom: Array<number>(fixedLanes).fill(0)
  };
  const sorted = comments
    .filter(comment => Number.isFinite(comment.seconds) && comment.seconds >= 0 &&
      typeof comment.content === "string" && comment.content.trim().length > 0)
    .slice(0, 1500)
    .sort((a, b) => a.seconds - b.seconds);
  const results: ScheduledPreviewComment[] = [];
  for (const comment of sorted) {
    const position = options.position === "command"
      ? comment.position ?? "scroll"
      : options.position;
    const text = (options.showUsername && comment.username ? comment.username + " : " : "") +
      comment.content.trim().slice(0, 500);
    const approximateWidth = textWidth(text, fontSize);
    // A real video preview uses the same selected source duration as the ASS
    // exporter, but approximates the additional per-comment auto-flow controls.
    const speed = options.autoFlow
      ? Math.max(35, width / duration) * (0.85 + Math.min(0.5, approximateWidth / Math.max(width, 1) * 0.3))
      : width / (duration * 100 / speedPercent);
    const travelTime = (width + approximateWidth) / Math.max(1, speed);
    const occupied = laneAvailable[position];
    let lane = 0;
    for (let index = 1; index < occupied.length; index++) {
      if (occupied[index] < occupied[lane]) lane = index;
    }
    // The ASS writer may manage collisions during final encoding; this preview
    // must never move a burst of old chat minutes into a later video scene.
    // Skip only the overflowing preview sample when every row is still busy.
    if (occupied[lane] - comment.seconds > 0.8) continue;
    const startSeconds = Math.max(comment.seconds, occupied[lane]);
    const endSeconds = startSeconds + (position === "scroll" ? travelTime : duration);
    if (position === "scroll") {
      // A following comment cannot enter the same line until the previous
      // tail clears the right edge, including the selected collision gap.
      occupied[lane] = startSeconds + (approximateWidth + gap) / Math.max(1, speed);
    } else {
      occupied[lane] = endSeconds + 0.08;
    }
    const y = position === "scroll"
      ? (lane + 1) * height / (lanes + 1)
      : position === "top"
        ? (lane + 0.95) * lineHeight
        : height - (lane + 0.15) * lineHeight;
    const color = /^#[a-f0-9]{6}$/i.test(comment.color ?? "") ? comment.color! : "#ffffff";
    results.push({
      text, color, startSeconds, endSeconds, position,
      xPixelsPerSecond: speed, approximateWidth, lane, y, fontSize
    });
  }
  return results;
}

export function visibleTimedComments(
  schedule: ScheduledPreviewComment[], timeSeconds: number, width: number
): Array<ScheduledPreviewComment & { x: number }> {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return [];
  return schedule.filter(item => item.startSeconds <= timeSeconds && item.endSeconds >= timeSeconds)
    .map(item => ({
      ...item,
      x: item.position === "scroll"
        ? width - item.xPixelsPerSecond * (timeSeconds - item.startSeconds)
        : width / 2
    }));
}
