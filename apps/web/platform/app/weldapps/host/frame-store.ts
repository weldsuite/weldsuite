import { useSyncExternalStore } from 'react';

/**
 * Keep-alive registry for WeldApp iframes.
 *
 * An iframe reloads whenever it is moved in the DOM, so app frames cannot
 * live inside the route component. They live in `<WeldAppFrameLayer>`
 * (mounted once in the shell) and are positioned over the slot the current
 * `/apps/{code}` page reserves. Leaving and returning to an app is then
 * instant and keeps its state; hovering an app in the rail preloads it.
 *
 * A module-level store rather than a context so the rail (outside the page
 * tree) can preload without extra providers.
 */

/** Frames kept alive at once (least recently used is evicted first). */
export const MAX_LIVE_FRAMES = 3;

export interface FrameSlot {
  appCode: string;
  element: HTMLElement;
  /** App-relative path of the current platform URL. */
  path: string;
}

export interface FrameStatus {
  /** The app reported its first render (or the legacy fallback elapsed). */
  mounted: boolean;
  /** Crumbs the app set via `setBreadcrumbs`; null = derive from the URL. */
  breadcrumbs: { label: string; href?: string }[] | null;
  /** Non-null while the app reports unsaved changes. */
  dirty: { message?: string } | null;
}

interface FrameStoreState {
  /** Live frames, most recently used last. */
  frames: string[];
  slot: FrameSlot | null;
  status: Record<string, FrameStatus>;
}

const EMPTY_STATUS: FrameStatus = { mounted: false, breadcrumbs: null, dirty: null };

let state: FrameStoreState = { frames: [], slot: null, status: {} };
const listeners = new Set<() => void>();

function setState(next: FrameStoreState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Move `appCode` to most-recent and evict beyond the cap (never the shown app). */
function touch(frames: string[], appCode: string, keep: string | null): string[] {
  const next = [...frames.filter((code) => code !== appCode), appCode];
  while (next.length > MAX_LIVE_FRAMES) {
    const victim = next.find((code) => code !== keep && code !== appCode);
    if (!victim) break;
    next.splice(next.indexOf(victim), 1);
  }
  return next;
}

function pruneStatus(status: Record<string, FrameStatus>, frames: string[]): Record<string, FrameStatus> {
  const next: Record<string, FrameStatus> = {};
  for (const code of frames) {
    if (status[code]) next[code] = status[code];
  }
  return next;
}

/** Start loading an app in the background (e.g. on rail hover). */
export function preloadWeldApp(appCode: string): void {
  if (state.frames.includes(appCode)) return;
  const frames = touch(state.frames, appCode, state.slot?.appCode ?? null);
  setState({ ...state, frames, status: pruneStatus(state.status, frames) });
}

/** The page reserved `slot.element` for `slot.appCode`; show that frame there. */
export function attachFrameSlot(slot: FrameSlot): void {
  const current = state.slot;
  if (current && current.appCode === slot.appCode && current.element === slot.element && current.path === slot.path) {
    return;
  }
  const frames = touch(state.frames, slot.appCode, slot.appCode);
  setState({ ...state, frames, slot, status: pruneStatus(state.status, frames) });
}

/** The page unmounted; hide (but keep) its frame. */
export function detachFrameSlot(element: HTMLElement): void {
  if (state.slot?.element !== element) return;
  setState({ ...state, slot: null });
}

export function updateFrameStatus(appCode: string, patch: Partial<FrameStatus>): void {
  if (!state.frames.includes(appCode)) return;
  const previous = state.status[appCode] ?? EMPTY_STATUS;
  setState({ ...state, status: { ...state.status, [appCode]: { ...previous, ...patch } } });
}

/** Drop a frame so the next visit boots it fresh (e.g. its bundle changed). */
export function resetFrameStatus(appCode: string): void {
  if (!state.status[appCode]) return;
  const status = { ...state.status };
  delete status[appCode];
  setState({ ...state, status });
}

/** Tear down every frame (workspace switch / sign-out). */
export function clearWeldAppFrames(): void {
  if (state.frames.length === 0 && !state.slot) return;
  setState({ frames: [], slot: null, status: {} });
}

export function useWeldAppFrames(): string[] {
  return useSyncExternalStore(subscribe, () => state.frames, () => state.frames);
}

export function useWeldAppFrameSlot(): FrameSlot | null {
  return useSyncExternalStore(subscribe, () => state.slot, () => state.slot);
}

export function useWeldAppFrameStatus(appCode: string | undefined): FrameStatus {
  return useSyncExternalStore(
    subscribe,
    () => (appCode ? state.status[appCode] ?? EMPTY_STATUS : EMPTY_STATUS),
    () => EMPTY_STATUS,
  );
}

/** Test helper: reset module state. */
export function __resetFrameStoreForTests(): void {
  state = { frames: [], slot: null, status: {} };
  listeners.clear();
}
