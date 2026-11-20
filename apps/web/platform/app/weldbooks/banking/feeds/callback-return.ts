/**
 * The bank return this page load is finishing, run once however often the
 * callback page mounts. The return URL carries one-time codes and the pending
 * link is taken on the first read, so a second mount (React's dev double
 * effect, or the app shell unmounting the page while it settles the
 * workspace) must wait for the run already going instead of starting another,
 * which would find no pending link and report the connection as lost.
 * Forgotten once the page leaves, so coming back to the URL never replays it.
 */
let current: { key: string; outcome: Promise<unknown> } | null = null;

/** The run for the return `key` names (its query string): the one going, or `start()`. */
export function finishReturnOnce<T>(key: string, start: () => Promise<T>): Promise<T> {
  if (current?.key !== key) current = { key, outcome: start() };
  return current.outcome as Promise<T>;
}

/** Done with the return: the page has left it (a new page load starts empty too). */
export function forgetReturn(): void {
  current = null;
}
