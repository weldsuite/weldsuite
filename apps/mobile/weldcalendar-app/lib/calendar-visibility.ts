/**
 * Which calendars the agenda and the month grid draw.
 *
 * The platform keeps the same state in `localStorage` under
 * `weldcalendar:active-calendars`; this is the mobile equivalent, backed by
 * AsyncStorage.
 *
 * Stored as a HIDDEN set rather than a visible one on purpose: a calendar
 * created later (or newly shared with you) should appear without the user
 * hunting for a toggle, which an allow-list would not do.
 *
 * Exposed through `useSyncExternalStore` so the Calendars tab and the two
 * reading tabs stay in step without a context provider — three screens
 * sharing one boolean per row does not warrant one.
 */

import { useCallback, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const HIDDEN_CALENDARS_KEY = '@weldsuite/weldcalendar:hidden-calendars';

let hidden: ReadonlySet<string> = new Set();
let hydrated = false;
const listeners = new Set<() => void>();

/** Stable empty-array identity so `getSnapshot` never trips React's loop guard. */
const EMPTY: readonly string[] = Object.freeze([]);
let snapshot: readonly string[] = EMPTY;

function emit() {
  const next = Array.from(hidden).sort();
  snapshot = next.length === 0 ? EMPTY : Object.freeze(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly string[] {
  return snapshot;
}

async function persist() {
  try {
    await AsyncStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify(Array.from(hidden)));
  } catch {
    // Persistence is best-effort; the in-memory set still drives this session.
  }
}

/** Load the persisted set once, before the first screen reads it. */
export async function hydrateCalendarVisibility(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(HIDDEN_CALENDARS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      hidden = new Set(parsed.filter((id): id is string => typeof id === 'string'));
      emit();
    }
  } catch {
    // A corrupt value just means everything stays visible.
  }
}

export function setCalendarHidden(calendarId: string, isHidden: boolean): void {
  const next = new Set(hidden);
  if (isHidden) next.add(calendarId);
  else next.delete(calendarId);
  hidden = next;
  emit();
  void persist();
}

export function toggleCalendarHidden(calendarId: string): void {
  setCalendarHidden(calendarId, !hidden.has(calendarId));
}

/** Test-only: drop all state so a suite can start from a clean slate. */
export function resetCalendarVisibilityForTests(): void {
  hidden = new Set();
  hydrated = false;
  snapshot = EMPTY;
}

export interface CalendarVisibility {
  hiddenIds: readonly string[];
  isHidden: (calendarId: string) => boolean;
  toggle: (calendarId: string) => void;
  /**
   * The ids to send as `calendarIds`, or `undefined` when nothing is hidden —
   * the routes treat an absent filter as "every calendar I can read", which is
   * both cheaper and correct for a calendar shared mid-session.
   */
  visibleIdsParam: (all: { id: string }[]) => string | undefined;
}

export function useCalendarVisibility(): CalendarVisibility {
  const hiddenIds = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isHidden = useCallback(
    (calendarId: string) => hiddenIds.includes(calendarId),
    [hiddenIds],
  );

  const visibleIdsParam = useCallback(
    (all: { id: string }[]) => {
      if (hiddenIds.length === 0) return undefined;
      const visible = all.filter((c) => !hiddenIds.includes(c.id)).map((c) => c.id);
      // Every calendar hidden: send a sentinel the route cannot match rather
      // than `undefined`, which would silently show everything.
      return visible.length > 0 ? visible.join(',') : '__none__';
    },
    [hiddenIds],
  );

  return { hiddenIds, isHidden, toggle: toggleCalendarHidden, visibleIdsParam };
}
