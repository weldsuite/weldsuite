// Recovery from "stale chunk" failures after a redeploy.
//
// The platform is a Vite SPA on Cloudflare Pages. Each build emits
// content-hashed chunks (e.g. `call-overlay-DxU6oOZU.js`). When a new build is
// deployed, every hash changes and Pages only serves the *latest* deployment on
// the production alias, so a tab still running the previous build's entry asks
// for a chunk that no longer exists.
//
// Historically Pages answered that miss with the SPA fallback `index.html`
// (200, MIME `text/html`), and the dynamic `import()` threw either "Failed to
// fetch dynamically imported module" or the stricter "Expected a
// JavaScript-or-Wasm module script but the server responded with a MIME type of
// text/html". `public/assets/404.html` makes misses under /assets/ return a
// real 404 instead; both error shapes are still handled here for older deploys
// and for any edge that still has a poisoned HTML response cached.
//
// The cure is to force the stale tab to reload once so it boots the new
// `index.html` with the current hash map. The guard below prevents a genuinely
// broken deploy (chunk missing in the *new* build too) from reload-looping.
//
// A reload ends any call or meeting the tab is in, so while one is live the
// reload is HELD (`holdStaleChunkReload`, taken by <ReloadHoldDuringCalls/>):
// the failure is recorded instead, and the reload runs once the last hold is
// released, after a short grace period so leaving one call to join another
// (the call switch) does not count as "the call ended".

const RELOAD_KEY = 'weldsuite:chunk-reload-at';
// A real reload + reboot is near-instant; a legitimate post-deploy recovery
// will not re-throw within this window. A repeat error inside it means the new
// build is itself broken — show the error instead of looping.
const MIN_RELOAD_INTERVAL_MS = 10_000;
/**
 * How long after the last call ends a held reload waits. Covers the call
 * switch (leave, then join the next call) and lets the leave reach the server.
 */
export const HELD_RELOAD_GRACE_MS = 3_000;
// TanStack Router's lazyRouteComponent reloads the page on its own when a
// route chunk fails to load, once per error message, remembered under this
// sessionStorage prefix. See `keepRouterFromReloading`.
const ROUTER_RELOAD_KEY_PREFIX = 'tanstack_router_reload:';

/** True when `error` looks like a stale dynamic-import / module-preload failure. */
export function isStaleChunkError(error: unknown): boolean {
  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }
  if (!message) return false;
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) || // Safari
    /Unable to preload CSS for/i.test(message) || // Vite: a chunk's stylesheet is gone
    (/module script/i.test(message) && /text\/html/i.test(message)) // wrong MIME
  );
}

/**
 * What `reloadForStaleChunk` did:
 * - `reloading`: the page is reloading;
 * - `deferred`: a call is live, so the reload waits until it ends;
 * - `suppressed`: the tab reloaded moments ago, so the new build is broken too.
 */
export type StaleChunkReloadOutcome = 'reloading' | 'deferred' | 'suppressed';

/** What the UI shows: whether a call holds the reload, and whether one is waiting. */
export interface StaleChunkReloadState {
  held: boolean;
  pending: boolean;
}

const holds = new Set<object>();
let pending = false;
let heldReloadTimer: ReturnType<typeof setTimeout> | undefined;
let snapshot: StaleChunkReloadState = { held: false, pending: false };
const listeners = new Set<() => void>();

function publish(): void {
  const held = holds.size > 0;
  if (snapshot.held === held && snapshot.pending === pending) return;
  snapshot = { held, pending };
  // Callers may be rendering (the error fallbacks): notify after, so a
  // subscriber's state update never lands in another component's render.
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}

function reloadNow(): boolean {
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

/**
 * Reload once to pick up the latest build. Guarded by `sessionStorage` so a
 * broken deploy cannot reload-loop, and held while a call is live (the reload
 * then runs when the call ends).
 */
export function reloadForStaleChunk(): StaleChunkReloadOutcome {
  if (holds.size > 0) {
    pending = true;
    publish();
    return 'deferred';
  }
  return reloadNow() ? 'reloading' : 'suppressed';
}

/**
 * Hold stale-chunk reloads until the returned release function runs (a call
 * is live). Releasing the last hold runs a reload that was deferred meanwhile,
 * after `HELD_RELOAD_GRACE_MS`, unless a new hold is taken first.
 */
export function holdStaleChunkReload(): () => void {
  const hold = {};
  holds.add(hold);
  clearTimeout(heldReloadTimer);
  heldReloadTimer = undefined;
  publish();
  return () => {
    if (!holds.delete(hold) || holds.size > 0) return;
    publish();
    if (!pending) return;
    heldReloadTimer = setTimeout(() => {
      heldReloadTimer = undefined;
      if (holds.size > 0 || !pending) return;
      pending = false;
      publish();
      reloadNow();
    }, HELD_RELOAD_GRACE_MS);
  };
}

/** For useSyncExternalStore: the same object until something changes. */
export function getStaleChunkReloadState(): StaleChunkReloadState {
  return snapshot;
}

export function subscribeStaleChunkReload(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * TanStack Router's `lazyRouteComponent` reloads the page by itself when a
 * route chunk is missing, outside our hold. Mark the error as already handled
 * the way it checks (`tanstack_router_reload:<message>` in sessionStorage), so
 * a deferred failure reaches the route's error boundary instead.
 * `chunk-reload.test.ts` pins this against the installed router.
 */
export function keepRouterFromReloading(error: unknown): void {
  if (!(error instanceof Error)) return;
  try {
    sessionStorage.setItem(`${ROUTER_RELOAD_KEY_PREFIX}${error.message}`, '1');
  } catch {
    // sessionStorage unavailable: the router cannot reload by itself either.
  }
}
