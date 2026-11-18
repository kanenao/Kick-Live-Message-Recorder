/**
 * Bound local-ASR work while sampling the WHOLE video for long broadcasts.
 * "sampled" means other audio intervals were not transcribed.
 */
export const ARTICLE_AUDIO_WINDOW_SECONDS = 45;
export const ARTICLE_AUDIO_CONTIGUOUS_LIMIT_SECONDS = 2 * 60 * 60;
export const ARTICLE_AUDIO_LONG_SAMPLE_LIMIT = 48;

export type ArticleAudioWindow = { startSeconds: number; durationSeconds: number };
export type ArticleAudioSamplingMode = "continuous" | "distributed";

export function articleAudioSamplingMode(durationSeconds: number): ArticleAudioSamplingMode {
  return Number.isFinite(durationSeconds) && durationSeconds > ARTICLE_AUDIO_CONTIGUOUS_LIMIT_SECONDS
    ? "distributed" : "continuous";
}

/** For short recordings use contiguous 45-second windows; for long ones sample all hours. */
export function planArticleAudioWindows(durationSeconds: number): ArticleAudioWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const duration = durationSeconds;
  if (articleAudioSamplingMode(duration) === "continuous") {
    const count = Math.ceil(duration / ARTICLE_AUDIO_WINDOW_SECONDS);
    return Array.from({ length: count }, (_, index) => {
      const startSeconds = index * ARTICLE_AUDIO_WINDOW_SECONDS;
      return {
        startSeconds,
        durationSeconds: Math.min(ARTICLE_AUDIO_WINDOW_SECONDS, duration - startSeconds)
      };
    });
  }
  const count = ARTICLE_AUDIO_LONG_SAMPLE_LIMIT;
  const finalStart = Math.max(0, duration - ARTICLE_AUDIO_WINDOW_SECONDS);
  return Array.from({ length: count }, (_, index) => {
    const startSeconds = Math.round((finalStart * index / (count - 1)) * 1000) / 1000;
    return {
      startSeconds,
      durationSeconds: Math.min(ARTICLE_AUDIO_WINDOW_SECONDS, duration - startSeconds)
    };
  });
}
