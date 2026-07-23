// Shared loader for the lazy WeldAgent panel chunk (~140 KB).
//
// Both the `React.lazy` boundary in `global-agent-shortcut.tsx` and the
// open-gate in `use-weldagent-drawer-open.ts` import the panel through this
// single cached promise. That lets us:
//   1. keep the chunk out of the initial page-load waterfall, and
//   2. wait for it to be ready before flipping the drawer open — so the page's
//      width reservation and the panel's first paint land in the same frame
//      instead of the layout shifting first and the panel appearing a beat later.
//
// This module itself is tiny and safe to import eagerly — the heavy chunk is
// only fetched when `loadWeldAgentPanel()` is actually called.

type WeldAgentModule = typeof import('./index');

let cached: Promise<WeldAgentModule> | null = null;
let loaded = false;

/** Loads (or returns the in-flight/cached load of) the WeldAgent panel chunk. */
export function loadWeldAgentPanel(): Promise<WeldAgentModule> {
  if (!cached) {
    cached = import('./index')
      .then((m) => {
        loaded = true;
        return m;
      })
      .catch((err) => {
        // Allow a later attempt to retry after a transient network failure.
        cached = null;
        throw err;
      });
  }
  return cached;
}

/** Synchronous check: has the chunk finished loading? */
export function isWeldAgentPanelLoaded(): boolean {
  return loaded;
}
