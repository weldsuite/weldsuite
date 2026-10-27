/**
 * The collector, which also serves the snippet. Its own module, so
 * `./install` (imported by panel-api, a Worker) doesn't pull in browser code.
 */
export const DEFAULT_HOST = 'https://pnl.weldsuite.org';

/** `https://pnl.weldsuite.org///` → `https://pnl.weldsuite.org`, without a backtracking regex. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
