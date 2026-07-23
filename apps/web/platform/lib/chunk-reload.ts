// Recovery from "stale chunk" failures after a redeploy.
//
// The platform is a Vite SPA on Cloudflare Pages. Each build emits
// content-hashed chunks (e.g. `call-overlay-DxU6oOZU.js`). When a new build is
// deployed, every hash changes and Pages only serves the *latest* deployment on
// the production alias, so a tab still running the previous build's entry asks
// for a chunk that no longer exists. Pages answers the 404 with the SPA
// fallback `index.html` (MIME `text/html`), and the dynamic `import()` throws
// "Failed to fetch dynamically imported module".
//
// The cure is to force the stale tab to reload once so it boots the new
// `index.html` with the current hash map. The guard below prevents a genuinely
// broken deploy (chunk missing in the *new* build too) from reload-looping.

const RELOAD_KEY = 'weldsuite:chunk-reload-at';
// A real reload + reboot is near-instant; a legitimate post-deploy recovery
// will not re-throw within this window. A repeat error inside it means the new
// build is itself broken — show the error instead of looping.
const MIN_RELOAD_INTERVAL_MS = 10_000;

/** True when `error` looks like a stale dynamic-import / module-preload failure. */
export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return false;
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) || // Safari
    (/module script/i.test(message) && /text\/html/i.test(message)) // wrong MIME
  );
}

/**
 * Force a one-time hard reload to pick up the latest build. Guarded by
 * `sessionStorage` so a broken deploy cannot reload-loop. Returns `true` when a
 * reload was triggered, `false` when suppressed by the guard.
 */
export function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < MIN_RELOAD_INTERVAL_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode / blocked) — reload once anyway.
  }
  window.location.reload();
  return true;
}
