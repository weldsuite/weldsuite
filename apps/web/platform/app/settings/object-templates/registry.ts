import { Building, User } from 'lucide-react';
import { COMPANY_FIELDS } from '@/app/weldcrm/companies/config/company-field-catalog';
import { PERSON_FIELDS } from '@/app/weldcrm/people/config/person-field-catalog';
import type { TemplateEntityRegistration, TemplateFieldSpec } from './types';

/**
 * Single source of truth for which object types support templates.
 *
 * To add a new templated object:
 *   1. Create a field catalog (`TemplateFieldSpec[]`) inside your module.
 *   2. Append a registration entry here.
 *
 * The settings UI, quick-add dialogs, payload builder, and the template
 * engine all read from this registry — no other files need to change.
 */
export const TEMPLATE_REGISTRATIONS: readonly TemplateEntityRegistration[] = [
  {
    value: 'company',
    label: 'Companies',
    singular: 'company',
    icon: Building,
    fields: COMPANY_FIELDS,
    defaultFields: ['name', 'email', 'website', 'industry'],
  },
  {
    value: 'person',
    label: 'People',
    singular: 'person',
    icon: User,
    fields: PERSON_FIELDS,
    defaultFields: ['firstName', 'lastName', 'email', 'title', 'directPhone'],
  },
] as const;

export function getRegistration(value: string): TemplateEntityRegistration | undefined {
  return TEMPLATE_REGISTRATIONS.find((r) => r.value === value);
}

export function getFieldSpec(entityType: string, slug: string): TemplateFieldSpec | undefined {
  return getRegistration(entityType)?.fields.find((f) => f.slug === slug);
}

export function getRequiredBuiltinSlugs(entityType: string): string[] {
  return (getRegistration(entityType)?.fields ?? [])
    .filter((f) => f.required)
    .map((f) => f.slug);
}

export function getDefaultSlugs(entityType: string): string[] {
  return getRegistration(entityType)?.defaultFields ?? [];
}
