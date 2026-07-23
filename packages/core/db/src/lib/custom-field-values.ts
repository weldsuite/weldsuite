/**
 * Custom field VALUES service — typed, one-cell-per-value storage backing the
 * `custom_field_values` table. Replaces the per-entity `custom_fields` JSONB
 * blob so list surfaces can sort/filter/aggregate on custom fields in SQL.
 *
 * Pure functions, no Hono context. All reads/writes are keyed by the immutable
 * definition id (`fieldId`) but exposed to callers as a `{ [slug]: value }`
 * map — the shape the entity APIs and UI already speak.
 *
 * Runtime-agnostic (loose `AnyDb`, injected `generateId`) so app-api,
 * helpdesk-widget-api, helpdesk-workflow-worker and external-api all share one
 * copy — the `mail-contacts.ts` / `person-resolver.ts` pattern.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  fieldTypeToValueColumn,
  validateCustomFieldValue,
  type CustomFieldDefinitionLike,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const defs = schema.customFieldDefinitions;
const vals = schema.customFieldValues;

type Definition = typeof defs.$inferSelect;
type ValueRow = typeof vals.$inferSelect;

/** A `custom_field_definitions` row — exported so callers can pass a scoped
 *  definition list (e.g. ticket-type-scoped) into {@link setValues}/{@link hydrateCustomFields}. */
export type CustomFieldDefinitionRow = Definition;

/** Slug -> value map, the shape entity APIs read/write. */
export type CustomFieldMap = Record<string, unknown>;

/** Load active definitions for an entity type (needed to map slug<->fieldId). */
export async function getDefinitionsForEntityType(
  db: AnyDb,
  entityType: string,
): Promise<Definition[]> {
  return db
    .select()
    .from(defs)
    .where(and(eq(defs.entityType, entityType), isNull(defs.deletedAt)));
}

/**
 * Definitions applicable to a ticket of a given type: entityType='ticket' rows
 * scoped to `ticketTypeId` PLUS global (ticketTypeId null) ticket definitions.
 *
 * Pass the result as the `definitions` option to {@link setValues} /
 * {@link hydrateCustomFields}: ticket values must resolve slug->def within the
 * ticket's own type, because two ticket types may legally share a slug (the
 * value table is keyed by the immutable fieldId, so storage never collides, but
 * write-time slug resolution would be ambiguous without this scoping).
 *
 * `ticketTypeId` null/undefined → only the global ticket definitions.
 */
export async function getDefinitionsForTicket(
  db: AnyDb,
  ticketTypeId: string | null | undefined,
): Promise<Definition[]> {
  const scope = ticketTypeId
    ? or(eq(defs.ticketTypeId, ticketTypeId), isNull(defs.ticketTypeId))
    : isNull(defs.ticketTypeId);
  return db
    .select()
    .from(defs)
    .where(and(eq(defs.entityType, 'ticket'), scope, isNull(defs.deletedAt)));
}

/**
 * Return the active global definition for (entityType, slug), creating a `text`
 * one if none exists. "Global" means ticketTypeId IS NULL — the scope used by
 * workflow attributes (person / conversation) and by the migration backfill.
 *
 * This is the auto-create policy for Pile B: a user-authored attribute that has
 * no definition yet (a workflow step targeting a fresh name, or a legacy blob
 * key) still gets a home in the typed store instead of being dropped when the
 * blob columns go away at Phase 4.
 */
export async function ensureCustomFieldDefinition(
  db: AnyDb,
  generateId: IdGenerator,
  entityType: string,
  slug: string,
  name?: string,
): Promise<Definition> {
  const [found] = await db
    .select()
    .from(defs)
    .where(
      and(eq(defs.entityType, entityType), eq(defs.slug, slug), isNull(defs.ticketTypeId), isNull(defs.deletedAt)),
    )
    .limit(1);
  if (found) return found;

  const now = new Date();
  const [created] = await db
    .insert(defs)
    .values({
      id: generateId('cfld'),
      entityType,
      name: name ?? slug,
      slug,
      fieldType: 'text',
      required: false,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    } as typeof defs.$inferInsert)
    .returning();
  if (!created) throw new Error(`Failed to create custom field definition ${entityType}.${slug}`);
  return created;
}

/** Reconstruct the slug->value map for one value row against its definition. */
function readValue(def: Definition, row: ValueRow): unknown {
  switch (fieldTypeToValueColumn(def.fieldType as CustomFieldDefinitionLike['fieldType'])) {
    case 'number':
      return row.valueNumber ?? null;
    case 'date':
      return row.valueDate ? row.valueDate.toISOString() : null;
    case 'bool':
      return row.valueBool ?? null;
    case 'json':
      return row.valueJson ?? null;
    case 'ref':
      return row.valueRef ?? null;
    case 'text':
    default:
      return row.valueText ?? null;
  }
}

/**
 * Batch-hydrate custom field values for many entities of one type.
 * Returns `{ [entityId]: { [slug]: value } }`. Entities with no values still
 * get an entry (empty object) so callers can attach `customFields` uniformly.
 */
