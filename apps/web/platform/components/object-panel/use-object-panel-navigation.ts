/**
 * Previous / next between objects, from inside the panel.
 *
 * A surface that lists objects (a grid, a list, a board) registers what it
 * shows, in the order it shows it, with `useObjectPanelNavigationSource`.
 * When the panel on top of the stack shows one of those objects,
 * `ObjectPanelHost` hands the panel `onPrevious` / `onNext` (the header
 * arrows, J / K), which swap the top of the stack for the neighbouring object
 * and keep its mode and tab.
 *
 * A list that loads more on scroll also passes `hasMore` + `loadMore`: stepping
 * past the last loaded row fetches the next page, and the panel moves on once
 * it lands.
 *
 * `open()` records which list the object was in (`ObjectPanelHandle.openedFrom`),
 * so the arrows follow the list that was clicked, even once it is gone: a
 * related list in a panel unmounts when the object it opens stacks on top.
 */

import { atom, useAtomValue, useSetAtom, type useStore } from 'jotai';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  ObjectPanelHandle,
  ObjectPanelListSnapshot,
  ObjectPanelNavigation,
  ObjectPanelRef,
  ObjectType,
} from './types';

export type { ObjectPanelRef } from './types';

interface NavigationList {
  objects: readonly ObjectPanelRef[];
  /** `refKey` of each entry of `objects`, for lookups. */
  keys: readonly string[];
  hasMore: boolean;
  loadMore?: () => void;
}

interface NavigationSource extends NavigationList {
  sourceKey: string;
}

const navigationSourcesAtom = atom<readonly NavigationSource[]>([]);

// Neither separator can appear in an object type or id.
const TYPE_SEPARATOR = '\u0001';
const ENTRY_SEPARATOR = '\u0000';

function refKey(type: ObjectType, id: string): string {
  return `${type}${TYPE_SEPARATOR}${id}`;
}

function parseRefKey(key: string): ObjectPanelRef {
  const at = key.indexOf(TYPE_SEPARATOR);
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

interface NavigationSourceCommonOptions {
  /** More rows exist beyond the loaded ones (infinite scroll / cursor pagination). */
  hasMore?: boolean;
  /** Fetches the next page. Called when stepping past the last loaded row. */
  loadMore?: () => unknown;
  /** Set to false while the list isn't the one on screen. */
  enabled?: boolean;
}

export type ObjectPanelNavigationSourceOptions = NavigationSourceCommonOptions &
  (
    | {
        /** Object type of every id in the list. */
        type: ObjectType;
        /** Ids in display order: after sorting, filtering and grouping. */
        ids: readonly string[];
        objects?: never;
      }
    | {
        /** For a list that mixes types (companies and people). Display order. */
        objects: readonly ObjectPanelRef[];
        type?: never;
        ids?: never;
      }
  );

function withoutSource(sources: readonly NavigationSource[], sourceKey: string): readonly NavigationSource[] {
  return sources.some((s) => s.sourceKey === sourceKey)
    ? sources.filter((s) => s.sourceKey !== sourceKey)
    : sources;
}

/**
 * Registers a list as the previous / next order for panels opened from it.
 * Call it in the component that renders the rows, with the rows as shown.
 */
export function useObjectPanelNavigationSource(options: ObjectPanelNavigationSourceOptions): void {
  const { hasMore = false, loadMore, enabled = true } = options;
  const sourceKey = useId();
  const setSources = useSetAtom(navigationSourcesAtom);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });
  const canLoadMore = hasMore && loadMore !== undefined;

  // Callers usually derive the list inline (`rows.map((r) => r.id)`), so the
  // registration follows the content, not the array identity.
  const listKey =
    options.objects === undefined
      ? options.ids.map((id) => refKey(options.type, id)).join(ENTRY_SEPARATOR)
      : options.objects.map((o) => refKey(o.type, o.id)).join(ENTRY_SEPARATOR);

  useEffect(() => {
    if (!enabled || listKey === '') {
      setSources((prev) => withoutSource(prev, sourceKey));
      return;
    }
    const keys = listKey.split(ENTRY_SEPARATOR);
    const entry: NavigationSource = {
      sourceKey,
      keys,
      objects: keys.map(parseRefKey),
      hasMore: canLoadMore,
      loadMore: canLoadMore ? () => void loadMoreRef.current?.() : undefined,
    };
    setSources((prev) => {
      const index = prev.findIndex((s) => s.sourceKey === sourceKey);
      if (index === -1) return [...prev, entry];
      const next = prev.slice();
      next[index] = entry;
      return next;
    });
  }, [sourceKey, listKey, canLoadMore, enabled, setSources]);

  useEffect(() => () => setSources((prev) => withoutSource(prev, sourceKey)), [sourceKey, setSources]);
}

