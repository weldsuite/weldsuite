/**
 * The player's timeline: a seekable track with the idle stretches greyed out
 * and a lane of markers underneath for pages, clicks, frustration, errors and
 * custom events. A slider for assistive tech: arrow keys move five seconds.
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
    <div className="grid gap-1">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={tp.timeline}
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={tp.position.replace('{current}', formatClock(current)).replace('{total}', formatClock(total))}
        className="relative h-3 cursor-pointer touch-none rounded-full bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
        {inactive.map((range) => (
          <div
            key={`${range.startMs}-${range.endMs}`}
            data-testid="timeline-idle"
            title={tp.idle}
            className="absolute inset-y-0 rounded-full bg-[repeating-linear-gradient(135deg,transparent,transparent_3px,var(--border)_3px,var(--border)_6px)]"
            style={{ left: percent(range.startMs), width: percent(range.endMs - range.startMs) }}
          />
        ))}
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary/70" style={{ width: percent(current) }} />
        <div className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow" style={{ left: percent(current) }} />
      </div>
      <div className="relative h-4" role="group" aria-label={tp.markers}>
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            title={`${formatClock(marker.offsetMs)} · ${marker.label}`}
            aria-label={`${t.weldpanel.observe.session.events.kinds[marker.kind]} ${formatClock(marker.offsetMs)}: ${marker.label}`}
            className="absolute top-0 flex h-4 w-3 -translate-x-1/2 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

/** The key to the marker colours. */
export function TimelineLegend() {
  const { t } = useI18n();
  const tl = t.weldpanel.observe.player.legend;
  const kinds: MarkerKind[] = ['page', 'click', 'frustration', 'error', 'custom'];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {kinds.map((kind) => (
        <li key={kind} className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-full', MARKER_STYLES[kind])} aria-hidden />
          {tl[kind]}
        </li>
      ))}
    </ul>
  );
}
