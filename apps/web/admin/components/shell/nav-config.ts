import { getTranslations } from '@weldsuite/i18n';
import {
  Building2,
  Coins,
  Globe,
  Headphones,
  LayoutDashboard,
  ListTree,
  Package,
  PackagePlus,
  Receipt,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The admin console mirrors the platform's two-level navigation:
 *
 *   rail (64px, far left)  →  one icon per AREA
 *   module sidebar (16rem) →  the pages inside the active area
 *
 * Both are driven off this single table so they can never drift apart.
 */

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

export interface NavArea {
  /** Stable key, also used to resolve the active area from the pathname. */
  key: string;
  /** Shown in the module sidebar header and the rail tooltip. */
  name: string;
  icon: LucideIcon;
  /** Where the rail icon points. */
  href: string;
  /** Extra path prefixes that also belong to this area. */
  matches?: string[];
  groups: NavGroup[];
}

export function getNavAreas(): NavArea[] {
  const pricing = getTranslations('host').adminPricing;
  return [
  {
    key: 'overview',
    name: 'Overview',
    icon: LayoutDashboard,
    href: '/',
    groups: [
      {
        group: 'Console',
        items: [{ title: 'Overview', href: '/', icon: LayoutDashboard }],
      },
      {
        group: 'Jump to',
        items: [
          { title: 'Support Inbox', href: '/support', icon: Headphones },
          { title: 'App Catalog', href: '/apps', icon: Package },
          { title: 'Workspaces', href: '/workspaces', icon: Building2 },
          { title: 'AI Costs', href: '/ai-costs', icon: Coins },
          { title: pricing.navJumpTo, href: '/domain-pricing', icon: Globe },
        ],
      },
    ],
  },
  {
    key: 'support',
    name: 'Support',
    icon: Headphones,
    href: '/support',
    groups: [
      {
        group: 'Support',
        items: [{ title: 'Enterprise Inbox', href: '/support', icon: Headphones }],
      },
    ],
  },
  {
    key: 'apps',
    name: 'App Catalog',
    icon: Package,
    href: '/apps',
    groups: [
      {
        group: 'Catalog',
        items: [
          { title: 'All Apps', href: '/apps', icon: ListTree },
          { title: 'New App', href: '/apps/new', icon: PackagePlus },
        ],
      },
    ],
  },
  {
    key: 'workspaces',
    name: 'Workspaces',
    icon: Building2,
    href: '/workspaces',
    groups: [
      {
        group: 'Tenants',
        items: [{ title: 'All Workspaces', href: '/workspaces', icon: Users }],
      },
    ],
  },
  {
    key: 'ai-costs',
    name: 'AI Costs',
    icon: Coins,
    href: '/ai-costs',
    groups: [
      {
        group: 'Spend',
        items: [{ title: 'Gateway Costs', href: '/ai-costs', icon: Receipt }],
      },
    ],
  },
  {
    key: 'domain-pricing',
    name: pricing.navArea,
    icon: Globe,
    href: '/domain-pricing',
    groups: [
      {
        group: pricing.navGroup,
        items: [{ title: pricing.navCatalog, href: '/domain-pricing', icon: Globe }],
      },
    ],
  },
  ];
}

/** Resolve the area that owns `pathname`, falling back to Overview. */
export function getActiveArea(pathname: string): NavArea {
  const areas = getNavAreas();
  const match = areas.filter((area) => area.href !== '/').find((area) => {
    const prefixes = [area.href, ...(area.matches ?? [])];
    return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  });
  return match ?? areas[0]!;
}

/**
 * Active-state matching, same rule the platform's sidebar uses: exact match, or
 * a strictly deeper nested route (so `/apps` doesn't light up on `/apps/new`
 * when `/apps/new` is itself a nav item — that one wins by exact match).
 */
export function isItemActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === '/') return false;
  const hrefSegments = href.split('/').filter(Boolean).length;
  const pathSegments = pathname.split('/').filter(Boolean).length;
  return pathname.startsWith(`${href}/`) && pathSegments > hrefSegments;
}
