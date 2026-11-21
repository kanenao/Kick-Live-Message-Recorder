/**
 * Select representative comments by video time, not by raw message count.
 * A 20-minute burst must not take every preview slot when a 3-hour VOD has
 * comments near its end. The original JSONL and ASS export are untouched.
 */
export function samplePreviewCommentsByTime<T extends { seconds: number }>(
  comments: T[],
  durationSeconds: number,
  maximum = 1200
): T[] {
  const cap = Number.isFinite(maximum) ? Math.max(0, Math.min(2000, Math.floor(maximum))) : 1200;
  if (cap === 0 || comments.length === 0) return [];

  const sorted = comments
    .filter(item => Number.isFinite(item.seconds) && item.seconds >= 0)
    .sort((a, b) => a.seconds - b.seconds);
  if (sorted.length <= cap) return sorted;

  const validDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : sorted[sorted.length - 1].seconds + 1;
  // Up to 60 separate time windows, so late or quiet portions are represented.
  // For shorter VODs use fewer windows to avoid oversplitting a few seconds.
  const bucketCount = Math.max(1, Math.min(60, Math.ceil(validDuration / 120)));
  const buckets: T[][] = Array.from({ length: bucketCount }, () => []);
  for (const item of sorted) {
    const bin = Math.min(bucketCount - 1,
      Math.max(0, Math.floor(item.seconds / validDuration * bucketCount)));
    buckets[bin].push(item);
  }

  const allocated = Array<number>(bucketCount).fill(0);
  let remaining = cap;
  // Grant each occupied window an equal initial share, then redistribute
  // leftover slots to busier windows instead of discarding valid comments.
  while (remaining > 0) {
    const available = buckets.map((_, index) => index)
      .filter(index => allocated[index] < buckets[index].length);
    if (available.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / available.length));
    for (const index of available) {
      const take = Math.min(share, buckets[index].length - allocated[index], remaining);
      allocated[index] += take;
      remaining -= take;
      if (remaining === 0) break;
    }
  }

  const sampled: T[] = [];
  for (let index = 0; index < bucketCount; index++) {
    const bucket = buckets[index];
    const count = allocated[index];
    if (!count) continue;
    if (count === bucket.length) {
      sampled.push(...bucket);
      continue;
    }
    for (let i = 0; i < count; i++) {
      // Preserve both earliest and latest comments when a window has >1 slot.
      const sourceIndex = count === 1
        ? Math.floor((bucket.length - 1) / 2)
        : Math.round(i * (bucket.length - 1) / (count - 1));
      sampled.push(bucket[sourceIndex]);
    }
  }
  return sampled.sort((a, b) => a.seconds - b.seconds);
}