export async function getValuesForEntities(
  db: AnyDb,
  entityType: string,
  entityIds: string[],
  definitions?: Definition[],
): Promise<Record<string, CustomFieldMap>> {
  const out: Record<string, CustomFieldMap> = {};
  for (const id of entityIds) out[id] = {};
  if (entityIds.length === 0) return out;

  const defList = definitions ?? (await getDefinitionsForEntityType(db, entityType));
  if (defList.length === 0) return out;
  const defById = new Map(defList.map((d) => [d.id, d]));

  const rows = await db
    .select()
    .from(vals)
    .where(and(eq(vals.entityType, entityType), inArray(vals.entityId, entityIds)));

  for (const row of rows) {
    const def = defById.get(row.fieldId);
    if (!def) continue; // definition deleted — value is inert
    const bucket = out[row.entityId] ?? (out[row.entityId] = {});
    bucket[def.slug] = readValue(def, row);
  }
  return out;
}

/** Single-entity convenience wrapper over {@link getValuesForEntities}. */
export async function getValuesForEntity(
  db: AnyDb,
  entityType: string,
  entityId: string,
  definitions?: Definition[],
): Promise<CustomFieldMap> {
  const map = await getValuesForEntities(db, entityType, [entityId], definitions);
  return map[entityId] ?? {};
}

/**
 * Phase 3 read cutover — replace each row's legacy `customFields` blob with the
 * values read out of the typed table.
 *
 * Batched: one definitions query + one values query for the whole page, so a
 * list endpoint costs two extra queries regardless of page size.
 *
 * **Migration-window fallback.** An entity with zero rows in the values table
 * keeps its blob untouched. That makes this cutover safe to deploy into an
 * environment that has not been backfilled yet (Phase 2): un-backfilled rows
 * keep serving the blob instead of silently reading as empty. Post-Phase-1 the
 * two are kept in lockstep by `syncValuesForEntity`, so the fallback can only
 * ever return the same data the values table would have — never staler.
 *
 * Once Phase 2 has run everywhere and Phase 4 drops the blob columns, the
 * fallback becomes dead code and should be removed with them.
 *
 * Note: an entity that has SOME values migrated serves only the migrated set.
 * Orphaned slugs (no active definition) drop out of the response — they have no
 * definition, so no surface renders them anyway, and Phase 4 removes them for
 * good.
 */
export async function hydrateCustomFields<T extends { id: string; customFields?: unknown }>(
  db: AnyDb,
  entityType: string,
  rows: T[],
  definitions?: Definition[],
): Promise<T[]> {
  if (rows.length === 0) return rows;

  const defList = definitions ?? (await getDefinitionsForEntityType(db, entityType));
  // No definitions means nothing to hydrate; leave the rows exactly as read.
  if (defList.length === 0) return rows;

  const byEntity = await getValuesForEntities(
    db,
    entityType,
    rows.map((r) => r.id),
    defList,
  );

  return rows.map((row) => {
    const values = byEntity[row.id];
    if (!values || Object.keys(values).length === 0) return row; // fallback: keep blob

    // MERGE, never replace. The `custom_fields` blob is NOT exclusively
    // user-defined custom fields — several features use it as a general
    // extension bag under keys that have no `custom_field_definitions` row:
    //
    //   - tasks:         `customFields.attachments` (task attachment list)
    //   - mail_messages: `customFields.snoozedUntil` / `snoozedAt` / ...
    //
    // Those keys are invisible to the values table by design (no definition →
    // nothing to key a value row on). Replacing the blob wholesale therefore
    // dropped them from every response for an entity that had at least one
    // real custom field value — and because the UI round-trips the object it
    // receives (`{ ...customFields, attachments: next }`), the next write
    // persisted the truncated object, destroying the data for good.
    //
    // Overlaying the typed values ON TOP of the blob keeps foreign keys intact
    // while the typed table stays authoritative for every slug it knows about.
    const blob = (row.customFields as Record<string, unknown> | null) ?? {};
    return { ...row, customFields: { ...blob, ...values } };
  });
}

/** Single-row convenience wrapper over {@link hydrateCustomFields}. */
export async function hydrateCustomFieldsOne<T extends { id: string; customFields?: unknown }>(
  db: AnyDb,
  entityType: string,
  row: T | null,
): Promise<T | null> {
  if (!row) return null;
  const [hydrated] = await hydrateCustomFields(db, entityType, [row]);
  return hydrated ?? row;
}

/** Map a validated value onto the correct typed insert column. */
function toValueColumns(
  def: Definition,
  value: string | number | boolean | string[] | Record<string, unknown> | null,
): Partial<typeof vals.$inferInsert> {
  const base = {
    valueText: null,
    valueNumber: null,
    valueDate: null,
    valueBool: null,
    valueJson: null,
    valueRef: null,
  } as Partial<typeof vals.$inferInsert>;
  if (value === null) return base;

  switch (fieldTypeToValueColumn(def.fieldType as CustomFieldDefinitionLike['fieldType'])) {
    case 'number':
      return { ...base, valueNumber: value as number };
    case 'date':
      return { ...base, valueDate: new Date(value as string) };
    case 'bool':
      return { ...base, valueBool: value as boolean };
    case 'json':
      return { ...base, valueJson: value as unknown };
    case 'ref':
      return { ...base, valueRef: value as string };
    case 'text':
    default:
      return { ...base, valueText: value as string };
  }
}

