import * as React from 'react';
import { useState, useEffect } from 'react';
import { Link, usePathname, useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import type { InstalledApp } from '@/lib/api/apps';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useAppPrefetch } from '@/hooks/use-app-prefetch';
import { useCanManageApps } from '@/hooks/queries/use-settings-queries';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getAppLogo, getAppLucideIcon, getAppSidebarIconClass } from '@/lib/apps/app-registry';
import { CalendarLogoIcon } from '@/components/calendar-logo-icon';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { Puzzle } from 'lucide-react';

/** Path this app's sidebar icon links to — WeldApps (`appType: 'user'`) are
 * hosted at `/apps/{code}`, first-party system apps keep their own `/{code}`
 * top-level route. */
function appHref(appCode: string, appType?: 'system' | 'user'): string {
  return appType === 'user' ? `/apps/${appCode}` : `/${appCode}`;
}

// Stable `app-nav-<appCode>` testid for each app's rail icon, keyed by the
// real branded app code (e.g. welddesk, weldcrm) — NOT legacy aliases. The
// e2e suite + AppShellPage target these.
const appNavTestId = (appCode: string) => `app-nav-${appCode}`;

function SidebarAppIcon({
  appCode,
  name,
  imgSize = 48,
  icon,
  appType,
}: {
  appCode: string;
  name: string;
  imgSize?: number;
  icon?: string;
  appType?: 'system' | 'user';
}) {
  if (appType === 'user') {
    // WeldApps aren't in APP_REGISTRY (that's first-party apps only) — render
    // the developer-declared lucide icon name, falling back to a generic
    // Puzzle icon for apps that didn't set one or set an unknown name.
    if (icon) {
      return <LucideDynamicIcon name={icon} className="h-6 w-6" fallback={() => <Puzzle className="h-6 w-6" />} />;
    }
    return <Puzzle className="h-6 w-6" />;
  }
  if (appCode === 'weldcalendar') {
    return <CalendarLogoIcon className={getAppSidebarIconClass(appCode) || 'h-6 w-6'} />;
  }
  const logoPath = getAppLogo(appCode, 'light');
  if (logoPath) {
    return (
      <img
        src={logoPath}
        alt={name}
        width={imgSize}
        height={imgSize}
        className={getAppSidebarIconClass(appCode) || 'h-6 w-6'}
      />
    );
  }
  const Icon = getAppLucideIcon(appCode);
  return <Icon className="h-6 w-6" />;
}

interface SortableAppItemProps {
  app: InstalledApp;
  href: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  onHover?: () => void;
  onHoverEnd?: () => void;
  isHomePage?: boolean;
}

