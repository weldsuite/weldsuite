import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The active tab of a record panel, starting on the one a deep link asked for
 * (`?stack=…:tab=<id>`). Some tabs only exist once the record is loaded (a
 * bill's Tax tab, a payment run's Holds): the asked-for tab is applied as soon
 * as it appears, unless the member has picked a tab in the meantime.
 */
export function usePanelInitialTab<T extends string>(
  tabs: ReadonlyArray<{ id: T }>,
  initialTab: string | undefined,
  fallback: T,
): [T, (id: T) => void] {
  const [activeTab, setActiveTab] = useState<T>(() => tabs.find((tab) => tab.id === initialTab)?.id ?? fallback);
  // Settled once the asked-for tab was shown, or the member chose one.
  const settled = useRef(!initialTab || tabs.some((tab) => tab.id === initialTab));

  useEffect(() => {
    if (settled.current) return;
    const match = tabs.find((tab) => tab.id === initialTab);
    if (!match) return;
    settled.current = true;
    setActiveTab(match.id);
  }, [tabs, initialTab]);

  const choose = useCallback((id: T) => {
    settled.current = true;
    setActiveTab(id);
  }, []);

  return [activeTab, choose];
}
