import { createContext, useContext, useEffect } from 'react';

/**
 * Tells `ObjectPanelHost` which tab the open panel shows, so stepping to the
 * previous / next object opens it on the same tab.
 */
export const ObjectPanelActiveTabContext = createContext<((tabId: string) => void) | null>(null);

export function useReportObjectPanelActiveTab(tabId: string): void {
  const report = useContext(ObjectPanelActiveTabContext);
  useEffect(() => {
    report?.(tabId);
  }, [report, tabId]);
}
