/**
 * Grid column config for the Companies page.
 *
 * Besides the default columns (Company, Email, Phone, Industry, Status,
 * Primary location, Domains), the Add-column menu offers Attio's company
 * attributes, with Attio's names, icons and order. Some are stored on the
 * company; the rest (Team, interactions, connection strength, next due task,
 * deals) are computed by the API (`include=attributes`) and read-only.
 *
 * Key difference from the legacy customer config: the name column reads
 * `displayName` UNCONDITIONALLY. No branching on type, no fallback chain that
 * empties when fields are out of sync. This is the whole point of the
 * Companies/People refactor — the bug where flipping b2b → b2c emptied the
 * name column is impossible to reintroduce.
 */

import {
  Building,
  Building2,
  Mail,
  Phone,
  CircleCheck,
  MapPin,
  Calendar,
  CalendarDays,
  Tag,
  Factory,
  Users,
  UsersRound,
  Briefcase,
  Hash,
  Globe,
  IdCard,
  LetterText,
  Facebook,
  Instagram,
  Linkedin,
  CircleDollarSign,
  BadgeDollarSign,
  UserRoundCheck,
  HeartHandshake,
  UserRoundPlus,
  SquareCheck,
  Handshake,
  UserRound,
  createLucideIcon,
} from 'lucide-react';
import type {
  Company,
  CompanyAttributes,
  CompanyInteraction,
  ConnectionStrength,
  Money,
} from '@weldsuite/app-api-client/schemas/companies';
import {
  EntityGridConfig,
  GridColumnDef,
  StatusStyle,
} from '@/components/entity-grid';
import { LIFECYCLE_STAGES } from '@weldsuite/app-api-client/schemas/companies';

