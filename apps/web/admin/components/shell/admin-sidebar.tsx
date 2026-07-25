'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@weldsuite/ui/components/sidebar';
import { SidebarUserMenu } from '@weldsuite/ui/components/sidebar-user-menu';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { ROLE_LABELS, type AdminRole } from '@/lib/roles';
import { getActiveArea, isItemActive } from './nav-config';
import { useTheme, type Theme } from './theme';

export interface AdminSidebarProps {
  name: string | null;
  email: string;
  role: AdminRole;
  avatar?: string;
}

const THEME_CYCLE: Theme[] = ['light', 'dark', 'system'];
const THEME_ICON: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};
const THEME_LABEL: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme();
  const Icon = THEME_ICON[theme];
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]!;

  return (
    <Button
      variant="ghost"
      onClick={() => setTheme(next)}
      title={`Theme: ${THEME_LABEL[theme]} — switch to ${THEME_LABEL[next]}`}
      className={cn(
        'w-full gap-2 px-2 text-muted-foreground hover:text-foreground',
        collapsed ? 'justify-center' : 'justify-start',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="text-sm">{THEME_LABEL[theme]}</span>}
    </Button>
  );
}

/**
 * The module sidebar. Same structure and chrome treatment as the platform's
 * `AppSidebarLayout`: inset from the top/bottom, flush against the rail on its
 * left with a rounded left card edge, no border — the panel/content colour
 * change is the seam.
 */
export function AdminSidebar({ name, email, role, avatar }: AdminSidebarProps) {
  const pathname = usePathname() ?? '/';
  const { state } = useSidebar();
  const { signOut } = useClerk();
  const collapsed = state === 'collapsed';

  const area = getActiveArea(pathname);
  const AreaIcon = area.icon;

  // Longest matching href wins, so `/apps` doesn't also light up while the
  // more specific `/apps/new` item is the real destination.
  const activeHref = React.useMemo(() => {
    const candidates = area.groups
      .flatMap((g) => g.items)
      .filter((item) => isItemActive(pathname, item.href))
      .sort((a, b) => b.href.length - a.href.length);
    return candidates[0]?.href ?? null;
  }, [area, pathname]);

  return (
    <Sidebar
      collapsible="offcanvas"
      className={cn(
        'left-16',
        'group-data-[side=left]:!border-r-0 md:py-2',
        '[&_[data-slot=sidebar-inner]]:!bg-[var(--shell-panel)]',
        '[&_[data-slot=sidebar-inner]]:rounded-l-xl',
      )}
    >
      <SidebarHeader className="pb-2.5">
        <div className="flex flex-col gap-1 px-2 pt-2 pb-0">
          <div
            className={cn(
              'flex items-center gap-2',
              collapsed ? 'justify-center px-0' : 'px-2',
            )}
          >
            <AreaIcon className="h-6 w-6 shrink-0" />
            {!collapsed && <span className="text-lg font-semibold">{area.name}</span>}
          </div>
          {!collapsed && (
            <div className="px-2 text-xs text-muted-foreground">
              WeldSuite Admin · {ROLE_LABELS[role]}
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="sidebar-hover-scrollbar">
        {area.groups.map((group) => (
          <SidebarGroup key={group.group}>
            <SidebarGroupLabel>{group.group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={activeHref === item.href}>
                        <Link href={item.href}>
                          <Icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <ThemeToggle collapsed={collapsed} />
        <SidebarUserMenu
          user={{ name: name ?? email, email, avatar }}
          onSignOut={() => void signOut()}
          collapsed={collapsed}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
