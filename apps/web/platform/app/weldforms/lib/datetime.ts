/** The opening and closing times: the API's ISO timestamps (with offset) and the `Date` a picker holds. */

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO timestamp to a `Date`; undefined for null or garbage. */
export function isoToDate(iso: string | null): Date | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A local time to an ISO timestamp with the local offset, to the minute; null when empty or invalid. */
export function dateToIso(date: Date | undefined): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Whether a form would close before (or as) it opens, so it could never take a response. */
export function closesBeforeOpens(opensAt: string | null, closesAt: string | null): boolean {
  if (!opensAt || !closesAt) return false;
  const opens = new Date(opensAt).getTime();
  const closes = new Date(closesAt).getTime();
  return Number.isFinite(opens) && Number.isFinite(closes) && closes <= opens;
}
