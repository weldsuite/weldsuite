import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';

/** The slice of the shared `ActiveFilter` the calendar reads (kept structural so tests need no UI imports). */
export interface EventFilter {
  field: string;
  operator: string;
  value: string;
}

/**
 * `FilterPills` emits `'is not'` (with a space); older callers and saved
 * state used `'is_not'`. Both mean "negate the match".
 */
const NEGATED_OPERATORS = new Set(['is not', 'is_not']);

export function isNegatedOperator(operator: string): boolean {
  return NEGATED_OPERATORS.has(operator);
}

/** Does `event` satisfy the field = value comparison of one filter (before negation)? `null` = unknown field. */
function matchesFieldValue(event: CalendarEvent, field: string, value: string): boolean | null {
  switch (field) {
    case 'type':
      return event.type === value;
    case 'calendar':
      return event.calendarId === value;
    case 'status':
      return event.status === value;
    case 'priority':
      return event.priority === value;
    case 'allDay':
      return String(event.allDay || false) === value;
    default:
      return null;
  }
}

/** True when the event passes one filter. Incomplete filters (no value yet) and unknown fields pass. */
export function matchesEventFilter(event: CalendarEvent, filter: EventFilter): boolean {
  if (!filter.value) return true;
  const match = matchesFieldValue(event, filter.field, filter.value);
  if (match === null) return true;
  return isNegatedOperator(filter.operator) ? !match : match;
}

/** True when the event passes every filter. */
export function matchesEventFilters(event: CalendarEvent, filters: readonly EventFilter[]): boolean {
  return filters.every((f) => matchesEventFilter(event, f));
}

/** Events that pass every filter; returns the same array when there is nothing to filter. */
export function applyEventFilters(events: CalendarEvent[], filters: readonly EventFilter[]): CalendarEvent[] {
  if (filters.length === 0) return events;
  return events.filter((evt) => matchesEventFilters(evt, filters));
}

/** Fields the free-text search looks at, in the order a user is most likely to remember them. */
function searchHaystacks(evt: CalendarEvent): (string | undefined | null)[] {
  return [
    evt.title,
    evt.description,
    evt.location,
    evt.meetingUrl,
    evt.notes,
    ...(evt.attendees?.flatMap((a) => [a.name, a.email]) ?? []),
    ...(evt.tags ?? []),
  ];
}

/** Case-insensitive text match of a query against an event's searchable fields. */
export function matchesEventSearch(evt: CalendarEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return searchHaystacks(evt).some((s) => typeof s === 'string' && s.toLowerCase().includes(q));
}

/**
 * Merges the server's search hits (all dates) with the loaded range's local
 * matches (which also look at location, attendees and tags), drops duplicates
 * and orders them: upcoming events soonest first, then past ones newest first.
 */
export function mergeSearchResults(
  serverHits: readonly CalendarEvent[],
  localMatches: readonly CalendarEvent[],
  now: number,
): CalendarEvent[] {
  const byId = new Map<string, CalendarEvent>();
  for (const evt of [...localMatches, ...serverHits]) {
    const key = evt.id ?? `${evt.title}|${String(evt.startTime)}`;
    if (!byId.has(key)) byId.set(key, evt);
  }
  const time = (e: CalendarEvent) => new Date(e.startTime).getTime();
  const all = [...byId.values()];
  const upcoming = all.filter((e) => time(e) >= now).sort((a, b) => time(a) - time(b));
  const past = all.filter((e) => time(e) < now).sort((a, b) => time(b) - time(a));
  return [...upcoming, ...past];
}
