/** The UTC calendar date (`YYYY-MM-DD`) of a timestamp in milliseconds. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
