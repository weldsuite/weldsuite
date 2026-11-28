import { getTranslations } from '@weldsuite/i18n';
import {
  Building2,
  CreditCard,
  Flag,
  FileText,
  Flame,
  LayoutDashboard,
  MailWarning,
  History,
  ListTree,
  Package,
  PackagePlus,
  ShieldCheck,
  UserCog,
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

/** The areas, groups and items of the console. */
export function getNavAreas(): NavArea[] {
  const billing = getTranslations('admin').nav;
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
          { title: 'App Catalog', href: '/apps', icon: Package },
          { title: 'Access requests', href: '/access-requests', icon: ShieldCheck },
          { title: 'Warmup network', href: '/warmup', icon: Flame },
          { title: 'Outbound mail', href: '/outbound-mail', icon: MailWarning },
          { title: 'WeldForms', href: '/weldforms', icon: FileText },
          { title: 'Workspaces', href: '/workspaces', icon: Building2 },
          { title: billing.plans, href: '/plans', icon: CreditCard },
          { title: billing.activity, href: '/activity', icon: History },
          { title: billing.staff, href: '/staff', icon: UserCog },
          { title: billing.flags, href: '/flags', icon: Flag },
        ],
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
    key: 'access-requests',
    name: 'Access requests',
    icon: ShieldCheck,
    href: '/access-requests',
    groups: [
      {
        group: 'Review',
        items: [{ title: 'Access requests', href: '/access-requests', icon: ShieldCheck }],
      },
    ],
  },
  {
    key: 'warmup',
    name: 'Warmup network',
    icon: Flame,
    href: '/warmup',
    groups: [
      {
        group: 'WeldReach',
        items: [{ title: 'Warmup network', href: '/warmup', icon: Flame }],
      },
    ],
  },
  {
    key: 'outbound-mail',
    name: 'Outbound mail',
    icon: MailWarning,
    href: '/outbound-mail',
    groups: [
      {
        group: 'WeldMail',
        items: [{ title: 'Outbound mail', href: '/outbound-mail', icon: MailWarning }],
      },
    ],
  },
  {
    key: 'weldforms',
    name: 'WeldForms',
    icon: FileText,
    href: '/weldforms',
    groups: [
      {
        group: 'Moderation',
        items: [{ title: 'WeldForms', href: '/weldforms', icon: FileText }],
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
    key: 'staff',
    name: billing.staff,
    icon: UserCog,
    href: '/staff',
    groups: [{ group: billing.staffGroup, items: [{ title: billing.staffList, href: '/staff', icon: UserCog }] }],
  },
  {
    key: 'flags',
    name: billing.flags,
    icon: Flag,
    href: '/flags',
    groups: [{ group: billing.flagsGroup, items: [{ title: billing.flagsList, href: '/flags', icon: Flag }] }],
  },
  {
    key: 'billing',
    name: billing.billingArea,
    icon: CreditCard,
    href: '/plans',
    matches: ['/activity'],
    groups: [
      {
        group: billing.catalogGroup,
        items: [
          { title: billing.plans, href: '/plans', icon: ListTree },
          { title: billing.newPlan, href: '/plans/new', icon: PackagePlus },
        ],
      },
      {
        group: billing.auditGroup,
        items: [{ title: billing.activity, href: '/activity', icon: History }],
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