/** What a list's rows open, for list components that take it as a prop. */
export interface ObjectPanelListNavigation<T> {
  /** One type for every row, or per row for a mixed list. */
  type: ObjectType | ((item: T) => ObjectType);
  /** The id the row opens. Defaults to `item.id`; rows without one are skipped. */
  getId?: (item: T) => string | null | undefined;
}

/**
 * For list components that report their rows through a callback (EntityList's
 * `onDisplayedItemsChange`, the grid's filtered rows): returns that callback
 * and registers whatever it last received.
 */
export function useObjectPanelNavigationReporter<T>({
  type,
  getId,
  hasMore,
  loadMore,
  enabled = true,
}: ObjectPanelListNavigation<T> & NavigationSourceCommonOptions): (items: readonly T[]) => void {
  const [objects, setObjects] = useState<readonly ObjectPanelRef[]>([]);
  const optionsRef = useRef({ type, getId });
  useEffect(() => {
    optionsRef.current = { type, getId };
  });

  const report = useCallback((items: readonly T[]) => {
    const { type: typeOf, getId: idOf } = optionsRef.current;
    const next: ObjectPanelRef[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const id = idOf ? idOf(item) : (item as { id?: string }).id;
      if (!id) continue;
      const ref = { type: typeof typeOf === 'function' ? typeOf(item) : typeOf, id };
      // A row shown in two groups is still one stop.
      const key = refKey(ref.type, ref.id);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(ref);
    }
    // Skip identical reports: the list re-reports on every change of its rows'
    // identity, and a new state here re-renders the list's owner.
    setObjects((prev) =>
      prev.length === next.length && prev.every((o, i) => o.type === next[i].type && o.id === next[i].id)
        ? prev
        : next,
    );
  }, []);

  useObjectPanelNavigationSource({ objects, hasMore, loadMore, enabled });
  return report;
}

/** Newest registration first: a list inside the open panel beats the page. */
function findSource(sources: readonly NavigationSource[], key: string): NavigationSource | undefined {
  for (let i = sources.length - 1; i >= 0; i--) {
    if (sources[i].keys.includes(key)) return sources[i];
  }
  return undefined;
}

/** The list `target` is shown in right now, for `ObjectPanelHandle.openedFrom`. */
export function snapshotNavigationList(
  store: ReturnType<typeof useStore>,
  target: ObjectPanelRef,
): ObjectPanelListSnapshot | undefined {
  const source = findSource(store.get(navigationSourcesAtom), refKey(target.type, target.id));
  return source && { sourceKey: source.sourceKey, objects: source.objects };
}

function resolveList(
  sources: readonly NavigationSource[],
  handle: ObjectPanelHandle | undefined,
): NavigationList | undefined {
  if (!handle) return undefined;
  const key = refKey(handle.type, handle.id);
  const openedFrom = handle.openedFrom;
  if (openedFrom) {
    // The list the panel was opened from: live while it's mounted (it keeps
    // loading pages), else as it was when the panel opened.
    const source = sources.find((s) => s.sourceKey === openedFrom.sourceKey);
    if (source?.keys.includes(key)) return source;
    const keys = openedFrom.objects.map((o) => refKey(o.type, o.id));
    if (keys.includes(key)) return { objects: openedFrom.objects, keys, hasMore: false };
  }
  // Opened from a link, or stepped past the captured list: whatever is on screen.
  return findSource(sources, key);
}

