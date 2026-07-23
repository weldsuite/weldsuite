import { useMemo } from 'react';
import type { TranscriptionSegment } from './types';

/**
 * Binary search for the word active at `time` within a sorted words array.
 * When time falls in a gap between words, returns the next upcoming word
 * for a "karaoke" effect. Returns -1 only when outside the segment bounds.
 */
function findActiveWordIndex(
  words: Array<{ start: number; end: number }>,
  time: number,
): number {
  if (words.length === 0) return -1;
  if (time < words[0].start) return -1;
  if (time > words[words.length - 1].end) return -1;

  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (time < words[mid].start) {
      hi = mid - 1;
    } else if (time > words[mid].end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  // Time is in a gap between words — highlight the upcoming word
  return lo < words.length ? lo : words.length - 1;
}

export function useActiveWord(
  segments: TranscriptionSegment[] | undefined,
  activeSegmentId: string | null,
  currentTime: number,
): number {
  const activeSegment = useMemo(() => {
    if (!activeSegmentId || !segments) return null;
    return segments.find((s) => s.id === activeSegmentId) ?? null;
  }, [segments, activeSegmentId]);

  if (!activeSegment?.words?.length) return -1;
  return findActiveWordIndex(activeSegment.words, currentTime);
}
