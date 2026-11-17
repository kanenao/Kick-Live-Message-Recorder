/** Kick emote markers are removed only for ASS rendering; source chat remains intact. */
export function formatKickEmoteTokens(content: string, removeEmotes: boolean): string {
  return content.replace(/\[emote:\d+:([^\]\r\n]+)\]/g, (_token, name: string) =>
    removeEmotes ? " " : name
  ).replace(/[ \t]{2,}/g, " ").trim();
}

export type VodChatAssMessage = {
  content: string;
  timeInSeconds: number;
};

type AssLane = { startSeconds: number; endSeconds: number; width: number };

export type VodChatAssOptions = {
  crossingSeconds?: number;
  speedPercent?: number;
  entryOffsetPx?: number;
  rowLimit?: number;
  collisionGap?: number;
  delaySeconds?: number;
};

const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;
const FONT_NAME = "ＭＳ Ｐゴシック";
const FONT_SIZE = 44;
const LANE_TOP = 24;
const LANE_GAP = 56;

const DEFAULT_OPTIONS: Required<VodChatAssOptions> = {
  crossingSeconds: 6,
  speedPercent: 100,
  entryOffsetPx: 16,
  rowLimit: 16,
  collisionGap: 40,
  delaySeconds: 0
};

function boundedOption(
  source: Record<string, unknown>, key: keyof VodChatAssOptions,
  fallback: number, minimum: number, maximum: number
): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

/** Untrusted UI/IPC options are clamped before changing ASS timing or lane allocation. */
export function normalizeVodChatAssOptions(value: unknown): Required<VodChatAssOptions> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    crossingSeconds: boundedOption(source, "crossingSeconds", DEFAULT_OPTIONS.crossingSeconds, 2, 15),
    speedPercent: boundedOption(source, "speedPercent", DEFAULT_OPTIONS.speedPercent, 50, 200),
    entryOffsetPx: Math.round(boundedOption(source, "entryOffsetPx", DEFAULT_OPTIONS.entryOffsetPx, 0, 300)),
    rowLimit: Math.round(boundedOption(source, "rowLimit", DEFAULT_OPTIONS.rowLimit, 1, 18)),
    collisionGap: Math.round(boundedOption(source, "collisionGap", DEFAULT_OPTIONS.collisionGap, 0, 200)),
    delaySeconds: boundedOption(source, "delaySeconds", DEFAULT_OPTIONS.delaySeconds, -10, 10)
  };
}

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

export function escapeVodAssText(value: string, removeEmotes = false): string {
  return formatKickEmoteTokens(value, removeEmotes)
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

/** Nico-style right-to-left flow with adjustable entry, timing and collision-safe lanes. */
export class VodChatAssComposer {
  private readonly lanes: Array<AssLane | null>;
  private readonly durationSeconds: number;
  private readonly removeEmotes: boolean;
  private readonly options: Required<VodChatAssOptions>;

  constructor(durationSeconds: number, removeEmotes = false, options: unknown = {}) {
    this.durationSeconds = durationSeconds;
    this.removeEmotes = removeEmotes;
    this.options = normalizeVodChatAssOptions(options);
    this.lanes = Array.from({ length: this.options.rowLimit }, () => null);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 7 * 24 * 60 * 60) {
      throw new Error("VODの再生時間が正しくありません。");
    }
  }

  createDialogue(message: VodChatAssMessage): string | null {
    if (!Number.isFinite(message.timeInSeconds)) return null;
    const start = message.timeInSeconds + this.options.delaySeconds;
    if (start < 0 || start >= this.durationSeconds) return null;
    const text = escapeVodAssText(message.content, this.removeEmotes);
    if (!text) return null;

    const width = estimateTextWidth(text) + 32;
    const entranceX = PLAY_RES_X + this.options.entryOffsetPx;
    const speed = (PLAY_RES_X / this.options.crossingSeconds) * (this.options.speedPercent / 100);
    const travelSeconds = (entranceX + width) / speed;
    const end = Math.min(this.durationSeconds, start + travelSeconds);
    if (end <= start) return null;

    let laneIndex = -1;
    for (let index = 0; index < this.lanes.length; index += 1) {
      const previous = this.lanes[index];
      // A new comment may enter only after the previous trailing edge has cleared the gap.
      const clearance = previous
        ? speed * (start - previous.startSeconds) - previous.width
        : Number.POSITIVE_INFINITY;
      if (!previous || start >= previous.endSeconds || clearance >= this.options.collisionGap) {
        laneIndex = index;
        break;
      }
    }
    // Never reuse an occupied lane while comments overlap. Skip only when all lanes are full.
    if (laneIndex < 0) return null;
    this.lanes[laneIndex] = { startSeconds: start, endSeconds: end, width };

    const y = LANE_TOP + laneIndex * LANE_GAP;
    const moveMilliseconds = Math.max(1, Math.round((end - start) * 1000));
    const tags = "{\\\\move(" + entranceX + "," + y + "," + Math.round(-width) + "," + y +
      ",0," + moveMilliseconds + ")" +
      "\\\\fn" + FONT_NAME + "\\\\b1\\\\1c&H00FFFFFF&\\\\bord3.2\\\\shad1}";
    return "Dialogue: 0," + formatVodAssTimestamp(start) + "," + formatVodAssTimestamp(end) +
      ",Default,,0,0,0,," + tags + text;
  }
}
