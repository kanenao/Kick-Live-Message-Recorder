export type ArticleAnalysisQueue = {
  pendingComments: number;
  pendingAudio: boolean;
  pendingVisual: boolean;
  lastAnalysisAt: number;
  intervalSeconds: number;
  now: number;
};

/** Include sparse chats in LIVE articles without repeatedly invoking Ollama for each message. */
export function nextLiveArticleAnalysisDelayMs(input: ArticleAnalysisQueue): number | null {
  if (input.pendingComments <= 0 && !input.pendingAudio && !input.pendingVisual) return null;
  const intervalMs = Math.max(30, Math.min(600,
    Number.isFinite(input.intervalSeconds) ? input.intervalSeconds : 120)) * 1000;
  if (input.lastAnalysisAt <= 0) {
    // Give small streams up to 30 seconds to collect multiple comments.
    return input.pendingAudio || input.pendingVisual || input.pendingComments >= 12
      ? 0 : Math.min(30_000, intervalMs);
  }
  return Math.max(0, intervalMs - Math.max(0, input.now - input.lastAnalysisAt));
}
