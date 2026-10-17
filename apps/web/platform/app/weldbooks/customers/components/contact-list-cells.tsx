/**
 * Shared by the customer and supplier lists: a contact is a company or a
 * person, shown by the icon in its row avatar, with a Type filter.
 */

import { Building2, User } from 'lucide-react';
import type { ActiveFilter, FilterConfig } from '@/components/entity-list';
import type { ContactKind } from '@/lib/api/domains/weldbooks';

interface ListContact {
  kind?: ContactKind | null;
  email?: string | null;
  contactPerson?: { email: string | null } | null;
}

/** The row avatar's icon; none for a contact from before contacts had a type (it keeps its initial). */
export function contactKindIcon(contact: ListContact) {
  if (contact.kind === 'company') return <Building2 className="size-3" aria-hidden />;
  if (contact.kind === 'person') return <User className="size-3" aria-hidden />;
  return undefined;
}

/** The contact's email; for a company without one, its contact person's. */
export function contactEmail(contact: ListContact): string | null | undefined {
  return contact.email ?? contact.contactPerson?.email;
}

export function contactKindFilter(label: string, kinds: Record<ContactKind, string>): FilterConfig {
  return {
    field: 'kind',
    label,
    options: [
      { value: 'company', label: kinds.company },
      { value: 'person', label: kinds.person },
    ],
  };
}

export function readKindFilter(filters: readonly ActiveFilter[]): ContactKind | undefined {
  const value = filters.find((f) => f.field === 'kind' && f.value)?.value;
  return value === 'company' || value === 'person' ? value : undefined;
}
