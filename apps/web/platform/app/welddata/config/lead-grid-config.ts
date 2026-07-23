/**
 * Shared EntityGrid column config for WeldData lead rows.
 *
 * Both the database search results (`LemlistSearchRow`) and a list's saved
 * leads (`WelddataLead`) expose the same display fields, so they render through
 * the same column set — the same grid component CRM uses for /weldcrm/people.
 * Columns are read-only here (lead data comes from the provider, not inline
 * edits); the list-detail grid appends its enrichment columns on top.
 */
import {
  User,
  Briefcase,
  Mail,
  Building2,
  Globe,
  Factory,
  MapPin,
  Flag,
  Users,
  ExternalLink,
} from 'lucide-react';
import type { EntityGridConfig, GridColumnDef } from '@/components/entity-grid';

/** The display shape both lead sources share. */
export interface LeadRowLike {
  id: string;
  kind: 'person' | 'company';
  name?: string | null;
  title?: string | null;
  email?: string | null;
  companyName?: string | null;
  domain?: string | null;
  industry?: string | null;
  location?: string | null;
  country?: string | null;
  companySize?: string | null;
  linkedinUrl?: string | null;
  avatarUrl?: string | null;
}

interface BuildColumnsOptions {
  /** People-only field — hidden for company rows. */
  includeTitle?: boolean;
  /** Saved leads can carry a revealed email; search rows never do. */
  includeEmail?: boolean;
  /** The "Company" column. Redundant for company rows (name === company), so
   * company grids drop it. Defaults to true. */
  includeCompany?: boolean;
  /** Header for the first (name) column — "Company" reads better for companies. */
  nameLabel?: string;
}

/** Column options for a given list/search kind. Companies drop the person
 * fields (title, email) and the redundant Company column, and label the first
 * column "Company". `includeEmail` is opt-in because the database search never
 * returns emails (only saved/enriched leads can). */
export function leadColumnOptionsForKind(
  kind: 'person' | 'company',
  withEmail = false,
): BuildColumnsOptions {
  return kind === 'company'
    ? { includeTitle: false, includeEmail: false, includeCompany: false, nameLabel: 'Company' }
    : { includeTitle: true, includeEmail: withEmail, includeCompany: true };
}

export function buildLeadColumns<T extends LeadRowLike>(
  opts: BuildColumnsOptions = {},
): GridColumnDef<T>[] {
  const cols: GridColumnDef<T>[] = [
    {
      id: 'name',
      name: opts.nameLabel ?? 'Name',
      type: 'company',
      width: 240,
      icon: User,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.name ?? '—',
    },
  ];

  if (opts.includeTitle) {
    cols.push({
      id: 'title',
      name: 'Job title',
      type: 'text',
      width: 180,
      icon: Briefcase,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.title ?? '',
    });
  }

  if (opts.includeEmail) {
    cols.push({
      id: 'email',
      name: 'Email',
      type: 'email',
      width: 220,
      icon: Mail,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.email ?? '',
    });
  }

  if (opts.includeCompany !== false) {
    cols.push({
      id: 'companyName',
      name: 'Company',
      type: 'text',
      width: 200,
      icon: Building2,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.companyName ?? '',
    });
  }

  cols.push(
    {
      id: 'domain',
      name: 'Domain',
      type: 'url',
      width: 180,
      icon: Globe,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.domain ?? '',
    },
    {
      id: 'industry',
      name: 'Industry',
      type: 'text',
      width: 200,
      icon: Factory,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.industry ?? '',
    },
    {
      id: 'location',
      name: 'Location',
      type: 'text',
      width: 180,
      icon: MapPin,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.location ?? '',
    },
    {
      id: 'country',
      name: 'Country',
      type: 'text',
      width: 140,
      icon: Flag,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.country ?? '',
    },
    {
      id: 'companySize',
      name: 'Company size',
      type: 'text',
      width: 140,
      icon: Users,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.companySize ?? '',
    },
    {
      id: 'linkedinUrl',
      name: 'LinkedIn',
      type: 'url',
      width: 200,
      icon: ExternalLink,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (r) => r.linkedinUrl ?? '',
    },
  );

  return cols;
}

export function buildLeadGridConfig<T extends LeadRowLike>(
  columns: GridColumnDef<T>[],
  opts: { getAvatar?: (row: T) => string | undefined } = {},
): EntityGridConfig<T> {
  return {
    entityName: 'Lead',
    entityNamePlural: 'Leads',
    columns,
    getEntityId: (r) => r.id,
    getEntityName: (r) => r.name ?? '—',
    getEntityInitials: (r) => {
      const parts = (r.name ?? '').split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
      return (r.name ?? '?').charAt(0).toUpperCase();
    },
    getEntityAvatar: opts.getAvatar ?? ((r) => r.avatarUrl ?? undefined),
    // No subtitle under the name — job title/company already have columns.
    allowCustomColumns: false,
    // Show the CRM-style "+ Calculate" footer row (count / sum / avg per column)
    // at the bottom of both the find-leads and list-detail grids.
    enableCalculations: true,
    enableInlineEditing: false,
    enableRowSelection: true,
    enableExport: false,
    enableImport: false,
  };
}
