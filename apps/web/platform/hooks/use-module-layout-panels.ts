import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { useCalendarDrawerOpen } from '@/hooks/use-calendar-drawer-open';
import { useNotificationsPanelOpen } from '@/hooks/use-notifications-panel-open';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';

const CALENDAR_PANEL_WIDTH = 480;
const NOTIFICATIONS_PANEL_WIDTH = 480;
const DEFAULT_WELDAGENT_WIDTH = 480;

interface UseModuleLayoutPanelsOptions {
  /**
   * CustomEvent names whose `{ isOpen, width }` detail reserves horizontal
   * space next to the module content (e.g. 'task-detail-panel',
   * 'file-detail-panel', 'member-detail-panel', 'object-panel-reservation').
   */
  panelEvents?: string[];
  /**
   * Apply panel-width updates inside flushSync so the reserved width is
   * committed in the same frame as the event. Leave off unless the layout
   * visibly lags a panel opening — panels that dispatch their event from a
   * mount effect trigger React 19 "flushSync inside lifecycle" warnings.
   */
  sync?: boolean;
}

/**
 * Shared wiring for module layout shells: WeldAgent / calendar / notifications
 * drawer state (WeldAgent routed through MobileNavContext when present, so the
 * global shortcut stays in sync) plus width reservation for detail panels that
 * announce themselves via window CustomEvents.
 */
export function useModuleLayoutPanels({
  panelEvents = ['task-detail-panel'],
  sync = false,
}: UseModuleLayoutPanelsOptions = {}) {
  const mobileNav = useMobileNavOptional();

  // Use MobileNavContext for WeldAgent state (shared with global shortcut)
  const [showWeldAgent, setShowWeldAgentDirect] = useWeldAgentDrawerOpen();
  const setShowWeldAgent = mobileNav?.setShowWeldAgent ?? setShowWeldAgentDirect;

  const [showCalendar, setShowCalendar] = useCalendarDrawerOpen();
  const [showNotifications, setShowNotifications] = useNotificationsPanelOpen();
  const [panelWidths, setPanelWidths] = useState<Record<string, number>>({});

  const weldAgentWidth = mobileNav?.weldAgentWidth ?? DEFAULT_WELDAGENT_WIDTH;

  const eventsKey = panelEvents.join(',');
  useEffect(() => {
    const events = eventsKey.split(',').filter(Boolean);
    const cleanups = events.map((name) => {
      const handler = (e: Event) => {
        const { isOpen, width } = (e as CustomEvent).detail;
        const update = () =>
          setPanelWidths((prev) => {
            const next = isOpen ? width : 0;
            return prev[name] === next ? prev : { ...prev, [name]: next };
          });
        if (sync) flushSync(update);
        else update();
      };
      window.addEventListener(name, handler);
      return () => window.removeEventListener(name, handler);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [eventsKey, sync]);

  let reservedWidth = 0;
  if (showWeldAgent) reservedWidth += weldAgentWidth;
  if (showCalendar) reservedWidth += CALENDAR_PANEL_WIDTH;
  if (showNotifications) reservedWidth += NOTIFICATIONS_PANEL_WIDTH;
  for (const width of Object.values(panelWidths)) reservedWidth += width;

  // Fold in the object-panel host's reservation (written to a CSS var on
  // <html>) alongside the drawer/detail-panel widths, so the module content
  // shrinks to the left of the object-panel slot. `0px` fallback keeps the
  // math sound when no panel is open.
  const contentWidth = `calc(100% - ${reservedWidth}px - var(--object-panel-reservation-width, 0px))`;

  return {
    showWeldAgent,
    setShowWeldAgent,
    showCalendar,
    setShowCalendar,
    showNotifications,
    setShowNotifications,
    weldAgentWidth,
    contentWidth,
  };
}
