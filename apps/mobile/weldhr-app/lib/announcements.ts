/**
 * Announcements from HR: the order they are listed in, the one-line preview
 * under a title, and how long ago one was published. The words for "3 hours
 * ago" come from the catalog, so `ageOf` only says which one applies.
 */

import { dayOf, parseIsoDate, todayIso } from './dates';

/** What listing needs from an announcement. */
export interface Listed {
  pinned: boolean;
  publishedAt: string;
}

const time = (iso: string) => new Date(iso).getTime();

/** Pinned first, then the newest. The API already sends them this way; a refetch merged with a push may not. */
export function sortAnnouncements<T extends Listed>(announcements: T[]): T[] {
  return [...announcements].sort((a, b) => Number(b.pinned) - Number(a.pinned) || time(b.publishedAt) - time(a.publishedAt));
}

/** The body on one line for a list row: line breaks and runs of spaces collapse, a long text ends in "…". */
export function bodyPreview(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

export type Age =
  | { kind: 'now' }
  | { kind: 'minutes'; count: number }
  | { kind: 'hours'; count: number }
  | { kind: 'yesterday' }
  | { kind: 'days'; count: number }
  /** A week or more: show the date. */
  | { kind: 'date' };

/** Whole calendar days from `earlier` to `later` (both `YYYY-MM-DD`), DST-proof. */
function daysBetween(earlier: string, later: string): number {
  const from = parseIsoDate(earlier);
  const to = parseIsoDate(later);
  if (!from || !to) return 0;
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86_400_000);
}

/** How long before `now` something was published; a time in the future counts as just now. */
export function ageOf(publishedAt: string, now: number = Date.now()): Age {
  const minutes = Math.floor((now - time(publishedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return { kind: 'now' };
  if (minutes < 60) return { kind: 'minutes', count: minutes };

  const days = daysBetween(dayOf(publishedAt), todayIso(new Date(now)));
  if (days < 1) return { kind: 'hours', count: Math.floor(minutes / 60) };
  if (days === 1) return { kind: 'yesterday' };
  if (days < 7) return { kind: 'days', count: days };
  return { kind: 'date' };
}
