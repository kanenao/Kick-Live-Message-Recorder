export type VodChatAssMessage = {
  content: string;
  timeInSeconds: number;
};

type AssLane = { startSeconds: number; width: number };

const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;
const FONT_NAME = "ＭＳ Ｐゴシック";
const FONT_SIZE = 44;
const SCROLL_SPEED = 220;
const LANE_COUNT = 18;
const LANE_TOP = 24;
const LANE_GAP = 56;
const MIN_COMMENT_GAP = 84;

export function formatVodAssTimestamp(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalCentiseconds = Math.floor(safeSeconds * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return hour + ":" + String(minute).padStart(2, "0") + ":" +
    String(second).padStart(2, "0") + "." + String(centiseconds).padStart(2, "0");
}

export function escapeVodAssText(value: string): string {
  return value
    .replace(/\[emote:\d+:([^\]]+)\]/g, "$1")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .trim()
    .slice(0, 500);
}

function estimateTextWidth(text: string): number {
  let units = 0;
  for (const character of Array.from(text)) {
    const code = character.codePointAt(0) ?? 0;
    units += code <= 0x00ff ? 0.58 : code >= 0x1f000 ? 1.15 : 1;
  }
  return Math.max(FONT_SIZE, Math.ceil(units * FONT_SIZE));
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 240);
}

export function createVodChatAssHeader(channelSlug: string, title: string): string {
  return [
    "[Script Info]",
    "Title: Kick VOD Comments - " + safeHeaderValue(channelSlug) + " - " + safeHeaderValue(title),
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "PlayResX: " + PLAY_RES_X,
    "PlayResY: " + PLAY_RES_Y,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default," + FONT_NAME + "," + FONT_SIZE + ",&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3.2,1,7,14,14,14,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ""
  ].join("\n");
}

/** Right-to-left Nico-style comments, preserving all comments with bounded lane reuse. */
export class VodChatAssComposer {
  private readonly lanes: Array<AssLane | null> = Array.from({ length: LANE_COUNT }, () => null);

  constructor(private readonly durationSeconds: number) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 7 * 24 * 60 * 60) {
      throw new Error("VODの再生時間が正しくありません。");
    }
  }

  createDialogue(message: VodChatAssMessage): string | null {
    if (!Number.isFinite(message.timeInSeconds) || message.timeInSeconds < 0 ||
      message.timeInSeconds >= this.durationSeconds) return null;
    const text = escapeVodAssText(message.content);
    if (!text) return null;

    const start = message.timeInSeconds;
    const width = estimateTextWidth(text) + 32;
    let laneIndex = -1;
    let earliestRelease = Number.POSITIVE_INFINITY;
    let fallbackLane = 0;
    for (let index = 0; index < this.lanes.length; index += 1) {
      const previous = this.lanes[index];
      if (!previous) {
        laneIndex = index;
        break;
      }
      const gapAtStart = (start - previous.startSeconds) * SCROLL_SPEED - previous.width;
      if (gapAtStart >= MIN_COMMENT_GAP) {
        laneIndex = index;
        break;
      }
      const releaseAt = previous.startSeconds + (previous.width + MIN_COMMENT_GAP) / SCROLL_SPEED;
      if (releaseAt < earliestRelease) {
        earliestRelease = releaseAt;
        fallbackLane = index;
      }
    }
    if (laneIndex < 0) laneIndex = fallbackLane;
    this.lanes[laneIndex] = { startSeconds: start, width };

    const y = LANE_TOP + laneIndex * LANE_GAP;
    const moveDuration = (PLAY_RES_X + width + 32) / SCROLL_SPEED;
    const end = Math.min(this.durationSeconds, start + moveDuration);
    if (end <= start) return null;
    const moveMilliseconds = Math.max(1, Math.round(moveDuration * 1000));
    const tags = "{\\move(" + (PLAY_RES_X + 16) + "," + y + "," + Math.round(-width) + "," + y +
      ",0," + moveMilliseconds + ")" +
      "\\fn" + FONT_NAME + "\\b1\\1c&H00FFFFFF&\\bord3.2\\shad1}";
    return "Dialogue: 0," + formatVodAssTimestamp(start) + "," + formatVodAssTimestamp(end) +
      ",Default,,0,0,0,," + tags + text;
  }
}