export const companyStatusConfig: Record<string, StatusStyle> = {
  active: { label: 'Active', color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  prospect: { label: 'Prospect', color: 'text-violet-700 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-950' },
  inactive: { label: 'Inactive', color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  churned: { label: 'Churned', color: 'text-red-700 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  suspended: { label: 'Suspended', color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
};

const LIFECYCLE_STAGE_STYLE = { color: 'text-foreground', bg: 'bg-muted' };

/** Lifecycle stage select, limited to the values the API accepts. */
export const lifecycleStageSelectConfig: Record<string, StatusStyle> = Object.fromEntries(
  LIFECYCLE_STAGES.map((stage) => [
    stage,
    {
      ...LIFECYCLE_STAGE_STYLE,
      label: stage.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()),
    },
  ]),
);

/**
 * The company's logo: its own image, else the logo our API found on its website
 * (`logoUrl`, merged into the rows by `useRowsWithCompanyLogos` in the grid).
 * Never a third-party URL built from the company's domain.
 */
export function getCompanyAvatar(company: Pick<Company, 'avatarUrl'> & { logoUrl?: string | null }): string | undefined {
  return company.avatarUrl || company.logoUrl || undefined;
}

type LocationParts = { city?: string; state?: string; country?: string };

function getCompanyLocation(company: Company): { city: string; state: string; country: string } | null {
  const addr = (company.primaryAddress ?? null) as (LocationParts & { province?: string }) | null;
  if (!addr) return null;
  return { city: addr.city ?? '', state: addr.state ?? addr.province ?? '', country: addr.country ?? '' };
}

/**
 * The grid edits only city / state / country. PATCH replaces the whole
 * `primaryAddress`, so merge into the stored address to keep the street,
 * house number and postal code the record panel's address editor wrote.
 */
function setCompanyLocation(company: Company, value: unknown): Partial<Company> {
  const next = (value ?? {}) as LocationParts;
  const { province: _province, ...current } = (company.primaryAddress ?? {}) as Record<string, unknown>;
  return {
    primaryAddress: {
      ...current,
      city: next.city || undefined,
      state: next.state || undefined,
      country: next.country || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Icons lucide doesn't ship: AngelList's victory hand and the X logo.
// ---------------------------------------------------------------------------

const AngelListIcon = createLucideIcon('angellist', [
  ['path', { d: 'M10 12 7.6 3.9a1.5 1.5 0 0 1 2.9-.8L13 11', key: 'index' }],
  ['path', { d: 'm13 11 1.9-7.3a1.5 1.5 0 0 1 2.9.8L15.6 12', key: 'middle' }],
  [
    'path',
    {
      d: 'M9.6 12.6c-1.5-.9-3.6-.3-3.6 1.7 0 1 .5 1.8 1.2 2.4l2.8 2.4c1 .9 2.2 1.4 3.6 1.4H15a4 4 0 0 0 4-4v-3a2 2 0 0 0-3.5-1.3',
      key: 'palm',
    },
  ],
]);

const XLogoIcon = createLucideIcon('x-logo', [
  [
    'path',
    {
      d: 'M17.8 3h2.9l-6.4 7.3L21.8 21h-5.9l-4.6-6-5.3 6H3.1l6.8-7.8L2.7 3h6l4.2 5.5ZM16.8 19.1h1.6L7.8 4.7H6.1Z',
      fill: 'currentColor',
      stroke: 'none',
      key: 'x',
    },
  ],
]);

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** New money values are in euros, the same default deals use. */
const DEFAULT_CURRENCY = 'EUR';

function setMoney(field: 'annualRevenue' | 'fundingRaised') {
  return (company: Company, value: unknown): Partial<Company> => {
    const amount = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(amount) || amount <= 0) return { [field]: null };
    const money: Money = { amount, currency: company[field]?.currency ?? DEFAULT_CURRENCY };
    return { [field]: money };
  };
}

/** `https://acme.com/` → `acme.com`, the way Attio lists a company's domains. */
function toDomain(website: string | null | undefined): string {
  return (website ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * A City / State / Country cell. Typed text sets that part; a Mapbox pick
 * sets every part it knows (picking a city also fills its state and country).
 */
function setLocationPart(part: keyof LocationParts) {
  return (company: Company, value: unknown) => {
    const current = getCompanyLocation(company) ?? { city: '', state: '', country: '' };
    const picked: LocationParts =
      typeof value === 'string' ? { [part]: value } : ((value ?? {}) as LocationParts);
    const next = { ...current };
    for (const key of ['city', 'state', 'country'] as const) {
      if (picked[key] !== undefined && (key === part || picked[key])) next[key] = picked[key] ?? '';
    }
    return setCompanyLocation(company, next);
  };
}

const humanize = (value: string) => value.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());

const attrs = (c: Company): CompanyAttributes | undefined => c.attributes;

const NEUTRAL_CHIP = { color: 'text-foreground', bg: 'bg-muted' };

const interactionTypeConfig: Record<string, StatusStyle> = Object.fromEntries(
  (['call', 'email', 'meeting', 'sms', 'linkedin', 'demo', 'presentation'] as const).map((type) => [
    type,
    { ...NEUTRAL_CHIP, label: { sms: 'SMS', linkedin: 'LinkedIn' }[type as string] ?? humanize(type) },
  ]),
);

export const connectionStrengthConfig: Record<ConnectionStrength, StatusStyle> = {
  very_strong: { label: 'Very strong', color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  strong: { label: 'Strong', color: 'text-green-700 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-950' },
  good: { label: 'Good', color: 'text-blue-700 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  weak: { label: 'Weak', color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
  very_weak: { label: 'Very weak', color: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
  none: { label: 'No communication', color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
};

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency ?? DEFAULT_CURRENCY,
      notation: 'compact',
    }).format(amount);
  } catch {
    return amount.toLocaleString();
  }
}

/** First / Last / Next interaction: the date, plus its type and team member as sub-attributes. */
function interactionColumns(
  id: 'firstInteraction' | 'lastInteraction' | 'nextInteraction',
  name: string,
): GridColumnDef<Company>[] {
  const pick = (c: Company): CompanyInteraction | null => attrs(c)?.[id] ?? null;
  return [
    { id, name, type: 'date', width: 160, icon: UserRoundCheck, visible: false, editable: false, sortable: false, getValue: (c) => pick(c)?.at ?? null },
    {
      id: `${id}.type`,
      name: `${name} type`,
      menuParentId: id,
      type: 'single-select',
      width: 170,
      icon: UserRoundCheck,
      visible: false,
      editable: false,
      sortable: false,
      selectConfig: interactionTypeConfig,
      getValue: (c) => pick(c)?.type ?? null,
    },
    {
      id: `${id}.by`,
      name: `${name} by`,
      menuParentId: id,
      type: 'member',
      width: 180,
      icon: UserRound,
      visible: false,
      editable: false,
      sortable: false,
      getValue: (c) => pick(c)?.userId ?? null,
    },
  ];
}

export const companyColumns: GridColumnDef<Company>[] = [
  {
    id: 'name',
    name: 'Company',
    type: 'company',
    width: 280,
    icon: Building,
    visible: true,
    editable: false,
    sortable: true,
    favoriteField: 'isFavorite',
    // Read displayName directly — never branch on type/kind.
    getValue: (c) => c.displayName,
  },
  {
    id: 'email',
    name: 'Email',
    type: 'email',
    width: 220,
    icon: Mail,
    visible: true,
    editable: true,
    sortable: true,
    getValue: (c) => c.email ?? '',
    setValue: (_c, v) => ({ email: (v as string) ?? '' }),
  },
  {
    id: 'phone',
    name: 'Phone',
    type: 'phone',
    width: 150,
    icon: Phone,
    visible: true,
    editable: true,
    sortable: true,
    getValue: (c) => c.phone ?? '',
    setValue: (_c, v) => ({ phone: (v as string) ?? '' }),
  },
  {
    id: 'industry',
    name: 'Industry',
    type: 'text',
    width: 160,
    icon: Factory,
    visible: true,
    editable: true,
    sortable: true,
    getValue: (c) => c.industry ?? '',
    setValue: (_c, v) => ({ industry: (v as string) ?? '' }),
  },
  {
    id: 'status',
    name: 'Status',
    type: 'single-select',
    width: 130,
    icon: CircleCheck,
    visible: true,
    editable: true,
    sortable: true,
    options: ['active', 'prospect', 'inactive', 'churned', 'suspended'],
    selectConfig: companyStatusConfig,
    getValue: (c) => c.status,
    setValue: (_c, v) => ({ status: v as string }),
  },

  // ── Attio's company attributes, in Attio's order ──────────────────────────
  {
    id: 'recordId',
    name: 'Record ID',
    type: 'text',
    width: 220,
    icon: Hash,
    visible: false,
    editable: false,
    sortable: true,
    getValue: (c) => c.id,
  },
  {
    // Column id stays `website` so saved views keep it.
    id: 'website',
    name: 'Domains',
    type: 'url',
    width: 200,
    icon: Globe,
    visible: true,
    editable: true,
    sortable: true,
    getValue: (c) => toDomain(c.website),
    // The API turns a bare domain into https://…
    setValue: (_c, v) => ({ website: (v as string) ?? '' }),
  },
  {
    id: 'companyName',
    name: 'Name',
    type: 'text',
    width: 200,
    icon: IdCard,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.name,
    // A company always has a name; an emptied cell keeps the old one.
    setValue: (c, v) => ({ name: (v as string)?.trim() || c.name }),
  },
  {
    id: 'description',
    name: 'Description',
    type: 'text',
    width: 260,
    icon: LetterText,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.description ?? '',
    setValue: (_c, v) => ({ description: (v as string) ?? '' }),
  },
  {
    id: 'team',
    name: 'Team',
    type: 'multi-select',
    width: 220,
    icon: Users,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => attrs(c)?.team.map((p) => p.name) ?? [],
  },
  {
    id: 'team.email',
    name: 'Team email addresses',
    menuParentId: 'team',
    type: 'text',
    width: 240,
    icon: Mail,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => (attrs(c)?.team ?? []).flatMap((p) => (p.email ? [p.email] : [])).join(', '),
  },
  {
    id: 'team.phone',
    name: 'Team phone numbers',
    menuParentId: 'team',
    type: 'text',
    width: 200,
    icon: Phone,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => (attrs(c)?.team ?? []).flatMap((p) => (p.phone ? [p.phone] : [])).join(', '),
  },
  {
    id: 'team.jobTitle',
    name: 'Team job titles',
    menuParentId: 'team',
    type: 'text',
    width: 200,
    icon: Briefcase,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => (attrs(c)?.team ?? []).flatMap((p) => (p.jobTitle ? [p.jobTitle] : [])).join(', '),
  },
  {
    // Column id stays `tags` so saved views keep it.
    id: 'tags',
    name: 'Categories',
    type: 'multi-select',
    width: 200,
    icon: Tag,
    visible: false,
    editable: true,
    sortable: false,
    // Free-form: suggestions are the categories other companies already use
    // (injected by CompaniesGrid), and a typed value can be created inline.
    allowCreateOption: true,
    getValue: (c) => c.tags ?? [],
    setValue: (_c, v) => ({ tags: (v as string[]) ?? [] }),
  },
  {
    // Column id stays `location` so saved views keep it.
    id: 'location',
    name: 'Primary location',
    type: 'location',
    width: 180,
    icon: MapPin,
    visible: true,
    editable: true,
    sortable: false,
    getValue: (c) => getCompanyLocation(c),
    setValue: setCompanyLocation,
  },
  ...(['city', 'state', 'country'] as const).map(
    (part): GridColumnDef<Company> => ({
      id: `location.${part}`,
      name: { city: 'City', state: 'State', country: 'Country' }[part],
      menuParentId: 'location',
      // Searches Mapbox for that kind of place.
      type: 'location',
      locationPart: part,
      width: 150,
      icon: MapPin,
      visible: false,
      editable: true,
      sortable: true,
      getValue: (c) => getCompanyLocation(c)?.[part] ?? '',
      setValue: setLocationPart(part),
    }),
  ),
  {
    id: 'angellistUrl',
    name: 'AngelList',
    type: 'url',
    width: 200,
    icon: AngelListIcon,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.angellistUrl ?? '',
    setValue: (_c, v) => ({ angellistUrl: (v as string) ?? '' }),
  },
  {
    id: 'facebookUrl',
    name: 'Facebook',
    type: 'url',
    width: 200,
    icon: Facebook,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.facebookUrl ?? '',
    setValue: (_c, v) => ({ facebookUrl: (v as string) ?? '' }),
  },
  {
    id: 'instagramUrl',
    name: 'Instagram',
    type: 'url',
    width: 200,
    icon: Instagram,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.instagramUrl ?? '',
    setValue: (_c, v) => ({ instagramUrl: (v as string) ?? '' }),
  },
  {
    id: 'linkedinUrl',
    name: 'LinkedIn',
    type: 'url',
    width: 200,
    icon: Linkedin,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.linkedinUrl ?? '',
    setValue: (_c, v) => ({ linkedinUrl: (v as string) ?? '' }),
  },
  {
    id: 'twitterHandle',
    name: 'Twitter',
    type: 'text',
    width: 160,
    icon: XLogoIcon,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.twitterHandle ?? '',
    setValue: (_c, v) => ({ twitterHandle: (v as string) ?? '' }),
  },
  {
    id: 'twitterFollowerCount',
    name: 'Twitter follower count',
    type: 'number',
    width: 190,
    icon: Hash,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.twitterFollowerCount ?? null,
    setValue: (_c, v) => ({ twitterFollowerCount: typeof v === 'number' && v > 0 ? Math.round(v) : null }),
  },
  {
    id: 'annualRevenue',
    name: 'Estimated ARR',
    type: 'currency',
    width: 160,
    icon: CircleDollarSign,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.annualRevenue?.amount ?? null,
    getCurrency: (c) => c.annualRevenue?.currency ?? DEFAULT_CURRENCY,
    setValue: setMoney('annualRevenue'),
  },
  {
    id: 'fundingRaised',
    name: 'Funding raised',
    type: 'currency',
    width: 160,
    icon: BadgeDollarSign,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.fundingRaised?.amount ?? null,
    getCurrency: (c) => c.fundingRaised?.currency ?? DEFAULT_CURRENCY,
    setValue: setMoney('fundingRaised'),
  },
  {
    id: 'foundationDate',
    name: 'Foundation date',
    type: 'date',
    width: 160,
    icon: CalendarDays,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.foundationDate ?? null,
    setValue: (_c, v) => ({ foundationDate: (v as string | null) ?? null }),
  },
  {
    // Column id stays `employeeCount` so saved views keep it.
    id: 'employeeCount',
    name: 'Employee range',
    type: 'text',
    width: 150,
    icon: UsersRound,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.employeeCount ?? '',
    setValue: (_c, v) => ({ employeeCount: (v as string) ?? '' }),
    // Stays free text so a "11-50" range can still be entered/displayed, but
    // a plain numeric value (the common case) can be summed/averaged in the
    // Calculate footer — a range parses to null and is treated as empty.
    calcFieldType: 'number',
    getCalcValue: (c) => {
      if (!c.employeeCount || !/^\d+$/.test(c.employeeCount)) return null;
      return Number.parseInt(c.employeeCount, 10);
    },
  },
  ...interactionColumns('firstInteraction', 'First interaction'),
  ...interactionColumns('lastInteraction', 'Last interaction'),
  ...interactionColumns('nextInteraction', 'Next interaction'),
  {
    id: 'connectionStrength',
    name: 'Connection strength',
    type: 'single-select',
    width: 170,
    icon: HeartHandshake,
    visible: false,
    editable: false,
    sortable: false,
    selectConfig: connectionStrengthConfig,
    getValue: (c) => attrs(c)?.connectionStrength ?? null,
  },
  {
    id: 'strongestConnection',
    name: 'Strongest connection',
    type: 'member',
    width: 180,
    icon: UserRoundPlus,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => attrs(c)?.strongestConnectionUserId ?? null,
  },
  {
    id: 'nextDueTask',
    name: 'Next due task',
    type: 'text',
    width: 200,
    icon: SquareCheck,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => attrs(c)?.nextDueTask?.title ?? '',
  },
  {
    id: 'nextDueTask.dueDate',
    name: 'Next due task date',
    menuParentId: 'nextDueTask',
    type: 'date',
    width: 170,
    icon: CalendarDays,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => attrs(c)?.nextDueTask?.dueDate ?? null,
  },
  {
    id: 'deals',
    name: 'Associated deals',
    type: 'multi-select',
    width: 220,
    icon: Handshake,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => attrs(c)?.deals.map((d) => d.name) ?? [],
  },
  {
    id: 'deals.stage',
    name: 'Deal stages',
    menuParentId: 'deals',
    type: 'multi-select',
    width: 200,
    icon: Handshake,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => [...new Set((attrs(c)?.deals ?? []).flatMap((d) => (d.stage ? [humanize(d.stage)] : [])))],
  },
  {
    id: 'deals.status',
    name: 'Deal statuses',
    menuParentId: 'deals',
    type: 'multi-select',
    width: 180,
    icon: Handshake,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => [...new Set((attrs(c)?.deals ?? []).flatMap((d) => (d.status ? [humanize(d.status)] : [])))],
  },
  {
    id: 'deals.value',
    name: 'Deal values',
    menuParentId: 'deals',
    type: 'text',
    width: 200,
    icon: CircleDollarSign,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) =>
      (attrs(c)?.deals ?? [])
        .flatMap((d) => (d.amount === null ? [] : [formatMoney(d.amount, d.currency)]))
        .join(', '),
  },
  {
    id: 'deals.closeDate',
    name: 'Deal close dates',
    menuParentId: 'deals',
    type: 'text',
    width: 200,
    icon: CalendarDays,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) =>
      (attrs(c)?.deals ?? [])
        .flatMap((d) => (d.closeDate ? [new Date(d.closeDate).toLocaleDateString()] : []))
        .join(', '),
  },
  {
    // Attio's "workspaces" object has no WeldSuite counterpart yet, so this
    // stays empty until one exists. Listed so the menu matches Attio's.
    id: 'workspaces',
    name: 'Associated workspaces',
    type: 'multi-select',
    width: 200,
    icon: Building2,
    visible: false,
    editable: false,
    sortable: false,
    getValue: () => [],
  },
  {
    id: 'createdAt',
    name: 'Created at',
    type: 'date',
    width: 150,
    icon: Calendar,
    visible: false,
    editable: false,
    sortable: true,
    getValue: (c) => c.createdAt,
  },
  {
    id: 'createdBy',
    name: 'Created by',
    type: 'member',
    width: 180,
    icon: UserRound,
    visible: false,
    editable: false,
    sortable: false,
    getValue: (c) => c.createdBy ?? null,
  },
];

/**
 * Columns computed from related records (only on list rows fetched with
 * `include=attributes`). The export endpoint doesn't compute them, so they
 * are left out of CSV/Excel exports rather than exported empty.
 */
export const COMPUTED_COMPANY_COLUMN_IDS = new Set([
  'team',
  'team.email',
  'team.phone',
  'team.jobTitle',
  'firstInteraction',
  'firstInteraction.type',
  'firstInteraction.by',
  'lastInteraction',
  'lastInteraction.type',
  'lastInteraction.by',
  'nextInteraction',
  'nextInteraction.type',
  'nextInteraction.by',
  'connectionStrength',
  'strongestConnection',
  'nextDueTask',
  'nextDueTask.dueDate',
  'deals',
  'deals.stage',
  'deals.status',
  'deals.value',
  'deals.closeDate',
  'workspaces',
]);

export const companyGridConfig: EntityGridConfig<Company> = {
  entityName: 'Company',
  entityNamePlural: 'Companies',
  columns: companyColumns,
  getEntityId: (c) => c.id,
  // No branching — every Company has a displayName.
  getEntityName: (c) => c.displayName,
  getEntityInitials: (c) => c.displayName.charAt(0).toUpperCase(),
  getEntityAvatar: (c) => getCompanyAvatar(c),
  statusField: 'status',
  statusConfig: companyStatusConfig,
  allowCustomColumns: true,
  enableCalculations: true,
  enableInlineEditing: true,
  enableRowSelection: true,
  enableExport: true,
  enableImport: false,
};
