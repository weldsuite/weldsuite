/**
 * WeldBooks US sales tax (books-api's sales tax settings, agencies,
 * jurisdictions, rules, zones, exemption certificates and the tax calendar)
 * response schemas, by route. Spread into BOOKS_ROUTES by
 * conformance-schemas-books.ts.
 */
import {
  exemptionCertificateSchema,
  salesTaxAddressValidationSchema,
  salesTaxAgencyClosedSchema,
  salesTaxAgencySchema,
  salesTaxCalculationSchema,
  salesTaxJurisdictionSchema,
  salesTaxRateSchema,
  salesTaxRegistrationCheckSchema,
  salesTaxRuleSchema,
  salesTaxSettingsSchema,
  salesTaxZoneSchema,
  taxCalendarCompletionSchema,
  taxCalendarSchema,
} from '@weldsuite/app-api-client/schemas/books-sales-tax-responses';
import type { RouteSchema } from './conformance-schemas';

/** The writes of one object: create, replace, change. */
function crud(base: string, data: RouteSchema['data']): RouteSchema[] {
  return [
    { method: 'GET', route: base, envelope: 'list', data },
    { method: 'GET', route: `${base}/:id`, envelope: 'single', data },
    { method: 'POST', route: base, envelope: 'single', data },
    { method: 'PUT', route: `${base}/:id`, envelope: 'single', data },
    { method: 'PATCH', route: `${base}/:id`, envelope: 'single', data },
  ];
}

export const BOOKS_SALES_TAX_ROUTES: RouteSchema[] = [
  // settings, preview, provider checks
  { method: 'GET', route: '/api/sales-tax/settings', envelope: 'single', data: salesTaxSettingsSchema },
  { method: 'PUT', route: '/api/sales-tax/settings', envelope: 'single', data: salesTaxSettingsSchema },
  { method: 'POST', route: '/api/sales-tax/registration-check', envelope: 'single', data: salesTaxRegistrationCheckSchema },
  { method: 'POST', route: '/api/sales-tax/calculate', envelope: 'single', data: salesTaxCalculationSchema },
  { method: 'POST', route: '/api/sales-tax/validate-address', envelope: 'single', data: salesTaxAddressValidationSchema },
  // setup objects
  ...crud('/api/sales-tax-agencies', salesTaxAgencySchema),
  { method: 'DELETE', route: '/api/sales-tax-agencies/:id', envelope: 'single', data: salesTaxAgencyClosedSchema },
  ...crud('/api/sales-tax-jurisdictions', salesTaxJurisdictionSchema),
  { method: 'GET', route: '/api/sales-tax-jurisdictions/:id/rates', envelope: 'list', data: salesTaxRateSchema },
  { method: 'POST', route: '/api/sales-tax-jurisdictions/:id/rates', envelope: 'single', data: salesTaxRateSchema },
  { method: 'PATCH', route: '/api/sales-tax-jurisdictions/:id/rates/:rateId', envelope: 'single', data: salesTaxRateSchema },
  ...crud('/api/sales-tax-rules', salesTaxRuleSchema),
  ...crud('/api/sales-tax-zones', salesTaxZoneSchema),
  ...crud('/api/exemption-certificates', exemptionCertificateSchema),
  // tax calendar
  { method: 'GET', route: '/api/tax-calendar', envelope: 'single', data: taxCalendarSchema },
  { method: 'POST', route: '/api/tax-calendar/complete', envelope: 'single', data: taxCalendarCompletionSchema },
];
