/**
 * Slim app-level header.
 *
 * Layout matches the existing breadcrumb-header.tsx visual:
 *  - Left: SidebarTrigger + breadcrumb trail
 *  - Center: search input (absolutely positioned 1/2 -translate-x-1/2) with
 *    dropdown popover directly underneath the input
 *  - Right: drawer toggle buttons (calendar / notifications / WeldAgent)
 *  - Renders the calendar + notifications drawers
 *
 * Cmd+K focuses the search input.
 */

import { useEffect, useRef, useState } from 'react';
import { Bell, Calendar } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { SidebarTrigger } from '@weldsuite/ui/components/sidebar';
import { Button } from '@weldsuite/ui/components/button';
import { useCalendarDrawerOpen } from '@/hooks/use-calendar-drawer-open';
import { useNotificationsPanelOpen } from '@/hooks/use-notifications-panel-open';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';
import { useUnifiedNotifications } from '@/contexts/unified-notification-context';
import { useUpcomingCalendarEvents } from '@/hooks/queries/use-calendar-queries';
import { cn } from '@/lib/utils';
import { AppHeaderTrail } from './app-header-trail';
import { CommandPalette, type CommandPaletteHandle } from './command-palette';

export interface AppHeaderProps {
  onCalendarToggle?: (open: boolean) => void;
  onNotificationsToggle?: (open: boolean) => void;
  onWeldAgentToggle?: (open: boolean) => void;
  /** Render the calendar/notification drawers from inside the header. Default true. */
  renderDrawers?: boolean;
}

export function AppHeader({
  onCalendarToggle,
  onNotificationsToggle,
  onWeldAgentToggle,
}: AppHeaderProps) {
  const t = useTranslations();
  const [hideAll, setHideAll] = useState(false);
  const paletteRef = useRef<CommandPaletteHandle>(null);

  // Cmd+K focuses the inline search input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        paletteRef.current?.toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const [showCalendar, setShowCalendar] = useCalendarDrawerOpen();
  const [showNotifications, setShowNotifications] = useNotificationsPanelOpen();
  const [showWeldAgent, setShowWeldAgent] = useWeldAgentDrawerOpen();

  const { unreadCount } = useUnifiedNotifications();
  const { data: todayEventsData } = useUpcomingCalendarEvents({ days: 1 });
  const todayEventCount =
    todayEventsData?.data?.filter((e: { status?: string }) => e.status !== 'cancelled').length ?? 0;

  const toggleCalendar = () => {
    const next = !showCalendar;
    if (next) {
      if (showWeldAgent) {
        setShowWeldAgent(false);
        onWeldAgentToggle?.(false);
      }
      if (showNotifications) {
        setShowNotifications(false);
        onNotificationsToggle?.(false);
      }
    }
    setShowCalendar(next);
    onCalendarToggle?.(next);
  };

  const toggleNotifications = () => {
    const next = !showNotifications;
    if (next) {
      if (showWeldAgent) {
        setShowWeldAgent(false);
        onWeldAgentToggle?.(false);
      }
      if (showCalendar) {
        setShowCalendar(false);
        onCalendarToggle?.(false);
      }
    }
    setShowNotifications(next);
    onNotificationsToggle?.(next);
  };

  const toggleWeldAgent = () => {
    const next = !showWeldAgent;
    if (next) {
      if (showCalendar) {
        setShowCalendar(false);
        onCalendarToggle?.(false);
      }
      if (showNotifications) {
        setShowNotifications(false);
        onNotificationsToggle?.(false);
      }
    }
    setShowWeldAgent(next);
    onWeldAgentToggle?.(next);
  };

  if (hideAll) return null;

  return (
    <>
      <header
        data-slot="app-header"
        className="sticky top-0 z-40 hidden md:flex h-[60px] shrink-0 items-center bg-[var(--shell-panel)] relative"
      >
        <div className="flex items-center gap-2 px-4 w-full relative z-10">
          <SidebarTrigger className="-ml-1 hidden md:flex" />
          <div className="ml-px mr-[8px] h-[19px] w-px bg-gray-200/70 dark:bg-secondary/70 hidden md:block shrink-0" />

          {/* Breadcrumb trail — capped width so it doesn't run into the centered search */}
          <div className="hidden md:flex overflow-hidden max-w-[calc(50%-280px)]">
            <AppHeaderTrail onResolved={(handle) => setHideAll(handle.hideAll)} />
          </div>

          {/* Centered Search — absolutely positioned, with popover dropdown */}
          <div className="absolute left-1/2 -translate-x-1/2 hidden md:block w-[448px]">
            <CommandPalette ref={paletteRef} />
          </div>

          {/* Right Actions */}
          <div className="ml-auto hidden md:flex items-center gap-2">
            <Button
              onClick={toggleCalendar}
              variant="outline"
              size="sm"
              className={cn(
                'shadow-none relative',
                showCalendar &&
                  'bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground',
              )}
              aria-label={t('sweep.shared.calendar')}
              aria-pressed={showCalendar}
            >
              <Calendar className="h-4 w-4" />
              {todayEventCount > 0 && !showCalendar && (
                <span className="absolute -top-[3px] -right-[3px] z-10 h-[9px] w-[9px] rounded-full bg-red-500 border border-red-600 ring-2 ring-background pointer-events-none" />
              )}
            </Button>

            <Button
              onClick={toggleNotifications}
              variant="outline"
              size="sm"
              className={cn(
                'shadow-none relative',
                showNotifications &&
                  'bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground',
              )}
              aria-label={t('sweep.shared.notifications')}
              aria-pressed={showNotifications}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && !showNotifications && (
                <span className="absolute -top-[3px] -right-[3px] z-10 h-[9px] w-[9px] rounded-full bg-red-500 border border-red-600 ring-2 ring-background pointer-events-none" />
              )}
            </Button>

            <Button
              onClick={toggleWeldAgent}
              variant="outline"
              size="sm"
              className={cn(
                'gap-1.5 shadow-none',
                showWeldAgent &&
                  'bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground',
              )}
              aria-label="WeldAgent"
              aria-pressed={showWeldAgent}
            >
              <img
                src="/assets/images/weldagent/logo-light.png"
                alt="WeldAgent"
                width={32}
                height={32}
                className="h-4 w-4"
              />
              <span className="hidden md:inline">Agent</span>
            </Button>
          </div>
        </div>
      </header>
    </>
  );
}
