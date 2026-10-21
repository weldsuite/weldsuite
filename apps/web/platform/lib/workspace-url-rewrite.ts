/**
 * The workspace in the address bar (FE-013): `/w/{slug}/weldcrm/…`.
 *
 * Routes stay bare (`/weldcrm/…`); the router's URL `rewrite` adds and strips
 * the prefix at the history boundary. `input` strips `/w/{ref}` from the
 * browser URL and remembers `ref`; `output` adds `/w/{activeRef}` to every
 * workspace-scoped link and navigation. Code that reads the router's location
 * keeps seeing bare paths.
 *
 * `activeRef` is set by the app shell once it knows the tab is in the
 * workspace the URL names (components/workspace-url-gate.tsx). Until then
 * links stay bare.
 *
 * Rules the router imposes (docs/plans/workspace-in-url.md, spike result):
 * `output` returns a new URL, never the one it gets; `router.history.*` and
 * plain `<a href>` bypass `output`, so those use `toPublicPath()`.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { LocationRewrite } from '@tanstack/react-router';
import { isWorkspaceScopedPath, parseWorkspacePath, workspacePath } from '@/lib/workspace-url';

export interface WorkspaceUrlState {
  /** The ref the address bar last named (slug or Clerk org id); null until a `/w/` URL is read. */
  urlRef: string | null;
  /** The tab's workspace as links carry it: its slug, or its org id when it has none. */
  activeRef: string | null;
}

let state: WorkspaceUrlState = { urlRef: null, activeRef: null };
const listeners = new Set<() => void>();
let notifyQueued = false;

function update(next: Partial<WorkspaceUrlState>): void {
  const merged = { ...state, ...next };
  if (merged.urlRef === state.urlRef && merged.activeRef === state.activeRef) return;
  state = merged;
  // `input` can run while React renders (the router parses locations lazily),
  // and subscribers must not be told mid-render.
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkspaceUrlState(): WorkspaceUrlState {
  return state;
}

export function useWorkspaceUrlState(): WorkspaceUrlState {
  return useSyncExternalStore(subscribe, getWorkspaceUrlState, getWorkspaceUrlState);
}

/** Set the ref links carry. Called by the shell once the tab's workspace is settled. */
export function setActiveWorkspaceRef(ref: string | null): void {
  update({ activeRef: ref });
}

/**
 * Whether URLs carry the workspace. On unless the build sets
 * `VITE_WORKSPACE_IN_URL=false`, the kill switch. With it off the app behaves
 * as before step 2: `/w/{ref}` links still open through the `/w/$workspace`
 * route, and nothing else changes.
 */
export function workspaceUrlsEnabled(): boolean {
  return import.meta.env.VITE_WORKSPACE_IN_URL !== 'false';
}

/**
 * `/weldcrm/x` → `/w/acme/weldcrm/x` for the tab's workspace. For links the
 * router doesn't build: plain `<a href>`, `window.open`. Non-workspace paths,
 * paths that already name a workspace, and anything before the shell has
 * settled the workspace are returned as they are.
 */
export function toPublicPath(path: string, activeRef = state.activeRef): string {
  if (!workspaceUrlsEnabled() || !activeRef || !path.startsWith('/') || path.startsWith('//')) return path;
  const pathname = path.split(/[?#]/, 1)[0];
  if (!isWorkspaceScopedPath(pathname)) return path;
  return workspacePath(activeRef, path);
}

/** `toPublicPath` that re-renders when the tab's workspace is settled. */
export function useWorkspaceHref(): (path: string) => string {
  const { activeRef } = useWorkspaceUrlState();
  return useCallback((path: string) => toPublicPath(path, activeRef), [activeRef]);
}

/** The router rewrite. Exported for `src/main.tsx` and tests. */
export const workspaceUrlRewrite: LocationRewrite = {
  input: ({ url }) => {
    const parsed = parseWorkspacePath(url.pathname);
    if (!parsed) return url;
    update({ urlRef: parsed.ref });
    const internal = new URL(url.href);
    internal.pathname = parsed.rest;
    return internal;
  },
  output: ({ url }) => {
    const { activeRef } = state;
    if (!activeRef || !isWorkspaceScopedPath(url.pathname)) return url;
    // A new URL: the router reads the one it passed in again afterwards.
    const external = new URL(url.href);
    external.pathname = workspacePath(activeRef, url.pathname);
    return external;
  },
};

/** Test-only: reset the module state between cases. */
export function resetWorkspaceUrlStateForTests(): void {
  state = { urlRef: null, activeRef: null };
}
