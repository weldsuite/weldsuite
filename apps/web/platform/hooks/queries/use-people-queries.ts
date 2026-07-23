/**
 * Re-export shim — the canonical person query hooks live in the person
 * object panel folder (`components/objects/person/use-person-data.ts`),
 * pointing at app-api directly. This file exists so legacy callers that
 * still import `@/hooks/queries/use-people-queries` keep working.
 *
 * Migrate imports to `@/components/objects/person/use-person-data` and
 * this shim can be deleted.
 */

export * from '@/components/objects/person/use-person-data';
