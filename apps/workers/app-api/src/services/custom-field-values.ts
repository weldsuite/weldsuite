/**
 * app-api binding of the shared custom-field VALUES service
 * (`@weldsuite/db/lib/custom-field-values`).
 *
 * The implementation and all design notes live in the shared module — it is
 * runtime-agnostic and takes an injected `generateId` so app-api,
 * helpdesk-widget-api, helpdesk-workflow-worker and external-api share one copy.
 * This file re-exports the read/hydrate helpers unchanged and binds app-api's
 * `generateId` into the two write helpers so existing call sites keep their
 * current signatures.
 */

import { generateId } from '../lib/id';
import {
  setValues as setValuesShared,
  syncValuesForEntity as syncValuesForEntityShared,
  type CustomFieldMap,
  type CustomFieldDefinitionRow,
} from '@weldsuite/db/lib/custom-field-values';
import type { Database } from '../db';

export {
  getDefinitionsForEntityType,
  getDefinitionsForTicket,
  getValuesForEntities,
  getValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
  deleteValuesForEntity,
  CustomFieldValidationError,
} from '@weldsuite/db/lib/custom-field-values';
export type { CustomFieldMap, CustomFieldDefinitionRow };

/** Upsert a `{ [slug]: value }` map for an entity — app-api's `generateId` bound. */
export function setValues(
  db: Database,
  entityType: string,
  entityId: string,
  values: CustomFieldMap,
  options?: {
    definitions?: CustomFieldDefinitionRow[];
    patch?: boolean;
    enforceRequired?: boolean;
  },
): Promise<void> {
  return setValuesShared(db, entityType, entityId, values, { ...options, generateId });
}

/** Best-effort dual-write mirror (Phase 1) — app-api's `generateId` bound. */
export function syncValuesForEntity(
  db: Database,
  entityType: string,
  entityId: string,
  customFields: CustomFieldMap | null | undefined,
  definitions?: CustomFieldDefinitionRow[],
): Promise<void> {
  return syncValuesForEntityShared(db, entityType, entityId, customFields, generateId, definitions);
}
