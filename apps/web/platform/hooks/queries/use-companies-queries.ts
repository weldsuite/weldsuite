/**
 * Re-export shim — the canonical company query hooks live in the company
 * object panel folder (`components/objects/company/use-company-data.ts`),
 * pointing at app-api directly. This file exists so legacy callers that
 * still import `@/hooks/queries/use-companies-queries` keep working.
 *
 * Migrate imports to `@/components/objects/company/use-company-data` and
 * this shim can be deleted.
 */

export * from '@/components/objects/company/use-company-data';
