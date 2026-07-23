
import * as React from 'react';
import { usePathname, useRouter } from '@/lib/router';
import {
  Plus,
  Warehouse,
  ChevronDown,
  Settings,
  ArrowLeftRight,
  LogOut,
  Check,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@weldsuite/ui/components/sheet';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@weldsuite/ui/components/collapsible';
import { useMobileNav } from '@/contexts/mobile-nav-context';
import { cn } from '@/lib/utils';
import type { InstalledApp } from '@/lib/api/apps';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useClerk, useOrganization, useOrganizationList } from '@clerk/clerk-react';
import { useSettings } from '@/providers/settings-provider';
import { useSidebarBadges } from '@/hooks/use-sidebar-badges';
import { useCanManageApps } from '@/hooks/queries/use-settings-queries';
import { useTheme } from '@/hooks/use-theme';
import { getAppLogo, getAppLucideIcon, getAppSidebarIconClass } from '@/lib/apps/app-registry';
import { CalendarLogoIcon } from '@/components/calendar-logo-icon';
import { Button } from '@weldsuite/ui/components/button';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { Puzzle } from 'lucide-react';

const iconMap: Record<string, React.ReactNode> = {
  wms: <Warehouse className="h-5 w-5" />,
};

interface MobileSidebarProps {
  installedApps: InstalledApp[];
}

/** Mirrors `appHref` in app-sidebar-client.tsx — WeldApps live at `/apps/{code}`. */
function appHref(appCode: string, appType?: 'system' | 'user'): string {
  return appType === 'user' ? `/apps/${appCode}` : `/${appCode}`;
}

interface RailIconProps {
  appCode: string;
  name: string;
  icon?: string;
  appType?: 'system' | 'user';
}

function RailAppIcon({ appCode, name, icon, appType }: RailIconProps) {
  if (appType === 'user') {
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
        width={48}
        height={48}
        className={getAppSidebarIconClass(appCode) || 'h-6 w-6'}
      />
    );
  }
  const fallback = iconMap[appCode];
  if (fallback) return <>{fallback}</>;
  const Icon = getAppLucideIcon(appCode);
  return <Icon className="h-6 w-6" />;
}

