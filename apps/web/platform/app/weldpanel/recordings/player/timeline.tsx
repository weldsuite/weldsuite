/**
 * The player's timeline, drawn on the dark scrim over the stage: a thin
 * seekable track (thicker on hover) with the idle stretches hatched and a lane
 * of markers underneath for pages, clicks, frustration, errors and custom
 * events. A slider for assistive tech: arrow keys move five seconds.
 */

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatClock, type MarkerKind, type TimelineMarker, type TimeRange } from '../../lib/replay';

export const MARKER_STYLES: Record<MarkerKind, string> = {
  page: 'bg-sky-500',
  click: 'bg-slate-400 dark:bg-slate-300',
  frustration: 'bg-orange-500',
  error: 'bg-red-600',
  custom: 'bg-violet-500',
};

const SEEK_STEP_MS = 5_000;
/** Land a little before an event, so the cause is on screen too. */
const LEAD_IN_MS = 1_500;

interface TimelineProps {
  total: number;
  current: number;
  markers: readonly TimelineMarker[];
  inactive: readonly TimeRange[];
  onSeek: (ms: number) => void;
}

export function Timeline({ total, current, markers, inactive, onSeek }: Readonly<TimelineProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.observe.player;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const safeTotal = Math.max(total, 1);
  const percent = (ms: number) => `${Math.min(100, Math.max(0, (ms / safeTotal) * 100))}%`;

  function seekFromPointer(event: PointerEvent) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onSeek(ratio * safeTotal);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onSeek(Math.min(total, current + SEEK_STEP_MS));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onSeek(Math.max(0, current - SEEK_STEP_MS));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onSeek(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      onSeek(total);
    }
  }

  return (
    <div className="grid gap-0.5">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={tp.timeline}
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={tp.position.replace('{current}', formatClock(current)).replace('{total}', formatClock(total))}
        className="group/seek relative h-4 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) seekFromPointer(event);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {/* The track: 4px, 6px under the pointer, centred in the 16px hit area. */}
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25 transition-[height] group-hover/seek:h-1.5 motion-reduce:transition-none">
          {inactive.map((range) => (
            <div
              key={`${range.startMs}-${range.endMs}`}
              data-testid="timeline-idle"
              title={tp.idle}
              className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,transparent,transparent_2px,rgb(255_255_255/0.35)_2px,rgb(255_255_255/0.35)_4px)]"
              style={{ left: percent(range.startMs), width: percent(range.endMs - range.startMs) }}
            />
          ))}
          <div className="absolute inset-y-0 left-0 bg-white/90" style={{ width: percent(current) }} />
        </div>
        <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md" style={{ left: percent(current) }} />
      </div>
      <div className="relative h-3" role="group" aria-label={tp.markers}>
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            title={`${formatClock(marker.offsetMs)} · ${marker.label}`}
            aria-label={`${t.weldpanel.observe.session.events.kinds[marker.kind]} ${formatClock(marker.offsetMs)}: ${marker.label}`}
            className="absolute top-0 flex h-3 w-3 -translate-x-1/2 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            style={{ left: percent(marker.offsetMs) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onSeek(Math.max(0, marker.offsetMs - LEAD_IN_MS))}
          >
            <span className={cn('block rounded-full', MARKER_STYLES[marker.kind], marker.kind === 'frustration' || marker.kind === 'error' ? 'size-2.5' : 'size-2')} />
          </button>
        ))}
      </div>
    </div>
  );
}
