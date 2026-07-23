import { atom, useAtom, useAtomValue } from 'jotai';
import { useCallback } from 'react';
import type { ObjectPanelHandle, ObjectType } from './types';

// Re-export for consumers that import the handle type from this module.
export type { ObjectPanelHandle } from './types';

/**
 * Stack of currently open object panels. Top of stack = visible panel.
 * Earlier entries become `onBack` targets when a panel is pushed on top of
 * another (e.g. opening a contact from inside a customer panel).
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
 * Maximum visible depth of the object-panel cascade.
 *
 * Going beyond two stacked panels squeezes the underlying page into a
 * narrow strip — see the screenshot in the design notes. Drill-downs that
 * try to push a third panel drop the *bottom* (oldest) entry instead, so
 * the cascade slides one slot to the left and the new panel becomes the
 * top. The back chevron in the new top panel still navigates back to the
 * previous level via `close()`, which only pops the top.
 */
const MAX_STACK_DEPTH = 2;

export function useObjectPanel() {
  const [stack, setStack] = useAtom(objectPanelStackAtom);

  const open = useCallback(
    ({ type, id, initialTab, mode = 'panel', stack: pushOnTop }: OpenPanelArgs) => {
      setStack((prev) => {
        const base = pushOnTop ? prev : [];
        const next = [...base, { type, id, initialTab, mode, depth: base.length }];
        // Cap the cascade at MAX_STACK_DEPTH by trimming from the bottom.
        const trimmed = next.length > MAX_STACK_DEPTH
          ? next.slice(next.length - MAX_STACK_DEPTH)
          : next;
        // Reindex `depth` so the bottom entry is always 0, top is `length-1`.
        return trimmed.map((h, i) => ({ ...h, depth: i }));
      });
    },
    [setStack],
  );

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