export class CustomFieldValidationError extends Error {}

/**
 * Upsert the given `{ [slug]: value }` map for an entity. Unknown slugs are
 * ignored; a `null`/empty value clears (deletes) that field's row. Values are
 * validated/coerced against their definitions — throws
 * {@link CustomFieldValidationError} on the first invalid value.
 *
 * `patch=true` (default) only touches the slugs present in `values`, leaving
 * other stored values intact. `patch=false` treats `values` as the full set,
 * clearing any stored field not present.
 *
 * `generateId` is injected so each runtime uses its own id source.
 */
export async function setValues(
  db: AnyDb,
  entityType: string,
  entityId: string,
  values: CustomFieldMap,
  options: {
    generateId: IdGenerator;
    definitions?: Definition[];
    patch?: boolean;
    enforceRequired?: boolean;
  },
): Promise<void> {
  const { generateId } = options;
  const patch = options.patch ?? true;
  const enforceRequired = options.enforceRequired ?? true;
  const defList = options.definitions ?? (await getDefinitionsForEntityType(db, entityType));
  if (defList.length === 0) return;
  const defBySlug = new Map(defList.map((d) => [d.slug, d]));

  const slugs = patch ? Object.keys(values) : defList.map((d) => d.slug);
  const now = new Date();

  const existing = await db
    .select()
    .from(vals)
    .where(and(eq(vals.entityType, entityType), eq(vals.entityId, entityId)));
  const existingByFieldId = new Map(existing.map((r) => [r.fieldId, r]));

  for (const slug of slugs) {
    const def = defBySlug.get(slug);
    if (!def) continue;
    const raw = Object.prototype.hasOwnProperty.call(values, slug) ? values[slug] : undefined;
    // In non-patch mode a missing slug means "clear"; in patch mode we skip it.
    if (raw === undefined && patch) continue;

    const isEmpty = raw === null || raw === undefined || raw === '';
    const prior = existingByFieldId.get(def.id);

    let normalized: string | number | boolean | string[] | Record<string, unknown> | null;
    if (isEmpty && !enforceRequired) {
      // Migration-window mirror: never block on a required-but-absent field.
      normalized = null;
    } else {
      const result = validateCustomFieldValue(def as CustomFieldDefinitionLike, raw);
      if (!result.ok) throw new CustomFieldValidationError(result.error ?? `Invalid value for '${slug}'`);
      normalized = result.value ?? null;
    }

    if (normalized === null) {
      if (prior) {
        await db.delete(vals).where(eq(vals.id, prior.id));
      }
      continue;
    }

    const columns = toValueColumns(def, normalized);
    if (prior) {
      await db
        .update(vals)
        .set({ ...columns, updatedAt: now })
        .where(eq(vals.id, prior.id));
    } else {
      await db.insert(vals).values({
        id: generateId('cfv'),
        fieldId: def.id,
        entityType,
        entityId,
        createdAt: now,
        updatedAt: now,
        ...columns,
      } as typeof vals.$inferInsert);
    }
  }
}

/** Delete every stored value for an entity (call on hard-delete of the parent). */
export async function deleteValuesForEntity(
  db: AnyDb,
  entityType: string,
  entityId: string,
): Promise<void> {
  await db
    .delete(vals)
    .where(and(eq(vals.entityType, entityType), eq(vals.entityId, entityId)));
}

/**
 * Dual-write mirror for the migration window (Phase 1).
 *
 * Mirrors the wholesale `customFields` blob into the typed values table on
 * entity create/update. It is intentionally best-effort: the JSONB blob stays
 * the source of truth until the Phase 3 read cutover, so this MUST NEVER fail
 * the primary entity write — validation/coercion errors are logged and skipped.
 *
 * - `customFields === undefined` → the caller isn't touching custom fields; no-op.
 * - `customFields === null` or `{}` → clear all mirrored values.
 * - object → replace the mirrored set wholesale (matches how the blob column is
 *   overwritten), never blocking on required-but-absent fields.
 */
export async function syncValuesForEntity(
  db: AnyDb,
  entityType: string,
  entityId: string,
  customFields: CustomFieldMap | null | undefined,
  generateId: IdGenerator,
  definitions?: Definition[],
): Promise<void> {
  if (customFields === undefined) return;
  try {
    await setValues(db, entityType, entityId, customFields ?? {}, {
      generateId,
      definitions,
      patch: false,
      enforceRequired: false,
    });
  } catch (err) {
    console.warn(
      `[custom-field-values] dual-write mirror failed for ${entityType}:${entityId}`,
      err,
    );
  }
}