/**
 * The previous / next handlers for the panel on top of the stack, or
 * `undefined` when it wasn't opened from a known list. `go` shows another
 * object in that panel.
 */
export function useObjectPanelNavigationControls(
  handle: ObjectPanelHandle | undefined,
  go: (target: ObjectPanelRef) => void,
): ObjectPanelNavigation | undefined {
  const sources = useAtomValue(navigationSourcesAtom);
  const live = useMemo(() => resolveList(sources, handle), [sources, handle]);
  const currentKey = handle ? refKey(handle.type, handle.id) : null;

  // Remember the list the current object was last seen in. Editing it can drop
  // it from a filtered list (a ticket closed out of "Open"); the arrows then
  // keep stepping from where it was instead of disappearing.
  const [lastSeen, setLastSeen] = useState<{ key: string; list: NavigationList } | null>(null);
  if (currentKey !== null && live && (lastSeen?.key !== currentKey || lastSeen.list.keys !== live.keys)) {
    setLastSeen({ key: currentKey, list: live });
  }
  const list = useMemo<NavigationList | undefined>(() => {
    if (live) return live;
    if (currentKey !== null && lastSeen?.key === currentKey) {
      return { objects: lastSeen.list.objects, keys: lastSeen.list.keys, hasMore: false };
    }
    return undefined;
  }, [live, currentKey, lastSeen]);

  const index = list && currentKey !== null ? list.keys.indexOf(currentKey) : -1;

  // "Next" on the last loaded row asked for another page: move on once it lands.
  const pendingFromRef = useRef<string | null>(null);
  useEffect(() => {
    const pendingFrom = pendingFromRef.current;
    if (pendingFrom === null) return;
    if (!list || currentKey !== pendingFrom) {
      pendingFromRef.current = null;
      return;
    }
    if (index !== -1 && index < list.objects.length - 1) {
      pendingFromRef.current = null;
      go(list.objects[index + 1]);
    } else if (!list.hasMore) {
      pendingFromRef.current = null;
    }
  }, [currentKey, list, index, go]);

  return useMemo(() => {
    if (!list || currentKey === null || index === -1) return undefined;
    // A list of one has nothing to step to: no arrows.
    if (list.objects.length === 1 && !list.hasMore) return undefined;
    const previous = index > 0 ? list.objects[index - 1] : undefined;
    const next = index < list.objects.length - 1 ? list.objects[index + 1] : undefined;
    const { loadMore } = list;
    let onNext: (() => void) | undefined;
    if (next) {
      onNext = () => go(next);
    } else if (list.hasMore && loadMore) {
      onNext = () => {
        pendingFromRef.current = currentKey;
        loadMore();
      };
    }
    return {
      onPrevious: previous ? () => go(previous) : undefined,
      onNext,
    };
  }, [list, currentKey, index, go]);
}

/** Popups that own the keyboard while focus is inside them. */
const KEYBOARD_OWNER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[data-radix-popper-content-wrapper]',
  '[cmdk-root]',
].join(',');

function isTypingOrInPopup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(KEYBOARD_OWNER_SELECTOR) !== null;
}

export const PREVIOUS_OBJECT_SHORTCUT = 'K';
export const NEXT_OBJECT_SHORTCUT = 'J';

/** J = next, K = previous, unless focus is in a field or an open popup. */
export function useObjectPanelNavigationShortcuts(navigation: ObjectPanelNavigation | undefined): void {
  const navigationRef = useRef(navigation);
  useEffect(() => {
    navigationRef.current = navigation;
  });
  const enabled = navigation !== undefined;

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toUpperCase();
      if (key !== NEXT_OBJECT_SHORTCUT && key !== PREVIOUS_OBJECT_SHORTCUT) return;
      if (isTypingOrInPopup(e.target)) return;
      const action =
        key === NEXT_OBJECT_SHORTCUT ? navigationRef.current?.onNext : navigationRef.current?.onPrevious;
      if (!action) return;
      e.preventDefault();
      action();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled]);
}
