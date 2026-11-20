/**
 * A link to one event: `/weldcalendar?date=yyyy-MM-dd&eventId=…`, the form the
 * top-bar calendar panel (and anything else pointing at an event) writes.
 */
export interface EventLink {
  /** The day to show, local midnight. */
  date: Date | null;
  eventId: string | null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day and event a link points at. `yyyy-MM-dd` is read as a local day
 * (`new Date('2026-11-18')` would be UTC midnight, the day before west of UTC);
 * anything else gives no date.
 */
export function parseEventLink(date: string | null, eventId: string | null): EventLink {
  const match = date ? DAY.exec(date) : null;
  let day: Date | null = null;
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const candidate = new Date(y, m - 1, d);
    if (candidate.getFullYear() === y && candidate.getMonth() === m - 1 && candidate.getDate() === d) day = candidate;
  }
  return { date: day, eventId: eventId || null };
}
