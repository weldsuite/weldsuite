/**
 * Settings Domain Types
 *
 * Custom-field type definitions shared by the settings and custom-field surfaces.
 *
 * This module previously also exposed a settings client bound to the obsolete
 * api-worker transport. That client was dead code: it was never exported, and every
 * consumer of this module imports types only. The live settings surfaces are served
 * by app-api — see `hooks/use-custom-fields.ts`
 * (`GET /api/custom-fields`), `lib/api/clients/settings.ts` and the roles/api-keys/
 * team-member routes under `apps/workers/app-api/src/routes/`. The dead client was removed
 * as part of the api-worker phase-out; no call sites changed.
 */

export interface CustomFieldDefinition {
  id: string;
  entityType: string;
  name: string;
  slug: string;
  description?: string | null;
  fieldType: string;
  options?: { label: string; value: string; color?: string }[] | null;
  config?: Record<string, unknown> | null;
  required?: boolean;
  sortOrder?: number;
  group?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateCustomFieldData {
  name?: string;
  description?: string;
  fieldType?: string;
  options?: { label: string; value: string; color?: string }[];
  config?: Record<string, unknown>;
  required?: boolean;
  sortOrder?: number;
  group?: string;
}
