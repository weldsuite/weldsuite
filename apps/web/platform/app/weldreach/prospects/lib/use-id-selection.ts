/** Which rows of a table are ticked, and the "select all shown" state for the rows on screen. */

import { useCallback, useMemo, useState } from 'react';

export function useIdSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const allSelected = useMemo(
    () => visibleIds.length > 0 && visibleIds.every((id) => selected.has(id)),
    [visibleIds, selected],
  );
  const someSelected = useMemo(
    () => !allSelected && visibleIds.some((id) => selected.has(id)),
    [allSelected, visibleIds, selected],
  );

  /** Ticks every shown row, or unticks them all when they are all ticked already. */
  const toggleAll = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [visibleIds, allSelected]);

  return { selected, toggle, toggleAll, remove, clear, allSelected, someSelected };
}
