import type { TemplateFieldSpec } from '@/app/settings/object-templates/types';

/**
 * Built-in Company fields available to object templates.
 *
 * The slug must match the API key on `createCompanySchema` so the quick-add
 * dialog uses it directly as a form field name. Custom fields are appended
 * at runtime by the template renderer with a `cf:` prefix.
 */
export const COMPANY_FIELDS: TemplateFieldSpec[] = [
  { slug: 'name', label: 'Name', group: 'identity', inputType: 'text', required: true },
  { slug: 'tradingName', label: 'Trading Name', group: 'identity', inputType: 'text' },
  { slug: 'registrationNumber', label: 'Registration Number', group: 'identity', inputType: 'text' },
  { slug: 'vatNumber', label: 'VAT Number', group: 'identity', inputType: 'text' },

  { slug: 'email', label: 'Email', group: 'contact', inputType: 'email' },
  { slug: 'phone', label: 'Phone', group: 'contact', inputType: 'phone' },
  { slug: 'mobile', label: 'Mobile', group: 'contact', inputType: 'phone' },
  { slug: 'website', label: 'Website', group: 'contact', inputType: 'url' },

  { slug: 'industry', label: 'Industry', group: 'profile', inputType: 'text' },
  { slug: 'employeeCount', label: 'Employees', group: 'profile', inputType: 'text' },
];
