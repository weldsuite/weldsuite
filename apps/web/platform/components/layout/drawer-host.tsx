import { GlobalCalendarDrawer } from '@/components/global-calendar-drawer';
import { GlobalNotificationsPanel } from '@/components/global-notifications-panel';
import { GlobalAgentShortcut } from '@/components/global-agent-shortcut';
import { useCalendarDrawerOpen } from '@/hooks/use-calendar-drawer-open';
import { useNotificationsPanelOpen } from '@/hooks/use-notifications-panel-open';

/**
 * Renders the top-nav drawers (calendar / notifications / agent) as in-flow
 * flex siblings inside `ModuleContent`'s content row — each is a rounded card
 * that appears to the right of the object panel when open. Open state is the
 * shared, session-backed drawer state that the header buttons toggle, so this
 * just reflects it; no reservation or positioning needed (the row's `gap`
 * handles spacing).
 *
 * `GlobalAgentShortcut` owns the WeldAgent panel + its keyboard shortcut and is
 * mounted here so the agent lands in the same row.
 */
export function DrawerHost() {
  const [showCalendar, setShowCalendar] = useCalendarDrawerOpen();
  const [showNotifications, setShowNotifications] = useNotificationsPanelOpen();

  return (
    <>
      <GlobalCalendarDrawer
        isOpen={showCalendar}
        onClose={() => setShowCalendar(false)}
      />
      <GlobalNotificationsPanel
        isOpen={showNotifications}
        onClose={() => setShowNotifications(false)}
      />
      <GlobalAgentShortcut />
    </>
  );
}
