import type { TemplateFieldSpec } from '@/app/settings/object-templates/types';

/**
 * Built-in Person fields available to object templates.
 *
 * Slugs must match `createPersonSchema` keys so quick-add can use them
 * directly as form field names. Custom-field slugs are appended at runtime
 * with a `cf:` prefix.
 */
export const PERSON_FIELDS: TemplateFieldSpec[] = [
  { slug: 'firstName', label: 'First Name', group: 'identity', inputType: 'text' },
  { slug: 'lastName', label: 'Last Name', group: 'identity', inputType: 'text' },

  { slug: 'email', label: 'Email', group: 'contact', inputType: 'email' },
  { slug: 'directPhone', label: 'Direct Phone', group: 'contact', inputType: 'phone' },
  { slug: 'mobilePhone', label: 'Mobile Phone', group: 'contact', inputType: 'phone' },

  { slug: 'title', label: 'Job Title', group: 'work', inputType: 'text' },
  { slug: 'department', label: 'Department', group: 'work', inputType: 'text' },
];
