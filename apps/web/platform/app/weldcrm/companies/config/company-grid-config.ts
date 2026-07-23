/**
 * Grid column config for the Companies page.
 *
 * Key difference from the legacy customer config: the name column reads
 * `displayName` UNCONDITIONALLY. No branching on type, no fallback chain that
 * empties when fields are out of sync. This is the whole point of the
 * Companies/People refactor — the bug where flipping b2b → b2c emptied the
 * name column is impossible to reintroduce.
 */

import {
  Building,
  Mail,
  Phone,
  CircleCheck,
  MapPin,
  DollarSign,
  Calendar,
  ExternalLink,
  Tag,
  Star,
  Factory,
  Users,
  Target,
  Clock,
  Briefcase,
  Hash,
  FileText,
  Globe,
} from 'lucide-react';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import {
  EntityGridConfig,
  GridColumnDef,
  StatusStyle,
} from '@/components/entity-grid';

export const companyStatusConfig: Record<string, StatusStyle> = {
  active: { label: 'Active', color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  prospect: { label: 'Prospect', color: 'text-violet-700 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-950' },
  inactive: { label: 'Inactive', color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  churned: { label: 'Churned', color: 'text-red-700 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
  suspended: { label: 'Suspended', color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
};

function extractDomain(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0] || undefined;
  }
}

function getCompanyAvatar(company: Company): string | undefined {
  if (company.avatarUrl) return company.avatarUrl;
  const domain = extractDomain(company.website) || extractDomain(company.email?.split('@')[1] ?? undefined);
  if (domain) return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  return undefined;
}

function getCompanyLocation(company: Company): { city: string; state: string; country: string } | null {
  const addr = (company.primaryAddress ?? null) as { city?: string; state?: string; country?: string } | null;
  if (!addr) return null;
  return { city: addr.city ?? '', state: addr.state ?? '', country: addr.country ?? '' };
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
    setValue: (_c, v) => ({ email: (v as string) || undefined }),
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
    setValue: (_c, v) => ({ phone: (v as string) || undefined }),
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
    setValue: (_c, v) => ({ industry: (v as string) || undefined }),
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
  {
    id: 'location',
    name: 'Primary Address',
    type: 'location',
    width: 180,
    icon: MapPin,
    visible: true,
    editable: false,
    sortable: false,
    getValue: (c) => getCompanyLocation(c),
  },
  {
    id: 'website',
    name: 'Website',
    type: 'url',
    width: 200,
    icon: ExternalLink,
    visible: true,
    editable: true,
    sortable: true,
    getValue: (c) => c.website ?? '',
    setValue: (_c, v) => ({ website: (v as string) || undefined }),
  },
  {
    id: 'isSupplier',
    name: 'Supplier',
    type: 'checkbox',
    width: 110,
    icon: Star,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.isSupplier,
    setValue: (_c, v) => ({ isSupplier: !!v }),
  },
  {
    id: 'isLead',
    name: 'Lead',
    type: 'checkbox',
    width: 90,
    icon: Star,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.isLead,
    setValue: (_c, v) => ({ isLead: !!v }),
  },
  // Hidden by default — surfaced via "Add column".
  {
    id: 'vatNumber',
    name: 'VAT Number',
    type: 'text',
    width: 150,
    icon: FileText,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.vatNumber ?? '',
    setValue: (_c, v) => ({ vatNumber: (v as string) || undefined }),
  },
  {
    id: 'registrationNumber',
    name: 'Registration No.',
    type: 'text',
    width: 160,
    icon: FileText,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.registrationNumber ?? '',
    setValue: (_c, v) => ({ registrationNumber: (v as string) || undefined }),
  },
  {
    id: 'employeeCount',
    name: 'Employees',
    type: 'text',
    width: 130,
    icon: Users,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.employeeCount ?? '',
    setValue: (_c, v) => ({ employeeCount: (v as string) || undefined }),
  },
  {
    id: 'lifecycleStage',
    name: 'Lifecycle Stage',
    type: 'text',
    width: 160,
    icon: Target,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.lifecycleStage ?? '',
    setValue: (_c, v) => ({ lifecycleStage: (v as string) || undefined }),
  },
  {
    id: 'segment',
    name: 'Segment',
    type: 'text',
    width: 140,
    icon: Target,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.segment ?? '',
    setValue: (_c, v) => ({ segment: (v as string) || undefined }),
  },
  {
    id: 'source',
    name: 'Source',
    type: 'text',
    width: 150,
    icon: Target,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.source ?? '',
    setValue: (_c, v) => ({ source: (v as string) || undefined }),
  },
  {
    id: 'leadScore',
    name: 'Lead Score',
    type: 'number',
    width: 120,
    icon: Hash,
    visible: false,
    editable: false,
    sortable: true,
    getValue: (c) => c.leadScore ?? null,
  },
  {
    id: 'preferredLanguage',
    name: 'Language',
    type: 'text',
    width: 130,
    icon: Globe,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.preferredLanguage ?? '',
    setValue: (_c, v) => ({ preferredLanguage: (v as string) || undefined }),
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    width: 200,
    icon: Tag,
    visible: false,
    editable: true,
    sortable: false,
    getValue: (c) => c.tags ?? [],
    setValue: (_c, v) => ({ tags: (v as string[]) ?? [] }),
  },
  {
    id: 'ownerId',
    name: 'Owner',
    type: 'text',
    width: 160,
    icon: Briefcase,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.ownerId ?? '',
    setValue: (_c, v) => ({ ownerId: (v as string) || undefined }),
  },
  {
    id: 'lastContactDate',
    name: 'Last Contact',
    type: 'date',
    width: 140,
    icon: Calendar,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.lastContactDate ?? null,
    setValue: (_c, v) => ({ lastContactDate: v as string }),
  },
  {
    id: 'nextFollowUpDate',
    name: 'Next Follow-up',
    type: 'date',
    width: 150,
    icon: Clock,
    visible: false,
    editable: true,
    sortable: true,
    getValue: (c) => c.nextFollowUpDate ?? null,
    setValue: (_c, v) => ({ nextFollowUpDate: v as string }),
  },
  {
    id: 'createdAt',
    name: 'Created At',
    type: 'date',
    width: 150,
    icon: Calendar,
    visible: false,
    editable: false,
    sortable: true,
    getValue: (c) => c.createdAt,
  },
  {
    id: 'currency',
    name: 'Currency',
    type: 'text',
    width: 100,
    icon: DollarSign,
    visible: false,
    editable: false,
    sortable: true,
    getValue: (_c) => null,
  },
];

export const companyGridConfig: EntityGridConfig<Company> = {
  entityName: 'Company',
  entityNamePlural: 'Companies',
  columns: companyColumns,
  getEntityId: (c) => c.id,
  // No branching — every Company has a displayName.
  getEntityName: (c) => c.displayName,
  getEntityInitials: (c) => c.displayName.charAt(0).toUpperCase(),
  getEntityAvatar: (c) => getCompanyAvatar(c),
  getEntitySubtitle: (c) => c.industry ?? undefined,
  statusField: 'status',
  statusConfig: companyStatusConfig,
  allowCustomColumns: true,
  enableCalculations: true,
  enableInlineEditing: true,
  enableRowSelection: true,
  enableExport: true,
  enableImport: false,
};
