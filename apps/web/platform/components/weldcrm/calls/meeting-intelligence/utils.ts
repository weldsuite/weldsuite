import type { FlatTimelineSegment, TranscriptionData } from './types';

/** True while a transcription row is still being produced (pending / processing). */
export function isTranscriptionInProgress(status: string | undefined): boolean {
  return status === 'pending' || status === 'processing';
}

/**
 * A failed or still-running transcription row has no content to show, so it
 * must not count as "has a transcription" (that would hide the Transcribe
 * button and the failed state).
 */
export function usableTranscription(data: TranscriptionData | null | undefined): TranscriptionData | null {
  if (!data || data.status === 'failed' || isTranscriptionInProgress(data.status)) return null;
  return data;
}


export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatSegmentTime(seconds: number): string {
  if (Number.isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDurationMin(seconds: number): string {
  const mins = Math.round(seconds / 60);
  return mins > 0 ? `${mins}min` : '<1min';
}export function detectPlatform(platform?: string, meetingUrl?: string): { name: string; icon: string } | null {
  const p = (platform || '').toLowerCase();
  const url = (meetingUrl || '').toLowerCase();

  if (p.includes('google') || url.includes('meet.google')) {
    return { name: 'Google Meet', icon: '/logos/google-meet.png' };
  }
  if (p.includes('teams') || p.includes('microsoft') || url.includes('teams.microsoft')) {
    return { name: 'Microsoft Teams', icon: '/logos/teams.svg' };
  }
  if (p.includes('zoom') || url.includes('zoom.us')) {
    return { name: 'Zoom', icon: '/logos/zoom.svg' };
  }
  return null;
}

export function parseSpeakerId(speakerLabel: string): number {
  const match = /\d+/.exec(speakerLabel);
  return match ? Number.parseInt(match[0]) : 0;
}

const MAGNET_ZONE = 0.3;

/**
 * Applies the hover state of a timeline track: highlights the hovered speaker
 * segment and moves (or snaps) the hover cursor to the pointer position.
 */
export function showSegmentHover(
  highlight: HTMLDivElement | null,
  cursor: HTMLDivElement | null,
  seg: FlatTimelineSegment,
  duration: number,
  trackWidth: number,
  x: number,
  highlightHeight: string,
): void {
  const segLeftPx = (seg.start / duration) * trackWidth;
  const segWidthPx = ((seg.end - seg.start) / duration) * trackWidth;
  const localPercent = (x - segLeftPx) / segWidthPx;
  const snapped = localPercent < MAGNET_ZONE;
  if (highlight) {
    highlight.style.left = `${(seg.start / duration) * 100}%`;
    highlight.style.width = `${Math.max(0.3, ((seg.end - seg.start) / duration) * 100)}%`;
    highlight.style.backgroundColor = seg.hex;
    highlight.style.opacity = '0.9';
    highlight.style.height = highlightHeight;
  }
  if (cursor) {
    cursor.style.left = `${snapped ? segLeftPx : x}px`;
    cursor.style.transition = snapped ? 'left 0.15s ease-out' : 'none';
    cursor.style.opacity = '1';
  }
}

/** Clears the timeline hover state applied by {@link showSegmentHover}. */
export function hideSegmentHover(highlight: HTMLDivElement | null, cursor: HTMLDivElement | null): void {
  if (highlight) {
    highlight.style.opacity = '0';
    highlight.style.height = '4px';
  }
  if (cursor) cursor.style.opacity = '0';
}