export function MobileSidebar({ installedApps }: MobileSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const st = useTranslations();
  const { isOpen, setIsOpen, moduleMenuItems, moduleInfo } = useMobileNav();
  const { signOut } = useClerk();
  const { organization } = useOrganization();
  const { userMemberships, setActive } = useOrganizationList({ userMemberships: true });
  const { openSettings } = useSettings();
  const { counts: badgeCounts } = useSidebarBadges();
  // App Store is owner/admin-only (install/uninstall surface) — hide otherwise.
  const { data: canManageApps } = useCanManageApps();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [showWorkspaces, setShowWorkspaces] = React.useState(false);
  const activeAppRef = React.useRef<HTMLButtonElement>(null);

  // Scroll active app icon into view when the menu opens
  React.useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        activeAppRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const workspaces = userMemberships?.data?.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
  })) || [];

  const isAppActive = (path: string) => {
    if (path === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(path);
  };

  const isMenuItemActive = (href: string) => {
    const allMenuItems = moduleMenuItems.flatMap((g) => g.items);
    const isExactMatch = pathname === href;
    const isChildRoute =
      pathname?.startsWith(href + '/') &&
      !allMenuItems.some(
        (otherItem) =>
          otherItem.href !== href &&
          otherItem.href.length > href.length &&
          (pathname === otherItem.href || pathname?.startsWith(otherItem.href + '/'))
      );
    return isExactMatch || isChildRoute;
  };

  const handleAppClick = (_appCode: string, path: string) => {
    setIsOpen(false);
    router.push(path);
  };

  const handleMenuItemClick = (href: string) => {
    setIsOpen(false);
    router.push(href);
  };

  const getBadgeCount = (appCode: string): number | undefined => {
    switch (appCode) {
      case 'weldmail':
        return badgeCounts.mail;
      case 'welddesk':
        return badgeCounts.helpdesk;
      case 'weldconnect':
        return badgeCounts.calendar;
      default:
        return undefined;
    }
  };

  const renderRailButton = (params: {
    isActive: boolean;
    onClick: () => void;
    title: string;
    children: React.ReactNode;
    badgeCount?: number;
    showBeta?: boolean;
    refIfActive?: boolean;
    grayscaleWhenInactive?: boolean;
    dashedBorder?: boolean;
  }) => {
    const {
      isActive,
      onClick,
      title,
      children,
      badgeCount,
      showBeta,
      refIfActive,
      grayscaleWhenInactive = true,
      dashedBorder,
    } = params;
    return (
      <Button
        variant="ghost"
        ref={refIfActive && isActive ? activeAppRef : undefined}
        onClick={onClick}
        title={title}
        className={cn(
          'group relative h-12 w-12 flex items-center justify-center rounded-lg transition-colors flex-shrink-0 overflow-visible',
          'hover:bg-accent hover:text-accent-foreground',
          isActive && 'bg-gray-200/60 dark:bg-accent/60',
          dashedBorder && 'border border-dashed border-gray-300 dark:border-border'
        )}
      >
        <span
          className={cn(
            'transition-all',
            grayscaleWhenInactive && !isActive && 'grayscale opacity-60'
          )}
        >
          {children}
        </span>
        {typeof badgeCount === 'number' && badgeCount > 0 ? (
          <span
            className={cn(
              'absolute -top-[4px] -right-[3px] z-10 text-[12px] font-mono font-medium leading-none text-white bg-red-500 border border-red-600 h-[22px] flex items-center justify-center rounded-[8px] pointer-events-none',
              badgeCount > 99
                ? 'min-w-[32px] px-[5px] indent-[1.5px]'
                : badgeCount >= 10
                ? 'min-w-[26px] px-[4px] indent-[1.5px]'
                : 'w-[22px] indent-[0.5px]'
            )}
          >
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ) : null}
        {showBeta ? (
          <span className="absolute -top-1 -right-1 z-10 text-[10px] font-mono text-white bg-black border border-black h-[16px] flex items-center justify-center rounded-[5px] px-1 pointer-events-none">
            <span className="-translate-y-[0.5px]">{st('sweep.shared.beta')}</span>
          </span>
        ) : null}
      </Button>
    );
  };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetContent
        side="left"
        hideClose
        className="w-[336px] max-w-[92vw] p-0 gap-0 flex flex-row z-[100] overflow-hidden"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{st('sweep.shared.navigation')}</SheetTitle>
          <SheetDescription>{st('sweep.shared.mainNavigationMenu')}</SheetDescription>
        </SheetHeader>

        {/* Left: Mini App Rail (vertical) */}
        <div className="w-16 shrink-0 border-r bg-background flex flex-col items-center py-[7px] gap-2 overflow-y-auto overflow-x-visible scrollbar-hide">
          {/* Home */}
          {renderRailButton({
            isActive: isAppActive('/'),
            onClick: () => handleAppClick('home', '/'),
            title: t.navigation.home,
            refIfActive: true,
            showBeta: true,
            children: (
              <img
                src="/assets/images/weldsuite/logo-light.png"
                alt="WeldSuite"
                width={48}
                height={48}
                className="h-6 w-6"
              />
            ),
          })}

          {/* Installed Apps */}
          {installedApps.map((app) => {
            const appPath = appHref(app.appCode, app.appType);
            const showBeta =
              app.appCode === 'welddesk' ||
              app.appCode === 'weldconnect';
            return (
              <React.Fragment key={app.id}>
                {renderRailButton({
                  isActive: isAppActive(appPath),
                  onClick: () => handleAppClick(app.appCode, appPath),
                  title: app.name,
                  refIfActive: true,
                  badgeCount: getBadgeCount(app.appCode),
                  showBeta,
                  children: <RailAppIcon appCode={app.appCode} name={app.name} icon={app.icon} appType={app.appType} />,
                })}
              </React.Fragment>
            );
          })}

          <div className="flex-1" />

          {/* AI Agents */}
          {renderRailButton({
            isActive: isAppActive('/agents'),
            onClick: () => handleAppClick('agents', '/agents'),
            title: t.navigation.aiAgents,
            refIfActive: true,
            grayscaleWhenInactive: false,
            showBeta: true,
            children: (
              <img
                src="/assets/images/weldagent/icon.svg"
                alt="WeldAgent"
                className="h-6 w-6"
              />
            ),
          })}

          {/* App Store — only for users who can manage apps */}
          {canManageApps && renderRailButton({
            isActive: isAppActive('/appstore'),
            onClick: () => handleAppClick('appstore', '/appstore'),
            title: t.navigation.appStore,
            refIfActive: true,
            grayscaleWhenInactive: false,
            dashedBorder: true,
            children: <Plus className="h-5 w-5" />,
          })}
        </div>

        {/* Right: Active App Header + Menu Items + Footer */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Active app header (logo + name) — mirrors desktop top-of-sidebar */}
          <div className="h-14 px-4 border-b flex items-center gap-2">
            {moduleInfo?.logo && (isDark ? moduleInfo.logo.textDark : moduleInfo.logo.textLight) ? (
              <img
                src={isDark ? moduleInfo.logo.textDark : moduleInfo.logo.textLight}
                alt={moduleInfo.name}
                width={320}
                height={80}
                className={moduleInfo.logo.textClassName || 'h-auto w-[140px]'}
              />
            ) : moduleInfo ? (
              <>
                {moduleInfo.logo ? (
                  <img
                    src={isDark ? moduleInfo.logo.iconDark : moduleInfo.logo.iconLight}
                    alt={moduleInfo.name}
                    width={48}
                    height={48}
                    className={moduleInfo.logo.iconClassName || 'h-5 w-5 shrink-0'}
                  />
                ) : (
                  <moduleInfo.icon className="h-5 w-5 shrink-0" />
                )}
                <span className="text-base font-semibold truncate">{moduleInfo.name}</span>
              </>
            ) : (
              <span className="text-base font-semibold">WeldSuite</span>
            )}
          </div>

          {/* Module Menu Items */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="p-2 space-y-4">
              {moduleMenuItems.map((group, groupIndex) => (
                <div key={group.groupKey ?? `${group.group}:${groupIndex}`}>
                  {group.group && (
                    <h3 className="mb-2 px-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {group.group}
                    </h3>
                  )}
                  {/* customContent intentionally not rendered — see original comment about
                      SidebarMenuButton requiring SidebarProvider, which MobileSidebar lacks. */}
                  {group.items.length === 0 && group.onAdd && (
                    <Button
                      variant="ghost"
                      onClick={() => { setIsOpen(false); group.onAdd!(); }}
                      className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-gray-300 dark:border-border hover:border-gray-400 dark:hover:border-gray-500 rounded-md transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                      <span>
                        {st('sweep.shared.addItem', {
                          item: group.group?.toLowerCase().replace(/s$/, '') ?? '',
                        })}
                      </span>
                    </Button>
                  )}
                  <nav className="space-y-1">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const isActive = isMenuItemActive(item.href);
                      const hasSubItems = item.subItems && item.subItems.length > 0;

                      if (hasSubItems) {
                        return (
                          <Collapsible key={item.href} defaultOpen>
                            <div className="space-y-1">
                              <CollapsibleTrigger className="w-full">
                                <div
                                  className={cn(
                                    'flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                                    'hover:bg-accent hover:text-accent-foreground'
                                  )}
                                >
                                  <div className="flex items-center gap-3 min-w-0 flex-1">
                                    {Icon ? (
                                      item.iconStyle === 'colored-square' ? (
                                        <div className={cn(
                                          "flex items-center justify-center w-[18px] h-[18px] rounded-[6px] shrink-0",
                                          item.iconColor || "bg-gray-500"
                                        )}>
                                          <Icon className="h-2.5 w-2.5 text-white" />
                                        </div>
                                      ) : (
                                        <Icon className="h-4 w-4 shrink-0" />
                                      )
                                    ) : null}
                                    <span className="truncate min-w-0">{item.title}</span>
                                  </div>
                                  <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                                </div>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div className="ml-6 space-y-1 border-l pl-3">
                                  {item.subItems?.map((subItem) => {
                                    const isSubActive = pathname === subItem.href;
                                    return (
                                      <Button
                                        key={subItem.href}
                                        variant="ghost"
                                        onClick={() => handleMenuItemClick(subItem.href)}
                                        className={cn(
                                          'w-full flex items-center rounded-md px-3 py-2 text-sm transition-colors text-left',
                                          'hover:bg-accent hover:text-accent-foreground',
                                          isSubActive && 'bg-accent text-accent-foreground font-medium'
                                        )}
                                      >
                                        <span className="truncate min-w-0 flex-1">{subItem.title}</span>
                                      </Button>
                                    );
                                  })}
                                </div>
                              </CollapsibleContent>
                            </div>
                          </Collapsible>
                        );
                      }

                      return (
                        <Button
                          key={item.href}
                          variant="ghost"
                          onClick={() => handleMenuItemClick(item.href)}
                          className={cn(
                            'w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors text-left',
                            'hover:bg-accent hover:text-accent-foreground',
                            isActive && 'bg-accent text-accent-foreground font-medium'
                          )}
                        >
                          {Icon ? (
                            item.iconStyle === 'colored-square' ? (
                              <div className={cn(
                                "flex items-center justify-center w-[18px] h-[18px] rounded-[6px] shrink-0",
                                item.iconColor || "bg-gray-500"
                              )}>
                                <Icon className="h-2.5 w-2.5 text-white" />
                              </div>
                            ) : (
                              <Icon className="h-4 w-4 shrink-0" />
                            )
                          ) : null}
                          <span className={cn("truncate min-w-0 flex-1", item.bold && "font-semibold")}>{item.title}</span>
                          {item.badge && (
                            <span className="shrink-0 text-[11px] font-mono font-medium leading-none text-white bg-red-500 border border-red-600 h-[18px] min-w-[18px] px-1 flex items-center justify-center rounded-[6px]">
                              {item.badge}
                            </span>
                          )}
                        </Button>
                      );
                    })}
                  </nav>
                </div>
              ))}

              {moduleMenuItems.length === 0 && (
                <p className="text-sm text-muted-foreground px-2">
                  {st('sweep.shared.selectAppToSeeMenu')}
                </p>
              )}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="border-t p-2 space-y-1">
            {/* Workspace Switcher */}
            <Button
              variant="ghost"
              onClick={() => setShowWorkspaces(!showWorkspaces)}
              className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors text-left hover:bg-accent hover:text-accent-foreground"
            >
              <ArrowLeftRight className="h-4 w-4" />
              <span className="flex-1 truncate">{organization?.name || st('sweep.shared.workspace')}</span>
              {workspaces.length > 1 && <ChevronDown className={cn("h-4 w-4 transition-transform", showWorkspaces && "rotate-180")} />}
            </Button>
            {showWorkspaces && workspaces.length > 1 && (
              <div className="ml-7 space-y-0.5 pb-1">
                {workspaces.map((ws) => (
                  <Button
                    key={ws.id}
                    variant="ghost"
                    onClick={() => {
                      if (ws.id !== organization?.id) {
                        setActive?.({ organization: ws.id });
                      }
                      setShowWorkspaces(false);
                      setIsOpen(false);
                    }}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors text-left',
                      'hover:bg-accent hover:text-accent-foreground',
                      ws.id === organization?.id && 'text-foreground font-medium'
                    )}
                  >
                    <span className="flex-1 truncate">{ws.name}</span>
                    {ws.id === organization?.id && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Button>
                ))}
              </div>
            )}

            {/* Settings */}
            <Button
              variant="ghost"
              onClick={() => { setIsOpen(false); openSettings(); }}
              className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors text-left hover:bg-accent hover:text-accent-foreground"
            >
              <Settings className="h-4 w-4" />
              <span>{st('sweep.shared.settings')}</span>
            </Button>

            {/* Sign Out */}
            <Button
              variant="ghost"
              onClick={() => { setIsOpen(false); signOut({ redirectUrl: '/auth/login' }); }}
              className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors text-left hover:bg-accent hover:text-accent-foreground text-red-600 dark:text-red-400"
            >
              <LogOut className="h-4 w-4" />
              <span>{st('sweep.shared.signOut')}</span>
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
