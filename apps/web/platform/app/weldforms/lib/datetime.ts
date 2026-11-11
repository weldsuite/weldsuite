/** `<input type="datetime-local">` values and the API's ISO timestamps (with offset). */

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO timestamp to the local `YYYY-MM-DDTHH:mm` an input shows; '' for null or garbage. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The input's local time to an ISO timestamp with the local offset; null when empty or invalid. */
export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${isoToLocalInput(date.toISOString().replace('Z', '+00:00'))}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
