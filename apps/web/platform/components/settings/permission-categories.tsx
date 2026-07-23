import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAppIcon, getAppLucideIcon } from '@/lib/apps/app-registry';

export const STANDARD_ACTIONS = ['read', 'create', 'update', 'delete', 'manage'] as const;
export type StandardAction = (typeof STANDARD_ACTIONS)[number];

export function getActionLabels(t: ReturnType<typeof useTranslations>): Record<StandardAction, string> {
  return {
    read: t('sweep.settings.roleDetail.actions.view'),
    create: t('sweep.settings.roleDetail.actions.create'),
    update: t('sweep.settings.roleDetail.actions.edit'),
    delete: t('sweep.settings.roleDetail.actions.delete'),
    manage: t('sweep.settings.roleDetail.actions.manage'),
  };
}

const CATEGORY_ORDER = [
  'Workspace',
  'CRM',
  'Commerce & Inventory',
  'Accounting',
  'Helpdesk',
  'Parcel',
  'Projects',
  'Mail & Social',
  'Hosting',
  'Integrations',
  'Drive',
  'Calendar',
  'Meet',
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_TO_APP: Record<Category, string | null> = {
  Workspace: 'weldsuite',
  CRM: 'weldcrm',
  'Commerce & Inventory': 'wms',
  Accounting: 'weldbooks',
  Helpdesk: 'welddesk',
  Parcel: 'parcel',
  Projects: 'weldflow',
  'Mail & Social': 'weldmail',
  Hosting: 'weldhost',
  Integrations: 'weldconnect',
  Drive: 'welddrive',
  Calendar: 'weldcalendar',
  Meet: 'weldmeet',
};

// Some app SVGs render visually larger than others; trim those down a touch.
const CATEGORY_ICON_SIZE_OVERRIDE: Partial<Record<Category, string>> = {
  CRM: 'h-3.5 w-3.5',
  Helpdesk: 'h-3.5 w-3.5',
  Drive: 'h-3.5 w-3.5',
};

// Categories whose underlying app isn't shipped yet.
export const COMING_SOON_CATEGORIES: ReadonlySet<Category> = new Set([
  'Commerce & Inventory',
  'Accounting',
  'Parcel',
]);

export function CategoryIcon({
  category,
  className,
}: {
  category: Category;
  className?: string;
}) {
  if (COMING_SOON_CATEGORIES.has(category)) return null;
  const appCode = CATEGORY_TO_APP[category];
  const sizeClass = cn(className, CATEGORY_ICON_SIZE_OVERRIDE[category]);
  if (!appCode) return <Settings className={sizeClass} />;
  const iconSrc = getAppIcon(appCode);
  if (iconSrc) {
    return <img src={iconSrc} alt="" className={cn(sizeClass, 'object-contain')} />;
  }
  const LucideFallback = getAppLucideIcon(appCode);
  return <LucideFallback className={sizeClass} />;
}

export function ComingSoonBadge() {
  const t = useTranslations();
  return (
    <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary">
      {t('sweep.settings.roleDetail.comingSoon')}
    </span>
  );
}

const OBJECT_TO_CATEGORY: Record<string, Category> = {
  // Workspace
  general: 'Workspace',
  team: 'Workspace',
  'working-hours': 'Workspace',
  teams: 'Workspace',
  roles: 'Workspace',
  apikeys: 'Workspace',
  billing: 'Workspace',
  // CRM
  leads: 'CRM',
  contacts: 'CRM',
  opportunities: 'CRM',
  activities: 'CRM',
  pipelines: 'CRM',
  quotes: 'CRM',
  telephony: 'CRM',
  // Commerce & Inventory
  products: 'Commerce & Inventory',
  inventory: 'Commerce & Inventory',
  orders: 'Commerce & Inventory',
  picklists: 'Commerce & Inventory',
  locations: 'Commerce & Inventory',
  warehouses: 'Commerce & Inventory',
  suppliers: 'Commerce & Inventory',
  customers: 'Commerce & Inventory',
  discounts: 'Commerce & Inventory',
  categories: 'Commerce & Inventory',
  websites: 'Commerce & Inventory',
  // Accounting
  entities: 'Accounting',
  invoices: 'Accounting',
  bills: 'Accounting',
  journal: 'Accounting',
  accounts: 'Accounting',
  banking: 'Accounting',
  reports: 'Accounting',
  // Helpdesk
  tickets: 'Helpdesk',
  conversations: 'Helpdesk',
  articles: 'Helpdesk',
  agents: 'Helpdesk',
  departments: 'Helpdesk',
  slas: 'Helpdesk',
  settings: 'Helpdesk',
  // Parcel
  parcels: 'Parcel',
  carriers: 'Parcel',
  boxes: 'Parcel',
  returns: 'Parcel',
  pickups: 'Parcel',
  webhooks: 'Parcel',
  // Projects
  projects: 'Projects',
  tasks: 'Projects',
  milestones: 'Projects',
  time: 'Projects',
  files: 'Projects',
  // Mail & Social
  messages: 'Mail & Social',
  templates: 'Mail & Social',
  campaigns: 'Mail & Social',
  channels: 'Mail & Social',
  posts: 'Mail & Social',
  analytics: 'Mail & Social',
  // Hosting
  domains: 'Hosting',
  dns: 'Hosting',
  email: 'Hosting',
  // Integrations
  integrations: 'Integrations',
  // Drive
  folders: 'Drive',
  // Calendar
  events: 'Calendar',
  calendars: 'Calendar',
  bookings: 'Calendar',
  // Meet
  meetings: 'Meet',
  sessions: 'Meet',
  recordings: 'Meet',
};

export function categoryFor(objectKey: string): Category {
  return OBJECT_TO_CATEGORY[objectKey] ?? 'Workspace';
}

export interface CategoryRow<P> {
  object: string;
  objectName: string;
  category: Category;
  perAction: Partial<Record<StandardAction, P>>;
  extras: P[];
  allPerms: P[];
}

export interface CategoryGroup<P> {
  category: Category;
  rows: CategoryRow<P>[];
}

export function groupByCategory<P>(rows: CategoryRow<P>[]): CategoryGroup<P>[] {
  const buckets = new Map<Category, CategoryRow<P>[]>();
  for (const row of rows) {
    const list = buckets.get(row.category);
    if (list) list.push(row);
    else buckets.set(row.category, [row]);
  }
  return CATEGORY_ORDER
    .filter((c) => buckets.has(c))
    .map((category) => ({ category, rows: buckets.get(category)! }));
}
