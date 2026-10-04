/**
 * How an event's status (confirmed / tentative / cancelled) is drawn on the
 * calendar surfaces: grid blocks, month chips, the all-day row, schedule rows
 * and search results share these rules.
 *
 * - cancelled: struck-through title on a faded surface;
 * - tentative: a dashed outline and a striped (lighter) fill on coloured
 *   surfaces, a hollow dot on plain ones.
 *
 * `confirmed` (and any unknown / missing status) renders as before. Note this is
 * separate from the drag / resize "dimmed" state, which fades a block further
 * with `opacity-40`.
 */

import type { CSSProperties } from 'react';

export type EventStatusKind = 'confirmed' | 'tentative' | 'cancelled';

/** Normalised status of an event; anything unrecognised counts as confirmed. */
export function eventStatusKind(event: { status?: string | null }): EventStatusKind {
  const status = event.status?.toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'tentative') return 'tentative';
  return 'confirmed';
}

/** Classes for a coloured, white-text surface (time-grid block, month chip, all-day bar). */
export function statusSurfaceClass(kind: EventStatusKind): string {
  if (kind === 'cancelled') return 'opacity-60';
  if (kind === 'tentative') return 'border border-dashed border-white/80';
  return '';
}

/**
 * Extra inline style for a coloured surface. A tentative event gets diagonal
 * light stripes layered over its colour; the colour itself is kept.
 */
export function statusSurfaceStyle(kind: EventStatusKind): CSSProperties | undefined {
  if (kind !== 'tentative') return undefined;
  return {
    backgroundImage:
      'repeating-linear-gradient(135deg, rgba(255,255,255,0.28) 0, rgba(255,255,255,0.28) 5px, transparent 5px, transparent 10px)',
  };
}

/** Classes for the title text. */
export function statusTitleClass(kind: EventStatusKind): string {
  return kind === 'cancelled' ? 'line-through' : '';
}

/** Classes for a whole plain row (schedule row, search result). */
export function statusRowClass(kind: EventStatusKind): string {
  return kind === 'cancelled' ? 'opacity-60' : '';
}

/**
 * Style of the small colour dot on plain rows: solid for confirmed and
 * cancelled events, a hollow dashed ring for tentative ones.
 */
export function statusDotStyle(kind: EventStatusKind, color: string): CSSProperties {
  if (kind === 'tentative') {
    return { backgroundColor: 'transparent', border: `1.5px dashed ${color}` };
  }
  return { backgroundColor: color };
}
