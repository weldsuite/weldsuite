/** Between ISO instants and the values of `<input type="datetime-local">` / `type="date"` (the viewer's own time zone). */

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-03-01T14:05:00Z` → `2026-03-01T15:05` (in Amsterdam). Empty for a missing or broken value. */
export function toLocalDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` (or `date`) value as an ISO instant; null when it is empty or not a date. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  // `YYYY-MM-DD` alone is read as UTC by `Date`; a date input means the viewer's own midnight.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `2026-03-01` for a date input, from an ISO instant (the viewer's day). */
export function toLocalDateInput(iso: string | null | undefined): string {
  return toLocalDateTimeInput(iso).slice(0, 10);
}

/** An ISO instant `days` from now. */
export function daysFromNow(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
