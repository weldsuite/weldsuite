
import { useState, useRef, useEffect, Fragment } from 'react';
import { useRouter, usePathname, Link } from '@/lib/router';
import { SidebarTrigger } from '@weldsuite/ui/components/sidebar';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { Search, Loader2, Check, Bell, Calendar } from 'lucide-react';
import { useUpcomingCalendarEvents } from '@/hooks/queries/use-calendar-queries';
import { useUnifiedNotifications } from '@/contexts/unified-notification-context';
import { useCalendarDrawerOpen } from '@/hooks/use-calendar-drawer-open';
import { useNotificationsPanelOpen } from '@/hooks/use-notifications-panel-open';
import { useSidebarBadges } from '@/hooks/use-sidebar-badges';
import { cn } from '@/lib/utils';
import { Kbd } from '@weldsuite/ui/components/kbd';
import { useWeldAgentSafe } from '@/components/weldagent-wrapper';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';
import { useMeetingPanelOpen } from '@/hooks/use-meeting-panel-open';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@weldsuite/ui/components/breadcrumb';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useEntitySheet, hasEntitySheetRenderer } from '@/components/entity-sheet';
import type { SearchEntityType } from '@weldsuite/core-api-client/schemas/search';
import { useGlobalSearch } from '@/hooks/queries/use-global-search-queries';
import { RESULT_TYPE_ICON, RESULT_TYPE_LABEL } from '@/lib/search/result-types';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  description?: string;
  href: string;
  type?: string;
}

