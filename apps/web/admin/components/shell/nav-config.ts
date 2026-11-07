import { getTranslations } from '@weldsuite/i18n';
import { GLOBAL } from '@/lib/edition';
import { partnersCopy } from '@/lib/partners-copy';
import {
  Building2,
  Coins,
  CreditCard,
  Database,
  Flame,
  Globe,
  Handshake,
  Headphones,
  LayoutDashboard,
  MailWarning,
  History,
  ListTree,
  Package,
  PackagePlus,
  Phone,
  Receipt,
  ShieldCheck,
  Tags,
  Users,
  Video,
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
  /** A page only Global has (`lib/edition.ts`): left out on Kubernetes. */
  globalOnly?: boolean;
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
  /** An area only Global has (`lib/edition.ts`): left out on Kubernetes. */
  globalOnly?: boolean;
}

/** The areas, groups and items this build of the console has. */
export function getNavAreas(): NavArea[] {
  const areas = allNavAreas();
  if (GLOBAL) return areas;
  return areas
    .filter((area) => !area.globalOnly)
    .map((area) => ({
      ...area,
      groups: area.groups.map((group) => ({ ...group, items: group.items.filter((item) => !item.globalOnly) })),
    }));
}

function allNavAreas(): NavArea[] {
  const pricing = getTranslations('host').adminPricing;
  const phonePricing = getTranslations('host').adminPhonePricing;
  const meetAiPricing = getTranslations('host').adminMeetAiPricing;
  const planPricing = getTranslations('host').adminPlanPricing;
  const billing = getTranslations('admin').nav;
  const databases = getTranslations('admin').nav;
  const partners = partnersCopy().nav;
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
          { title: 'Support Inbox', href: '/support', icon: Headphones, globalOnly: true },
          { title: 'App Catalog', href: '/apps', icon: Package },
          { title: 'Access requests', href: '/access-requests', icon: ShieldCheck },
          { title: 'Warmup network', href: '/warmup', icon: Flame },
          { title: 'Outbound mail', href: '/outbound-mail', icon: MailWarning },
          { title: 'Workspaces', href: '/workspaces', icon: Building2 },
          { title: databases.databases, href: '/databases', icon: Database, globalOnly: true },
          { title: billing.plans, href: '/plans', icon: CreditCard },
          { title: partners.jumpTo, href: '/partners', icon: Handshake, globalOnly: true },
          { title: billing.activity, href: '/activity', icon: History },
          { title: 'AI Costs', href: '/ai-costs', icon: Coins, globalOnly: true },
          { title: planPricing.navJumpTo, href: '/plan-pricing', icon: Tags, globalOnly: true },
          { title: pricing.navJumpTo, href: '/domain-pricing', icon: Globe, globalOnly: true },
          { title: phonePricing.navJumpTo, href: '/phone-pricing', icon: Phone, globalOnly: true },
          { title: meetAiPricing.navJumpTo, href: '/weldmeet-ai-pricing', icon: Video, globalOnly: true },
        ],
      },
    ],
  },
  {
    key: 'support',
    globalOnly: true,
    name: 'Support',
    icon: Headphones,
    href: '/support',
    groups: [
      {
        group: 'Support',
        items: [{ title: 'Enterprise Inbox', href: '/support', icon: Headphones, globalOnly: true }],
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
    key: 'databases',
    globalOnly: true,
    name: databases.databases,
    icon: Database,
    href: '/databases',
    groups: [
      {
        group: databases.databasesGroup,
        items: [{ title: databases.databasesOverview, href: '/databases', icon: Database, globalOnly: true }],
      },
    ],
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
          { title: billing.newPlan, href: '/plans/new', icon: PackagePlus, globalOnly: true },
        ],
      },
      {
        group: billing.auditGroup,
        items: [{ title: billing.activity, href: '/activity', icon: History }],
      },
    ],
  },
  {
    key: 'partners',
    globalOnly: true,
    name: partners.area,
    icon: Handshake,
    href: '/partners',
    groups: [
      {
        group: partners.group,
        items: [
          { title: partners.list, href: '/partners', icon: ListTree, globalOnly: true },
          { title: partners.new, href: '/partners/new', icon: PackagePlus, globalOnly: true },
        ],
      },
    ],
  },
  {
    key: 'ai-costs',
    globalOnly: true,
    name: 'AI Costs',
    icon: Coins,
    href: '/ai-costs',
    groups: [
      {
        group: 'Spend',
        items: [{ title: 'Gateway Costs', href: '/ai-costs', icon: Receipt, globalOnly: true }],
      },
    ],
  },
  {
    key: 'plan-pricing',
    globalOnly: true,
    name: planPricing.navArea,
    icon: Tags,
    href: '/plan-pricing',
    groups: [
      {
        group: planPricing.navGroup,
        items: [{ title: planPricing.navPage, href: '/plan-pricing', icon: Tags, globalOnly: true }],
      },
    ],
  },
  {
    key: 'domain-pricing',
    globalOnly: true,
    name: pricing.navArea,
    icon: Globe,
    href: '/domain-pricing',
    groups: [
      {
        group: pricing.navGroup,
        items: [{ title: pricing.navCatalog, href: '/domain-pricing', icon: Globe, globalOnly: true }],
      },
    ],
  },
  {
    key: 'phone-pricing',
    globalOnly: true,
    name: phonePricing.navArea,
    icon: Phone,
    href: '/phone-pricing',
    groups: [
      {
        group: phonePricing.navGroup,
        items: [{ title: phonePricing.navCatalog, href: '/phone-pricing', icon: Phone, globalOnly: true }],
      },
    ],
  },
  {
    key: 'weldmeet-ai-pricing',
    globalOnly: true,
    name: meetAiPricing.navArea,
    icon: Video,
    href: '/weldmeet-ai-pricing',
    groups: [
      {
        group: meetAiPricing.navGroup,
        items: [{ title: meetAiPricing.navPage, href: '/weldmeet-ai-pricing', icon: Video, globalOnly: true }],
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