function SortableAppItem({ app, href, icon, isActive, onClick, onHover, onHoverEnd, isHomePage }: SortableAppItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: app.appCode
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          ref={setNodeRef}
          href={href}
          data-testid={appNavTestId(app.appCode)}
          style={style}
          {...attributes}
          {...listeners}
          onClick={onClick}
          onMouseEnter={onHover}
          onMouseLeave={onHoverEnd}
          onFocus={onHover}
          className={cn(
            'group relative h-12 w-12 flex items-center justify-center rounded-lg transition-colors cursor-grab overflow-visible',
            isHomePage
              ? 'text-white/70 hover:text-white hover:bg-white/10'
              : 'hover:bg-accent hover:text-accent-foreground',
            isActive && (isHomePage ? 'bg-white/15 text-white' : 'bg-gray-200/60 dark:bg-accent/60'),
            isDragging && 'opacity-50 cursor-grabbing z-50'
          )}
        >
          <span className={cn('transition-all', !isActive && 'grayscale opacity-60 group-hover:grayscale-0 group-hover:opacity-100')}>
            {icon}
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{app.name}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface AppSidebarClientProps {
  installedApps: InstalledApp[];
  initialAppOrder?: string[];
}

export function AppSidebarClient({ installedApps, initialAppOrder = [] }: AppSidebarClientProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const { getClient } = useAppApiClient();
  const { prefetch: prefetchApp, cancel: cancelPrefetch } = useAppPrefetch();
  // App Store is an install/uninstall surface — only owners/admins can manage
  // apps, so hide the rail button entirely for everyone else.
  const { data: canManageApps } = useCanManageApps();

  // Track if component is mounted (client-side only)
  const [mounted, setMounted] = useState(false);

  // Sort apps based on saved order
  const sortApps = (apps: InstalledApp[], order: string[]): InstalledApp[] => {
    if (!order.length) return apps;
    return [...apps].sort((a, b) => {
      const indexA = order.indexOf(a.appCode);
      const indexB = order.indexOf(b.appCode);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
  };

  const [orderedApps, setOrderedApps] = useState<InstalledApp[]>(() =>
    sortApps(installedApps, initialAppOrder)
  );
  const [activeApp, setActiveApp] = useState<InstalledApp | null>(null);

  // Set mounted on client-side to avoid hydration mismatch with DnD IDs
  useEffect(() => {
    setMounted(true);
  }, []);

  // Update when installedApps changes (e.g., new app installed)
  useEffect(() => {
    setOrderedApps(prev => {
      const currentOrder = prev.map(a => a.appCode);
      return sortApps(installedApps, currentOrder);
    });
  }, [installedApps]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // Prevent accidental drags
      },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const app = orderedApps.find(a => a.appCode === event.active.id);
    setActiveApp(app || null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveApp(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedApps.findIndex(a => a.appCode === active.id);
    const newIndex = orderedApps.findIndex(a => a.appCode === over.id);
    const newOrder = arrayMove(orderedApps, oldIndex, newIndex);

    setOrderedApps(newOrder);

    // Persist to backend (fire and forget) — app-api PUT /api/user-preferences
    // (was api-worker PUT /settings/preferences).
    getClient().then((client) =>
      client.put('/user-preferences', {
        uiPreferences: { sidebarAppOrder: newOrder.map(a => a.appCode) },
      })
    ).catch(() => {
      // Silently fail - order is already updated in UI
    });
  };

  const handleAppClick = (path: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle modifier-clicks (open in new tab/window) and non-primary buttons
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(path);
  };

  const isActive = (path: string) => {
    if (path === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(path);
  };

  // Home now has its own module sidebar like every other module, so the
  // mini-sidebar uses the standard solid background + visible right border
  // here too. (Previously the home page used a glass variant that bled the
  // background image through, which made the right divider disappear once a
  // real module sidebar was placed next to it.)
  const isHomePage = false;

  return (
    <TooltipProvider>
      <div
        data-testid="app-sidebar"
        className={cn(
        'fixed left-0 top-0 h-full w-16 flex flex-col items-center py-[7px] gap-2 z-40 overflow-visible',
        // Transparent so the shell "chrome" backdrop shows through the rail.
        'bg-transparent'
      )}>
        {/* Home - Fixed, not draggable */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/"
              data-testid="app-nav-home"
              className={cn(
                'group relative h-12 w-12 flex items-center justify-center rounded-lg transition-colors',
                isHomePage
                  ? 'text-white/70 hover:text-white hover:bg-white/10'
                  : 'hover:bg-accent hover:text-accent-foreground',
                isActive('/') && (isHomePage ? 'bg-white/15 text-white' : 'bg-gray-200/60 dark:bg-accent/60')
              )}
            >
              <span className={cn('transition-all', !isActive('/') && 'grayscale opacity-60 group-hover:grayscale-0 group-hover:opacity-100')}>
                <img
                  src="/assets/images/weldsuite/logo-light.png"
                  alt="WeldSuite"
                  width={48}
                  height={48}
                  className="h-6 w-6"
                />
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>{t.navigation.home}</p>
          </TooltipContent>
        </Tooltip>

        {/* Draggable Apps - Only render DnD context after mount to avoid hydration mismatch */}
        {mounted ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedApps.map(a => a.appCode)}
              strategy={verticalListSortingStrategy}
            >
              {orderedApps.map((app) => {
                const icon = <SidebarAppIcon appCode={app.appCode} name={app.name} icon={app.icon} appType={app.appType} />;
                const appPath = appHref(app.appCode, app.appType);

                return (
                  <SortableAppItem
                    key={app.id}
                    app={app}
                    href={appPath}
                    icon={icon}
                    isActive={isActive(appPath)}
                    onClick={handleAppClick(appPath)}
                    onHover={() => {
                      // Rail items are plain <a> tags (dnd-kit needs the node
                      // ref), so TanStack's Link-level intent preload never
                      // fires here — warm the route chunk and the app's
                      // landing data ourselves on hover.
                      router.prefetch(appPath);
                      prefetchApp(app.appCode);
                    }}
                    onHoverEnd={() => cancelPrefetch(app.appCode)}
                    isHomePage={isHomePage}
                  />
                );
              })}
            </SortableContext>

            <DragOverlay>
              {activeApp && (
                <div className="h-12 w-12 flex items-center justify-center rounded-lg bg-gray-200/60 dark:bg-accent/60 shadow-lg">
                  <SidebarAppIcon appCode={activeApp.appCode} name={activeApp.name} imgSize={56} icon={activeApp.icon} appType={activeApp.appType} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        ) : (
          // Static version for SSR/initial render
          <>
            {orderedApps.map((app) => {
              const icon = <SidebarAppIcon appCode={app.appCode} name={app.name} imgSize={56} icon={app.icon} appType={app.appType} />;
              const appPath = appHref(app.appCode, app.appType);

              return (
                <Tooltip key={app.id}>
                  <TooltipTrigger asChild>
                    <Link
                      href={appPath}
                      data-testid={appNavTestId(app.appCode)}
                      onMouseEnter={() => prefetchApp(app.appCode)}
                      onMouseLeave={() => cancelPrefetch(app.appCode)}
                      onFocus={() => prefetchApp(app.appCode)}
                      className={cn(
                        'group relative h-12 w-12 flex items-center justify-center rounded-lg transition-colors overflow-visible',
                        isHomePage
                          ? 'text-white/70 hover:text-white hover:bg-white/10'
                          : 'hover:bg-accent hover:text-accent-foreground',
                        isActive(appPath) && (isHomePage ? 'bg-white/15 text-white' : 'bg-gray-200/60 dark:bg-accent/60')
                      )}
                    >
                      <span className={cn('transition-all', !isActive(appPath) && 'grayscale opacity-60 group-hover:grayscale-0 group-hover:opacity-100')}>
                        {icon}
                      </span>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>{app.name}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </>
        )}

        <div className="flex-1" />

        {/* AI Agents */}
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="/agents"
              onClick={handleAppClick('/agents')}
              onMouseEnter={() => router.prefetch('/agents')}
              onFocus={() => router.prefetch('/agents')}
              className={cn(
                'relative h-12 w-12 flex items-center justify-center rounded-lg transition-colors',
                isHomePage
                  ? 'text-white/70 hover:text-white hover:bg-white/10'
                  : 'hover:bg-accent hover:text-accent-foreground',
                isActive('/agents') && (isHomePage ? 'bg-white/15 text-white' : 'bg-gray-200/60 dark:bg-accent/60')
              )}
            >
              <img
                src="/assets/images/weldagent/icon.svg"
                alt="WeldAgent"
                className="h-6 w-6"
              />
            </a>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>{t.navigation.aiAgents}</p>
          </TooltipContent>
        </Tooltip>

        {/* App Store - Fixed at bottom. Only shown to users who can manage apps. */}
        {canManageApps ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/appstore"
              data-testid="app-nav-appstore"
              className={cn(
                'h-12 w-12 flex items-center justify-center rounded-md transition-colors border border-dashed',
                isHomePage
                  ? 'text-white/70 hover:text-white hover:bg-white/10 border-white/30'
                  : 'hover:bg-accent hover:text-accent-foreground border-gray-300 dark:border-border',
                isActive('/appstore') && (isHomePage ? 'bg-white/15 text-white' : 'bg-gray-200/60 dark:bg-accent/60')
              )}
            >
              <Plus className="h-5 w-5" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>{t.navigation.appStore}</p>
          </TooltipContent>
        </Tooltip>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
