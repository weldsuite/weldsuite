import type { ComponentType } from 'react';
import { Puzzle } from 'lucide-react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { getAppLogoConfig, getAppLucideIcon } from '@/lib/apps/app-registry';
import type { ModuleSidebarConfig } from './module-sidebar-configs';

/** Manifest navigation item shape (from weldapp.json → installed app manifest). */
export interface UserAppNavItem {
  id: string;
  label: string;
  path: string;
  icon?: string;
  permission?: string;
  group?: string;
}

/**
 * Fallback sidebar for known first-party hosted apps whose published manifest
 * predates the `navigation` field (or when production API stripped it).
 */
export const HOSTED_APP_NAV_FALLBACKS: Record<string, UserAppNavItem[]> = {
  weldcommerce: [
    { id: 'overview', label: 'Overview', path: '/', icon: 'LayoutDashboard' },
    { id: 'products', label: 'Products', path: '/products', icon: 'Package', permission: 'products:read' },
    { id: 'categories', label: 'Categories', path: '/categories', icon: 'FolderTree', permission: 'categories:read' },
    { id: 'orders', label: 'Orders', path: '/orders', icon: 'ShoppingCart', permission: 'orders:read' },
    { id: 'customers', label: 'Customers', path: '/customers', icon: 'Building', permission: 'companies:read' },
  ],
};

function navIcon(name?: string): ComponentType<{ className?: string }> {
  if (!name) return Puzzle;
  const iconName = name;
  return function UserAppNavIcon({ className }: { className?: string }) {
    return (
      <LucideDynamicIcon
        name={iconName}
        className={className}
        fallback={() => <Puzzle className={className} />}
      />
    );
  };
}

/** Normalize manifest path to a platform href under `/apps/{code}`. */
export function userAppNavHref(appCode: string, path: string): string {
  const normalized = path.trim() || '/';
  if (normalized === '/') return `/apps/${appCode}`;
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `/apps/${appCode}${withSlash}`;
}

/**
 * Build a ModuleSidebarConfig from a hosted WeldApp's declared `navigation`.
 * Apps declare items only — the platform renders UnifiedModuleSidebar.
 * When navigation is missing (older deploys), fall back to a single Home item
 * so the module chrome is never an empty panel.
 */
export function buildUserAppSidebarConfig(input: {
  appCode: string;
  name: string;
  icon?: string | null;
  navigation?: UserAppNavItem[] | null;
  defaultGroupLabel?: string;
}): ModuleSidebarConfig {
  const items =
    input.navigation && input.navigation.length > 0
      ? input.navigation
      : (HOSTED_APP_NAV_FALLBACKS[input.appCode] ?? [
          {
            id: 'home',
            label: 'Home',
            path: '/',
            icon: input.icon ?? 'LayoutDashboard',
          },
        ]);
  const appIcon = input.icon ? navIcon(input.icon) : getAppLucideIcon(input.appCode);
  const appLogo = getAppLogoConfig(input.appCode);
  const defaultGroup = input.defaultGroupLabel ?? 'General';

  return {
    appName: input.name,
    appIcon,
    appLogo,
    getMenuItems: () => {
      const groups = new Map<string, MenuGroupProps['items']>();
      for (const item of items) {
        const group = item.group?.trim() || defaultGroup;
        const list = groups.get(group) ?? [];
        list.push({
          id: item.id,
          title: item.label,
          href: userAppNavHref(input.appCode, item.path),
          icon: navIcon(item.icon),
          permission: item.permission,
        });
        groups.set(group, list);
      }
      return Array.from(groups.entries()).map(([group, groupItems]) => ({
        group,
        items: groupItems,
      }));
    },
  };
}

/** Extract app-relative path from `/apps/{code}…` platform pathname. */
export function userAppRelativePath(pathname: string, appCode: string): string {
  const prefix = `/apps/${appCode}`;
  if (pathname === prefix || pathname === `${prefix}/`) return '/';
  if (pathname.startsWith(`${prefix}/`)) {
    return `/${pathname.slice(prefix.length + 1)}`.replace(/\/+$/, '') || '/';
  }
  return '/';
}

/** True when pathname is under `/apps/{code}` (with optional subpaths). */
export function isUserAppPath(pathname: string): string | null {
  const match = pathname.match(/^\/apps\/([a-z][a-z0-9-]*)(?:\/|$)/);
  return match?.[1] ?? null;
}
