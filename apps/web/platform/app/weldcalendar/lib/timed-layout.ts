/**
 * Side-by-side layout of the timed blocks in one day column.
 *
 * Events that overlap in time must not hide each other, so each day's blocks are
 * grouped into clusters (chains of overlapping events) and each block in a
 * cluster gets a column. Every block in a cluster is the same width
 * (`1 / columnCount` of the day column), which keeps the layout calm and makes
 * the hit areas predictable for drag and resize.
 *
 * Pure (local-time `Date`s in, plain data out) so it is unit-tested without a
 * layout engine.
 */

import type { SpanEvent, TimedSegment } from './event-days';

/** Smallest height, in px, a timed block is ever drawn with. */
export const MIN_BLOCK_PX = 22;

const HOUR_MS = 60 * 60 * 1000;

/** The time range a block covers, before any minimum height is applied. */
export interface BlockRange {
  start: Date;
  end: Date;
}

export interface TimedPlacement {
  /** Zero-based column inside the event's cluster. */
  column: number;
  /** Number of columns in the event's cluster (>= 1). */
  columnCount: number;
}

/**
 * The range a timed block is drawn over: the day segment when the event crosses
 * midnight, otherwise the event itself (an event without an end lasts an hour).
 * An end that is not after the start is returned as is; callers clamp to the
 * minimum block height.
 */
export function timedBlockRange(event: SpanEvent, segment?: TimedSegment): BlockRange {
  if (segment && (segment.continuesBefore || segment.continuesAfter)) {
    return { start: segment.start, end: segment.end };
  }
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : new Date(start.getTime() + HOUR_MS);
  return { start, end };
}

/**
 * Assign every range a column so that overlapping ranges sit side by side.
 *
 * `minDurationMinutes` is the shortest span a block occupies on screen (the
 * minimum block height converted to minutes): two events that only touch
 * because of that minimum height are still treated as overlapping.
 *
 * The result is aligned with the input order.
 */
export function layoutTimedColumns(
  ranges: readonly BlockRange[],
  minDurationMinutes = 0,
): TimedPlacement[] {
  const minMs = Math.max(0, minDurationMinutes) * 60 * 1000;
  const spans = ranges.map((range, index) => {
    const start = range.start.getTime();
    const end = Math.max(range.end.getTime(), start + minMs);
    return { index, start, end };
  });

  // Earlier first; for equal starts the longer block first so it takes column 0.
  const order = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);

  const placements: TimedPlacement[] = ranges.map(() => ({ column: 0, columnCount: 1 }));

  let cluster: { index: number; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    for (const member of cluster) {
      placements[member.index] = { column: member.column, columnCount: columnEnds.length };
    }
    cluster = [];
    columnEnds = [];
  };

  for (const span of order) {
    if (cluster.length > 0 && span.start >= clusterEnd) closeCluster();

    let column = columnEnds.findIndex((end) => end <= span.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(span.end);
    } else {
      columnEnds[column] = span.end;
    }
    cluster.push({ index: span.index, column });
    clusterEnd = Math.max(clusterEnd, span.end);
  }
  closeCluster();

  return placements;
}

/**
 * Placements for the timed blocks of one day column, in the order of `items`.
 * `hourHeight` converts the minimum block height into minutes.
 */
export function layoutDayTimedEvents<T extends { event: SpanEvent; segment: TimedSegment }>(
  items: readonly T[],
  hourHeight: number,
): TimedPlacement[] {
  const minMinutes = hourHeight > 0 ? (MIN_BLOCK_PX / hourHeight) * 60 : 0;
  return layoutTimedColumns(
    items.map(({ event, segment }) => timedBlockRange(event, segment)),
    minMinutes,
  );
}

/** Inline `left` / `width` for a block, leaving a 3px gutter on each side of its slot. */
export function timedBlockHorizontalStyle(placement: TimedPlacement): { left: string; width: string } {
  const { column, columnCount } = placement;
  return {
    left: `calc(${(column / columnCount) * 100}% + 3px)`,
    width: `calc(${100 / columnCount}% - 6px)`,
  };
}
