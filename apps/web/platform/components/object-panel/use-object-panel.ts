import { atom, useAtom, useAtomValue } from 'jotai';
import { useCallback } from 'react';
import type { ObjectPanelHandle, ObjectType } from './types';

// Re-export for consumers that import the handle type from this module.
export type { ObjectPanelHandle } from './types';

/**
 * History of object panels. Only the top of the stack is ever on screen —
 * there is never more than one panel visible at a time. Earlier entries are
 * the `onBack` targets when a panel is opened from inside another (e.g.
 * opening a contact from inside a customer panel).
 */
const objectPanelStackAtom = atom<ObjectPanelHandle[]>([]);

export interface OpenPanelArgs {
  type: ObjectType;
  id: string;
  initialTab?: string;
  /** Per-panel mode. Defaults to 'panel'. */
  mode?: 'panel' | 'fullscreen';
  /** When true, the new panel is pushed on top of the current stack instead of replacing it. */
  stack?: boolean;
}

/**
 * How many levels of drill-down the back chevron remembers. Opening a panel
 * beyond this drops the oldest entry, so back navigation stays bounded.
 */
const MAX_STACK_DEPTH = 10;

export function useObjectPanel() {
  const [stack, setStack] = useAtom(objectPanelStackAtom);

  const open = useCallback(
    ({ type, id, initialTab, mode = 'panel', stack: pushOnTop }: OpenPanelArgs) => {
      setStack((prev) => {
        // Opening the panel that is already on top is a no-op — a double
        // click must not push the same panel twice.
        const top = prev.at(-1);
        if (pushOnTop && top?.type === type && top.id === id) return prev;
        const base = pushOnTop ? prev : [];
        const next = [...base, { type, id, initialTab, mode, depth: base.length }];
        // Cap the history at MAX_STACK_DEPTH by trimming from the bottom.
        const trimmed = next.length > MAX_STACK_DEPTH
          ? next.slice(next.length - MAX_STACK_DEPTH)
          : next;
        // Reindex `depth` so the bottom entry is always 0, top is `length-1`.
        return trimmed.map((h, i) => ({ ...h, depth: i }));
      });
    },
    [setStack],
  );

  /** Pop the top panel — the back chevron. Reveals the panel it was opened from. */
  const close = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
  }, [setStack]);

  const closeAll = useCallback(() => {
    setStack([]);
  }, [setStack]);

  /** Flip the mode of a single panel by depth (0 = bottom of stack). */
  const setMode = useCallback(
    (depth: number, mode: 'panel' | 'fullscreen') => {
      setStack((prev) =>
        prev.map((h, i) => (i === depth ? { ...h, mode } : h)),
      );
    },
    [setStack],
  );

  /** Replace the entire stack atomically. Used by the URL sync. */
  const replaceStack = useCallback(
    (next: ObjectPanelHandle[]) => {
      setStack(next.map((h, i) => ({ ...h, depth: i })));
    },
    [setStack],
  );

  return { stack, open, close, closeAll, setMode, replaceStack };
}

/** Read-only access to the stack (for consumers that don't need to mutate). */
export function useObjectPanelStack(): ObjectPanelHandle[] {
  return useAtomValue(objectPanelStackAtom);
}
