
import { useEffect, Fragment } from 'react';
import { Link } from '@/lib/router';
import { SidebarTrigger } from '@weldsuite/ui/components/sidebar';
import { Button } from '@weldsuite/ui/components/button';
import { Bell, Calendar } from 'lucide-react';
import { useUpcomingCalendarEvents, type CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import { useUnifiedNotifications } from '@/contexts/unified-notification-context';
import { useCalendarDrawerOpen } from '@/hooks/use-calendar-drawer-open';
import { useNotificationsPanelOpen } from '@/hooks/use-notifications-panel-open';
import { useSidebarBadges } from '@/hooks/use-sidebar-badges';
import { cn } from '@/lib/utils';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';
import { useMeetingPanelOpen } from '@/hooks/use-meeting-panel-open';
import { CommandPaletteTrigger } from '@/components/layout/command-palette';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@weldsuite/ui/components/breadcrumb';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

interface CrumbEntry {
  segment: BreadcrumbSegment;
  key: string;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Pair each crumb with a content-based React key. A trail can legitimately
 * repeat the same label/href, so an occurrence counter disambiguates repeats.
 */
function buildCrumbEntries(segments: BreadcrumbSegment[]): CrumbEntry[] {
  const seen = new Map<string, number>();
  return segments.map((segment, position) => {
    const base = `${segment.href ?? ''}|${segment.label}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      segment,
      key: `${base}#${occurrence}`,
      isFirst: position === 0,
      isLast: position === segments.length - 1,
    };
  });
}

interface BreadcrumbHeaderProps {
  segments: BreadcrumbSegment[];
  /** Hide the centered command-palette button (rare — most modules want it). */
  hideSearch?: boolean;
  showBackButton?: boolean;
  onBack?: () => void;
  actions?: React.ReactNode;
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
  weldAgentWidth?: number;
  calendarWidth?: number;
  notificationsWidth?: number;
  initialShowWeldAgent?: boolean;
  disableWeldAgentAnimation?: boolean;
  moduleKey?: string; // Module identifier for WeldAgent context (e.g., 'commerce', 'crm', 'helpdesk')
  calendarOpen?: boolean; // External control for calendar panel visibility
}

export function BreadcrumbHeader({
  segments,
  hideSearch = false,
  actions,
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
  calendarOpen,
}: Readonly<BreadcrumbHeaderProps>) {
  // WeldAgent open state — read from sessionStorage-backed hook so every BreadcrumbHeader instance
  // is in sync with the global MobileNavProvider, even after navigation between apps.
  const mobileNav = useMobileNavOptional();
  const [showWeldAgent, setShowWeldAgentDirect] = useWeldAgentDrawerOpen();
  const [meetingPanelOpen] = useMeetingPanelOpen();
  // Prefer mobileNav's setShowWeldAgent (it dispatches close-detail-panels). Fall back to direct hook setter.
  const setShowWeldAgent = mobileNav?.setShowWeldAgent ?? setShowWeldAgentDirect;

  // Calendar + notifications drawer state — shared, broadcast-backed hooks so the
  // header buttons and the in-flow `DrawerHost` (which actually renders the
  // drawers) stay in sync. Persisted to sessionStorage so a drawer survives
  // navigation between apps.
  const [showCalendar, setShowCalendar] = useCalendarDrawerOpen();
  const [showNotifications, setShowNotifications] = useNotificationsPanelOpen();
  const { unreadCount: notificationUnreadCount } = useUnifiedNotifications();
  useSidebarBadges();
  const { data: todayEventsData } = useUpcomingCalendarEvents({ days: 1 });
  const todayEventCount = todayEventsData?.data?.filter((e: CalendarEvent) => e.status !== 'cancelled').length ?? 0;

  const toggleWeldAgent = () => {
    const newState = !showWeldAgent;
    // Close Tasks drawer and Notifications when opening WeldAgent
    if (newState) {
      // If switching from tasks, notifications, or an in-meeting panel, skip animation
      const switchingFromPanel = showCalendar || showNotifications || meetingPanelOpen;
      mobileNav?.setWeldAgentSkipAnimation(switchingFromPanel);
      if (showCalendar) {
        setShowCalendar(false);
        onCalendarToggle?.(false);
      }
      if (showNotifications) {
        setShowNotifications(false);
        onNotificationsToggle?.(false);
      }
    } else {
      mobileNav?.setWeldAgentSkipAnimation(false);
    }
    setShowWeldAgent(newState);
    if (onWeldAgentToggle) {
      onWeldAgentToggle(newState);
    }
  };

  const toggleCalendar = () => {
    const newState = !showCalendar;
    // Opening the calendar closes WeldAgent, notifications, and any detail panel
    // so the row only ever shows one drawer at a time.
    if (newState) {
      if (showWeldAgent) {
        setShowWeldAgent(false);
        onWeldAgentToggle?.(false);
      }
      if (showNotifications) {
        setShowNotifications(false);
        onNotificationsToggle?.(false);
      }
      window.dispatchEvent(new CustomEvent('close-detail-panels'));
    }
    setShowCalendar(newState);
    onCalendarToggle?.(newState);
  };

  const toggleNotifications = () => {
    const newState = !showNotifications;
    // Opening notifications closes WeldAgent, the calendar, and any detail panel.
    if (newState) {
      if (showWeldAgent) {
        setShowWeldAgent(false);
        onWeldAgentToggle?.(false);
      }
      if (showCalendar) {
        setShowCalendar(false);
        onCalendarToggle?.(false);
      }
      window.dispatchEvent(new CustomEvent('close-detail-panels'));
    }
    setShowNotifications(newState);
    onNotificationsToggle?.(newState);
  };

  // Close Tasks and Notifications when a detail panel opens (detail panels dispatch 'close-weldagent')
  useEffect(() => {
    const handler = () => {
      if (showCalendar) {
        setShowCalendar(false);
        onCalendarToggle?.(false);
      }
      if (showNotifications) {
        setShowNotifications(false);
        onNotificationsToggle?.(false);
      }
    };
    window.addEventListener('close-weldagent', handler);
    return () => window.removeEventListener('close-weldagent', handler);
  }, [showCalendar, showNotifications, onCalendarToggle, onNotificationsToggle, setShowCalendar, setShowNotifications]);

  // initialShowWeldAgent is now driven by the parent layout via setShowWeldAgent (which routes through the
  // shared hook). No manual sync needed — every consumer of useWeldAgentDrawerOpen receives the same value.

  // Sync showCalendar state with external calendarOpen prop. Intentionally
  // one-way (external prop → internal state): `showCalendar` is deliberately
  // excluded so a user-driven toggle isn't immediately bounced back by a
  // stale `calendarOpen` prop value.
  useEffect(() => {
    if (calendarOpen !== undefined && showCalendar !== calendarOpen) {
      setShowCalendar(calendarOpen);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarOpen, setShowCalendar]);

  return (
    <header className="hidden md:flex h-[60px] shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 bg-[var(--shell-panel)] border-b border-border relative">
        <div className="flex items-center gap-2 px-4 w-full relative z-10">
          <SidebarTrigger className="-ml-1 hidden md:flex" />
          <div className="ml-px mr-[8px] h-[19px] w-px bg-gray-200/70 dark:bg-secondary/70 hidden md:block shrink-0" />
          {/* Breadcrumb trail - max-width prevents overlap with centered search bar (448px wide) */}
          {segments.length > 0 && (
            <Breadcrumb className={cn("hidden md:flex overflow-hidden", !hideSearch ? "max-w-[calc(50%-280px)]" : "max-w-[40%]")}>
              <BreadcrumbList className="flex-nowrap overflow-hidden">
                {buildCrumbEntries(segments).map(({ segment, key: crumbKey, isFirst, isLast }) => {

                  return (
                    // Key by href + label + occurrence counter: a crumb trail can
                    // legitimately repeat an href (e.g. home renders "WeldSuite"
                    // and "Home" both linking to "/"), and keying by href alone
                    // then collides → React "two children with the same key" warning.
                    <Fragment key={crumbKey}>
                      {!isFirst && <BreadcrumbSeparator className="shrink-0" />}
                      <BreadcrumbItem className={cn("min-w-0", isLast ? "truncate" : "shrink-0")}>
                        {isLast || !segment.href ? (
                          <BreadcrumbPage className="truncate max-w-[500px]">
                            {segment.label}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild className="truncate max-w-[500px]">
                            <Link href={segment.href}>{segment.label}</Link>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          )}
          {!hideSearch && (
            <div className="absolute left-1/2 -translate-x-1/2 hidden md:block w-[448px]">
              <CommandPaletteTrigger />
            </div>
          )}

          {/* Right Actions - hidden on mobile, WeldAgent is in MobileHeader */}
          <div className="ml-auto hidden md:flex items-center gap-2">
            <Button
              onClick={toggleCalendar}
              data-testid="calendar-toggle"
              aria-label="Calendar"
              variant="outline"
              size="sm"
              className={cn(
                "shadow-none relative",
                showCalendar && "bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground"
              )}
            >
              <Calendar className="h-4 w-4" />
              {todayEventCount > 0 && !showCalendar && (
                <span
                  data-testid="calendar-today-badge"
                  className="absolute -top-[3px] -right-[3px] z-10 h-[9px] w-[9px] rounded-full bg-red-500 border border-red-600 ring-2 ring-background pointer-events-none"
                />
              )}
            </Button>
            <Button
              onClick={toggleNotifications}
              data-testid="notifications-bell"
              aria-label="Notifications"
              variant="outline"
              size="sm"
              className={cn(
                "shadow-none relative",
                showNotifications && "bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground"
              )}
            >
              <Bell className="h-4 w-4" />
              {notificationUnreadCount > 0 && !showNotifications && (
                <span
                  data-testid="notifications-unread-badge"
                  className="absolute -top-[3px] -right-[3px] z-10 h-[9px] w-[9px] rounded-full bg-red-500 border border-red-600 ring-2 ring-background pointer-events-none"
                />
              )}
            </Button>
            <Button
              onClick={toggleWeldAgent}
              data-testid="weldagent-toggle"
              aria-label="WeldAgent"
              variant="outline"
              size="sm"
              className={cn(
                "gap-1.5 shadow-none",
                showWeldAgent && "bg-primary text-primary-foreground border-primary hover:bg-primary/90 hover:text-primary-foreground"
              )}
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
            {actions}
          </div>
        </div>
      </header>
  );
}