interface BreadcrumbHeaderProps {
  segments: BreadcrumbSegment[];
  /**
   * Optional escape hatch for callsites that need a custom (non-federated) search
   * — e.g. searching within a single mail folder. When omitted, the centered
   * search uses the same federated `useGlobalSearch` backend that powers Cmd+K,
   * spanning customer / contact / lead / opportunity / ticket / article / product
   * / order / invoice / bill / project / task across the platform.
   */
  onSearch?: (query: string) => Promise<SearchResult[]>;
  searchPlaceholder?: string;
  /** Hide the centered search input entirely (rare — most modules want it). */
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
  onSearch,
  searchPlaceholder = 'Search anything…',
  hideSearch = false,
  showBackButton = false,
  onBack,
  actions,
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
  weldAgentWidth = 480,
  calendarWidth = 480,
  notificationsWidth = 480,
  initialShowWeldAgent = false,
  disableWeldAgentAnimation = false,
  moduleKey,
  calendarOpen,
}: BreadcrumbHeaderProps) {
  // When no `onSearch` callback is supplied, drive the dropdown from the same
  // federated `POST /api/search` backend that powers Cmd+K. Modules don't have
  // to wire anything — global, cross-app results by default.
  const useGlobal = !onSearch;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

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
  const { counts: badgeCounts } = useSidebarBadges();
  const { data: todayEventsData } = useUpcomingCalendarEvents({ days: 1 });
  const todayEventCount = todayEventsData?.data?.filter((e: any) => e.status !== 'cancelled').length ?? 0;
  const router = useRouter();
  const pathname = usePathname();
  const commandRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Get entity context from WeldAgent provider (safe version returns null if provider missing)
  const weldAgentContext = useWeldAgentSafe();
  const entityContext = weldAgentContext?.entityContext;

  // Sample data for each mention type
  const mentionData = {
    products: [
      { id: '1', name: 'Product A' },
      { id: '2', name: 'Product B' },
      { id: '3', name: 'Product C' },
    ],
    orders: [
      { id: '1', name: 'Order #1001' },
      { id: '2', name: 'Order #1002' },
      { id: '3', name: 'Order #1003' },
    ],
    customers: [
      { id: '1', name: 'John Doe' },
      { id: '2', name: 'Jane Smith' },
      { id: '3', name: 'Bob Johnson' },
    ],
    collections: [
      { id: '1', name: 'Summer Collection' },
      { id: '2', name: 'Winter Collection' },
      { id: '3', name: 'Spring Collection' },
    ],
    invoices: [
      { id: '1', name: 'Invoice #INV-001' },
      { id: '2', name: 'Invoice #INV-002' },
      { id: '3', name: 'Invoice #INV-003' },
    ],
    companies: [
      { id: '1', name: 'Acme Corp' },
      { id: '2', name: 'Tech Solutions Inc' },
      { id: '3', name: 'Global Industries' },
    ],
  };

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
  }, [showCalendar, showNotifications, onCalendarToggle, onNotificationsToggle]);

  // Check if we're on a detail page
  const isDetailPage = pathname?.split('/').length > 3;

  // initialShowWeldAgent is now driven by the parent layout via setShowWeldAgent (which routes through the
  // shared hook). No manual sync needed — every consumer of useWeldAgentDrawerOpen receives the same value.

  // Sync showCalendar state with external calendarOpen prop
  useEffect(() => {
    if (calendarOpen !== undefined && showCalendar !== calendarOpen) {
      setShowCalendar(calendarOpen);
    }
  }, [calendarOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        commandRef.current &&
        !commandRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setOpen(false);
        setSearch('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('pointerdown', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('pointerdown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const { open: openEntitySheet } = useEntitySheet();
  const newTabRef = useRef(false);

  const captureClickIntent = (e: React.MouseEvent | React.KeyboardEvent) => {
    if ('button' in e) {
      newTabRef.current = e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
    } else {
      newTabRef.current = e.metaKey || e.ctrlKey || e.shiftKey;
    }
  };

  const handleSelect = (result: SearchResult) => {
    const newTab = newTabRef.current;
    newTabRef.current = false;
    setOpen(false);
    setSearch('');

    if (newTab) {
      window.open(result.href, '_blank', 'noopener');
      return;
    }

    if (hasEntitySheetRenderer(result.type)) {
      openEntitySheet(result.type as SearchEntityType, result.id);
    } else {
      router.push(result.href);
    }
  };

  // ── Global federated search (default, used when no onSearch is provided) ──
  // Same `POST /api/search` backend as the Cmd+K palette → results span all
  // entity types regardless of which module's header rendered us.
  const globalQuery = useGlobalSearch(search, {
    enabled: useGlobal && open && search.trim().length > 0,
    limit: 8,
  });

  useEffect(() => {
    if (!useGlobal) return;
    const groups = globalQuery.data?.data ?? [];
    const flat: SearchResult[] = [];
    for (const group of groups) {
      for (const item of group.items) {
        flat.push({
          id: item.id,
          type: item.type,
          title: item.title,
          description: item.subtitle ?? undefined,
          href: item.url,
        });
      }
    }
    setResults(flat);
  }, [useGlobal, globalQuery.data]);

  useEffect(() => {
    if (!useGlobal) return;
    setLoading(globalQuery.isFetching);
  }, [useGlobal, globalQuery.isFetching]);

  // ── Custom (escape-hatch) search via the onSearch callback ──
  const fetchSearchResults = async (query: string) => {
    if (!onSearch) return;
    setLoading(true);
    try {
      const searchResults = await onSearch(query);
      setResults(searchResults);
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchSuggestions = async () => {
    if (!onSearch) return;
    setLoading(true);
    try {
      const suggestions = await onSearch(search);
      setResults(suggestions);
    } catch (error) {
      console.error('Suggestions error:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  // Immediately fetch results when dropdown opens (custom-search mode only)
  useEffect(() => {
    if (open && onSearch) {
      fetchSuggestions();
    }
  }, [open]);

  // Debounced refetch on query change (custom-search mode only — global search
  // is debounced by TanStack Query / React's batching of `search` state writes).
  useEffect(() => {
    if (useGlobal) return;
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      fetchSearchResults(search);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [search, useGlobal]);

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  return (
    <>
      <header className="hidden md:flex h-[60px] shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 bg-[var(--shell-panel)] relative">
        <div className="flex items-center gap-2 px-4 w-full relative z-10">
          <SidebarTrigger className="-ml-1 hidden md:flex" />
          <div className="ml-px mr-[8px] h-[19px] w-px bg-gray-200/70 dark:bg-secondary/70 hidden md:block shrink-0" />
          {/* Breadcrumb trail - max-width prevents overlap with centered search bar (448px wide) */}
          {segments.length > 0 && (
            <Breadcrumb className={cn("hidden md:flex overflow-hidden", !hideSearch ? "max-w-[calc(50%-280px)]" : "max-w-[40%]")}>
              <BreadcrumbList className="flex-nowrap overflow-hidden">
                {segments.map((segment, index) => {
                  const isLast = index === segments.length - 1;

                  return (
                    // Key by index, not href: a crumb trail can legitimately
                    // repeat an href (e.g. home renders "WeldSuite" and "Home"
                    // both linking to "/"), and keying by href then collides
                    // → React "two children with the same key" warning.
                    <Fragment key={index}>
                      {index > 0 && <BreadcrumbSeparator className="shrink-0" />}
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
          {/* Centered Search - hidden on mobile, absolutely centered */}
          {!hideSearch && (
            <div className="absolute left-1/2 -translate-x-1/2 hidden md:block w-[448px]">
              <div className="relative w-full">
                <div className="relative" suppressHydrationWarning>
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    ref={inputRef}
                    type="text"
                    placeholder={searchPlaceholder}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onFocus={() => {
                      setOpen(true);
                      if (onSearch) fetchSuggestions();
                    }}
                    onBlur={() => {
                      // Delay so clicks on dropdown items register before closing
                      setTimeout(() => setOpen(false), 50);
                    }}
                    className="pl-9 pr-16 h-9"
                    suppressHydrationWarning
                  />
                  {!loading && !search && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center gap-0.5">
                      <Kbd className="text-base flex items-center justify-center pt-0.5">⌘</Kbd>
                      <Kbd className="text-[10px] flex items-center justify-center">K</Kbd>
                    </div>
                  )}
                  {loading && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>

                {open && (
                  <div
                    ref={commandRef}
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute top-full mt-2 w-full z-50 rounded-md border bg-popover shadow-md"
                  >
                    <Command>
                      <CommandList>
                        <CommandEmpty>No results found.</CommandEmpty>
                        {results.length > 0 && (() => {
                          // Group results by type
                          const grouped = results.reduce((acc, result) => {
                            const type = result.type || 'other';
                            if (!acc[type]) acc[type] = [];
                            acc[type].push(result);
                            return acc;
                          }, {} as Record<string, typeof results>);

                          return Object.entries(grouped).map(([type, items]) => {
                            const Icon = RESULT_TYPE_ICON[type as SearchEntityType] ?? Search;
                            const label = RESULT_TYPE_LABEL[type as SearchEntityType] ?? type.charAt(0).toUpperCase() + type.slice(1);

                            return (
                              <CommandGroup key={type} heading={label}>
                                {items.map((result) => (
                                  <CommandItem
                                    key={result.id}
                                    onMouseDown={captureClickIntent}
                                    onAuxClick={captureClickIntent}
                                    onKeyDown={captureClickIntent}
                                    onSelect={() => handleSelect(result)}
                                    className="cursor-pointer"
                                  >
                                    <Icon className="mr-2 h-4 w-4 text-muted-foreground shrink-0" />
                                    <div className="flex flex-col min-w-0">
                                      <span className="font-medium truncate">{result.title}</span>
                                      {result.description && (
                                        <span className="text-sm text-muted-foreground truncate">
                                          {result.description}
                                        </span>
                                      )}
                                    </div>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            );
                          });
                        })()}
                      </CommandList>
                    </Command>
                  </div>
                )}
              </div>
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
    </>
  );
}