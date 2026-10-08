/** Leaves the app for the bank's authorization page. Its own module so tests can stand in for the browser navigating. */
export function navigateAway(url: string): void {
  window.location.assign(url);
}
