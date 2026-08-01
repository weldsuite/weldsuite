/**
 * WeldObjects — runtime-agnostic object resolution and record CRUD.
 *
 * Shared by app-api (the platform surface) and external-api (the `wsk_` public
 * API), following the same pattern as `custom-field-values.ts`: a loose `AnyDb`
 * and an injected `generateId` so both runtimes use one implementation rather
 * than two that drift.
 *
 * What is NOT here: the list query with custom-field sorting and filtering.
 * That depends on the SQL fragment builders in app-api's
 * `services/custom-field-query.ts` and is meaningfully more complex, so app-api
 * keeps its own richer `listRecords`. external-api gets `listRecordsSimple`
 * below — search, owner filter and cursor, sorted by title or creation date,
 * which is what a third-party integration actually needs.
 *
 * Records store no field values of their own. Values live in
 * `custom_field_values` keyed on `(entity_type = entityKey, entity_id =
 * record.id)`, so everything here goes through the shared custom-field-values
 * helpers.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import {
  getDefinitionsForEntityType,
  getValuesForEntities,
  setValues,
  deleteValuesForEntity,
  type CustomFieldDefinitionRow,
  type CustomFieldMap,
} from './custom-field-values';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Commits a built list of statements as one unit.
 *
 * Injected rather than imported for the same reason `generateId` is: this
 * module is runtime-agnostic, and the implementation is driver-specific
 * (neon-http has no interactive transactions and uses `db.batch()`; pglite
 * uses a real transaction). app-api passes its `lib/atomically` helper.
 *
 * Generic in the database type so a caller holding a NARROWER handle (app-api's
 * concrete `Database`) can pass its equally narrow runner. Fixing the parameter
 * to `AnyDb` would make that assignment fail on contravariance, and widening
 * the runner instead would break its other, unrelated call sites.
 */
export type AtomicRunner<D = AnyDb> = (
  db: D,
  build: (handle: D) => unknown[],
) => Promise<void>;

const objects = schema.customObjects;
const records = schema.customObjectRecords;
const links = schema.customObjectLinks;
const relations = schema.customObjectRelations;
const fieldDefs = schema.customFieldDefinitions;

export type CustomObjectRow = typeof objects.$inferSelect;
export type CustomObjectRecordRow = typeof records.$inferSelect;
export type CustomObjectRecordWithFields = CustomObjectRecordRow & { fields: CustomFieldMap };

/** `'machine'` → `'co_machine'`. */
export function entityKeyForSlug(slug: string): string {
  return `co_${slug}`;
}

/**
 * Parse a `?limit=` query value into a usable page size.
 *
 * `Number.parseInt('abc')` is NaN and `Math.min(NaN, 100)` is NaN, so the naive
 * one-liner forwards NaN — and negatives and zero — straight into the SQL LIMIT
 * clause, turning a caller's typo into a 500. Clamp, and fall back to the
 * default for anything unparseable.
 */
export function parseLimit(raw: string | undefined, fallback = 25, max = 100): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

/**
 * Escape a user search term for use inside an ILIKE pattern.
 *
 * `%` and `_` are wildcards in LIKE, so an unescaped term means a user typing
 * `50%` matches far more than they asked for and a lone `%` matches every row.
 * The term is the user's literal text; only the surrounding `%…%` should act as
 * a wildcard.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Object type resolution
// ---------------------------------------------------------------------------

export async function getCustomObjectBySlug(
  db: AnyDb,
  slug: string,
): Promise<CustomObjectRow | null> {
  const [row] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.slug, slug), isNull(objects.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getCustomObjectByEntityKey(
  db: AnyDb,
  entityKey: string,
): Promise<CustomObjectRow | null> {
  const [row] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.entityKey, entityKey), isNull(objects.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listCustomObjects(
  db: AnyDb,
  opts: { status?: string; externalApiOnly?: boolean } = {},
): Promise<CustomObjectRow[]> {
  const conditions = [isNull(objects.deletedAt)];
  if (opts.status) conditions.push(eq(objects.status, opts.status));
  if (opts.externalApiOnly) conditions.push(eq(objects.enableExternalApi, true));
  return db
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(asc(objects.sortOrder), asc(objects.labelPlural));
}

export async function getCustomObjectCounts(
  db: AnyDb,
  entityKeys: string[],
): Promise<Record<string, { recordCount: number; fieldCount: number }>> {
  const out: Record<string, { recordCount: number; fieldCount: number }> = {};
  for (const key of entityKeys) out[key] = { recordCount: 0, fieldCount: 0 };
  if (entityKeys.length === 0) return out;

  const [recordRows, fieldRows] = await Promise.all([
    db
      .select({ entityKey: records.entityKey, count: sql<number>`count(*)` })
      .from(records)
      .where(and(inArray(records.entityKey, entityKeys), isNull(records.deletedAt)))
      .groupBy(records.entityKey),
    db
      .select({ entityType: fieldDefs.entityType, count: sql<number>`count(*)` })
      .from(fieldDefs)
      .where(and(inArray(fieldDefs.entityType, entityKeys), isNull(fieldDefs.deletedAt)))
      .groupBy(fieldDefs.entityType),
  ]);

  for (const r of recordRows) {
    if (out[r.entityKey]) out[r.entityKey]!.recordCount = Number(r.count ?? 0);
  }
  for (const f of fieldRows) {
    if (out[f.entityType]) out[f.entityType]!.fieldCount = Number(f.count ?? 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Title maintenance
// ---------------------------------------------------------------------------

/** Field types that can serve as a record's display name. */
const TITLE_FALLBACK_TYPES = ['text', 'email', 'url', 'phone', 'textarea'];

/**
 * A record's display title, from its field values.
 *
 * Falls through: the configured title field → the first text-ish field with a
 * value → null. Null renders as the record id in the UI — ugly but honest, and
 * only reachable for an object that has no fields yet.
 */
export function resolveRecordTitle(
  object: CustomObjectRow,
  definitions: CustomFieldDefinitionRow[],
  fields: CustomFieldMap,
): string | null {
  if (object.titleFieldId) {
    const def = definitions.find((d) => d.id === object.titleFieldId);
    if (def) {
      const raw = fields[def.slug];
      if (raw !== undefined && raw !== null && raw !== '') return String(raw).slice(0, 500);
    }
  }

  const ordered = [...definitions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  for (const def of ordered) {
    if (!TITLE_FALLBACK_TYPES.includes(def.fieldType)) continue;
    const raw = fields[def.slug];
    if (raw !== undefined && raw !== null && raw !== '') return String(raw).slice(0, 500);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Record reads
// ---------------------------------------------------------------------------

export async function getRecord(
  db: AnyDb,
  object: CustomObjectRow,
  id: string,
  ownerScope?: string,
): Promise<CustomObjectRecordWithFields | null> {
  const conditions = [
    eq(records.id, id),
    eq(records.entityKey, object.entityKey),
    isNull(records.deletedAt),
  ];
  if (ownerScope) conditions.push(eq(records.ownerId, ownerScope));

  const [row] = await db.select().from(records).where(and(...conditions)).limit(1);
  if (!row) return null;

  const byId = await getValuesForEntities(db, object.entityKey, [row.id]);
  return { ...row, fields: byId[row.id] ?? {} };
}

export interface SimpleListOptions {
  limit: number;
  /** Record id to page after — keyset on `(createdAt, id)`. */
  cursor?: string;
  search?: string;
  ownerId?: string;
  ownerScope?: string;
}

export interface SimpleListResult {
  data: CustomObjectRecordWithFields[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

/**
 * List records with a true keyset cursor, newest first.
 *
 * Unlike app-api's `listRecords`, this offers no custom-field sorting — which
 * is exactly why it can use a keyset cursor instead of an offset one, and so is
 * stable under concurrent inserts. Third-party API consumers paging a large
 * collection care about that far more than they care about sorting by an
 * arbitrary user-defined column.
 */
export async function listRecordsSimple(
  db: AnyDb,
  object: CustomObjectRow,
  opts: SimpleListOptions,
): Promise<SimpleListResult> {
  const filters = [eq(records.entityKey, object.entityKey), isNull(records.deletedAt)];
  // `ownerScope` (the caller lacks scope:all) wins over an explicit `ownerId`.
  // Applying both as equality would produce two contradictory predicates and an
  // always-empty page, which reads as "this user owns nothing" rather than
  // "you cannot see other owners" — a misleading answer to a permission
  // problem. Owner-scoped callers simply see their own records.
  if (opts.ownerScope) {
    filters.push(eq(records.ownerId, opts.ownerScope));
  } else if (opts.ownerId) {
    filters.push(eq(records.ownerId, opts.ownerId));
  }
  // NOTE: the leading wildcard means `cor_entity_key_title_idx` can't serve
  // this — each search scans the object's live records. Fine at the volumes a
  // hand-curated custom object reaches; if one ever grows large, the fix is a
  // pg_trgm GIN index on `title` (a migration, so not added here) or routing
  // search through the semantic index.
  if (opts.search) filters.push(ilike(records.title, `%${escapeLikeTerm(opts.search)}%`));

  const conditions = [...filters];
  if (opts.cursor) {
    const [cur] = await db
      .select({ createdAt: records.createdAt, id: records.id })
      .from(records)
      // Scoped to THIS object, not just the id. An unscoped lookup would let a
      // caller pass a record id from an object they can't read and use its
      // createdAt as this list's page boundary — a small but real cross-object
      // information leak, since the boundary is observable in the results.
      .where(and(eq(records.id, opts.cursor), eq(records.entityKey, object.entityKey)))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${records.createdAt} < ${cur.createdAt} OR (${records.createdAt} = ${cur.createdAt} AND ${records.id} < ${cur.id}))`,
      );
    }
  }

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(records)
      .where(and(...conditions))
      .orderBy(desc(records.createdAt), desc(records.id))
      .limit(opts.limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(records).where(and(...filters)),
  ]);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  const valuesByRecord = await getValuesForEntities(
    db,
    object.entityKey,
    page.map((r) => r.id),
  );

  return {
    data: page.map((r) => ({ ...r, fields: valuesByRecord[r.id] ?? {} })),
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
  };
}

// ---------------------------------------------------------------------------
// Record writes
// ---------------------------------------------------------------------------

export async function createRecord(
  db: AnyDb,
  object: CustomObjectRow,
  input: { fields?: CustomFieldMap; ownerId?: string | null },
  userId: string,
  generateId: IdGenerator,
): Promise<CustomObjectRecordWithFields> {
  const definitions = await getDefinitionsForEntityType(db, object.entityKey);
  const fields = input.fields ?? {};
  const id = generateId('cor');
  const now = new Date();

  // The shell goes in first so the value rows have a parent to point at. The
  // neon-http driver has no interactive transactions, so on a validation
  // failure we undo the shell by hand below rather than rolling back.
  await db.insert(records).values({
    id,
    objectId: object.id,
    entityKey: object.entityKey,
    title: null,
    ownerId: input.ownerId ?? userId,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await setValues(db, object.entityKey, id, fields, {
      generateId,
      definitions,
      patch: false,
      enforceRequired: true,
    });
  } catch (err) {
    await db.delete(records).where(eq(records.id, id));
    throw err;
  }

  const title = resolveRecordTitle(object, definitions, fields);
  await db.update(records).set({ title }).where(eq(records.id, id));

  const [row] = await db.select().from(records).where(eq(records.id, id)).limit(1);
  return { ...row!, fields };
}

export async function updateRecord(
  db: AnyDb,
  object: CustomObjectRow,
  existing: CustomObjectRecordRow,
  input: { fields?: CustomFieldMap; ownerId?: string | null },
  userId: string,
  generateId: IdGenerator,
): Promise<CustomObjectRecordWithFields> {
  const definitions = await getDefinitionsForEntityType(db, object.entityKey);

  if (input.fields) {
    await setValues(db, object.entityKey, existing.id, input.fields, {
      generateId,
      definitions,
      patch: true,
      // A PATCH that never mentions a required field must not fail on it —
      // only a value explicitly cleared to null should.
      enforceRequired: false,
    });
  }

  // Re-read the whole value set: the title may depend on a field this PATCH
  // didn't touch, so it can't be derived from `input.fields` alone.
  const byId = await getValuesForEntities(db, object.entityKey, [existing.id], definitions);
  const fields = byId[existing.id] ?? {};

  const patch: Partial<typeof records.$inferInsert> = {
    updatedAt: new Date(),
    updatedBy: userId,
    title: resolveRecordTitle(object, definitions, fields),
  };
  if (input.ownerId !== undefined) patch.ownerId = input.ownerId;

  await db.update(records).set(patch).where(eq(records.id, existing.id));

  const [row] = await db.select().from(records).where(eq(records.id, existing.id)).limit(1);
  return { ...row!, fields };
}

/**
 * Soft-delete a record; hard-delete what only exists to serve it.
 *
 * Values and edges are hard-deleted deliberately: nothing renders a deleted
 * record's field values, and a surviving edge would surface as a ghost entry in
 * a related panel on an unrelated record that was never deleted.
 */
export async function deleteRecord(
  db: AnyDb,
  object: CustomObjectRow,
  id: string,
): Promise<void> {
  await db
    .update(records)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    // Scoped by entityKey as well as id, matching the value and relation
    // deletes below. Callers resolve the record through `getRecord` first
    // (which scopes), so a mismatched (object, id) pair shouldn't reach here —
    // but an unscoped soft-delete would silently hit another object's record if
    // one ever did.
    .where(and(eq(records.id, id), eq(records.entityKey, object.entityKey)));

  await deleteValuesForEntity(db, object.entityKey, id);

  await db
    .delete(relations)
    .where(
      sql`(${relations.sourceEntityKey} = ${object.entityKey} AND ${relations.sourceId} = ${id})
       OR (${relations.targetEntityKey} = ${object.entityKey} AND ${relations.targetId} = ${id})`,
    );
}

/**
 * The same three writes as {@link deleteRecord}, returned unexecuted so a
 * caller can commit them alongside other statements (Drizzle builders are lazy).
 *
 * The route uses this to put a record delete and its link cascade in ONE unit:
 * running them as two steps meant a failure in the second left the cascade's
 * dependent records deleted while the record they hung off survived, with no
 * way to recover them.
 */
export function buildRecordDeleteStatements(
  handle: AnyDb,
  object: CustomObjectRow,
  id: string,
  now = new Date(),
): unknown[] {
  return [
    handle
      .update(records)
      .set({ deletedAt: now, updatedAt: now })
      // See deleteRecord — scoped by entityKey so a mismatched (object, id)
      // pair can never soft-delete a different object's record.
      .where(and(eq(records.id, id), eq(records.entityKey, object.entityKey))),
    handle
      .delete(schema.customFieldValues)
      .where(
        and(
          eq(schema.customFieldValues.entityType, object.entityKey),
          eq(schema.customFieldValues.entityId, id),
        ),
      ),
    handle
      .delete(relations)
      .where(
        sql`(${relations.sourceEntityKey} = ${object.entityKey} AND ${relations.sourceId} = ${id})
         OR (${relations.targetEntityKey} = ${object.entityKey} AND ${relations.targetId} = ${id})`,
      ),
  ];
}

// ---------------------------------------------------------------------------
// Object type deletion
// ---------------------------------------------------------------------------

export interface DeleteObjectImpact {
  recordCount: number;
  fieldCount: number;
  linkCount: number;
  relationCount: number;
}

export async function getDeleteImpact(
  db: AnyDb,
  object: CustomObjectRow,
): Promise<DeleteObjectImpact> {
  const [rec, fld, lnk, rel] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(records)
      .where(and(eq(records.entityKey, object.entityKey), isNull(records.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(fieldDefs)
      .where(and(eq(fieldDefs.entityType, object.entityKey), isNull(fieldDefs.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(links)
      .where(
        and(
          sql`(${links.sourceEntityKey} = ${object.entityKey} OR ${links.targetEntityKey} = ${object.entityKey})`,
          isNull(links.deletedAt),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(relations)
      .where(
        sql`${relations.sourceEntityKey} = ${object.entityKey} OR ${relations.targetEntityKey} = ${object.entityKey}`,
      ),
  ]);

  return {
    recordCount: Number(rec[0]?.count ?? 0),
    fieldCount: Number(fld[0]?.count ?? 0),
    linkCount: Number(lnk[0]?.count ?? 0),
    relationCount: Number(rel[0]?.count ?? 0),
  };
}

/**
 * Delete an object type and everything hanging off it.
 *
 * Soft-deletes the definition, its fields and its records so an accidental
 * delete is recoverable by a DBA. Hard-deletes values, edges and search rows,
 * which would otherwise be unreachable garbage — and, for edges and search
 * rows, would keep surfacing on pages that were never deleted.
 */
export async function deleteCustomObjectCascade<D extends AnyDb>(
  db: D,
  object: CustomObjectRow,
  atomically: AtomicRunner<D>,
): Promise<void> {
  const now = new Date();

  await atomically(db, (handle) => [
    // Set-based, not "SELECT every record id then pass them to inArray". The id
    // list was unbounded: an object with 100k records built a 100k-parameter
    // statement and blew the request up. The subquery does the same work
    // server-side at constant client cost.
    handle.delete(schema.customFieldValues).where(
      and(
        eq(schema.customFieldValues.entityType, object.entityKey),
        sql`${schema.customFieldValues.entityId} IN (
          SELECT ${records.id} FROM ${records} WHERE ${records.entityKey} = ${object.entityKey}
        )`,
      ),
    ),

    handle
      .delete(relations)
      .where(
        sql`${relations.sourceEntityKey} = ${object.entityKey} OR ${relations.targetEntityKey} = ${object.entityKey}`,
      ),

    handle
      .update(links)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        sql`${links.sourceEntityKey} = ${object.entityKey} OR ${links.targetEntityKey} = ${object.entityKey}`,
      ),

    handle
      .update(records)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(records.entityKey, object.entityKey)),

    handle
      .update(fieldDefs)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(fieldDefs.entityType, object.entityKey)),

    handle.delete(schema.searchIndex).where(eq(schema.searchIndex.entityType, object.entityKey)),

    // LAST on purpose: this is the row every other read gates on. Because the
    // whole list commits as one unit, a failure anywhere leaves the object
    // fully intact and the delete simply retryable — previously a mid-way
    // failure could strip the records while the definition survived.
    handle.update(objects).set({ deletedAt: now, updatedAt: now }).where(eq(objects.id, object.id)),
  ]);
}

// ---------------------------------------------------------------------------
// Agent tool descriptors
// ---------------------------------------------------------------------------

export interface CustomObjectToolField {
  slug: string;
  name: string;
  fieldType: string;
  required: boolean;
  description: string | null;
  options: string[] | null;
}

export interface CustomObjectToolDescriptor {
  slug: string;
  entityKey: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  fields: CustomObjectToolField[];
}

/**
 * Describe every object opted into agent tooling, with enough field metadata
 * for the MCP server to synthesise a JSON Schema per tool.
 *
 * One definitions query for all objects rather than one per object — a
 * workspace with thirty objects would otherwise cost thirty round-trips on
 * every MCP tool-list call.
 */
export async function listAgentToolObjects(
  db: AnyDb,
): Promise<CustomObjectToolDescriptor[]> {
  const rows = await db
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.enableAgentTools, true),
        // ALSO gated on external API exposure, which is not redundant: the
        // generated tools execute against `/v1/custom-objects/:slug/records`,
        // and that route resolves through `resolveExposedObject` — which 404s
        // anything without `enableExternalApi`. Listing a tool that every call
        // would 404 is worse than not listing it, and it would leak the
        // object's field definitions to a surface the workspace didn't expose.
        eq(objects.enableExternalApi, true),
        eq(objects.status, 'active'),
        isNull(objects.deletedAt),
      ),
    )
    .orderBy(asc(objects.sortOrder));

  if (rows.length === 0) return [];

  const entityKeys = rows.map((r) => r.entityKey);
  const defs = await db
    .select()
    .from(fieldDefs)
    .where(and(inArray(fieldDefs.entityType, entityKeys), isNull(fieldDefs.deletedAt)))
    .orderBy(asc(fieldDefs.sortOrder));

  const defsByKey = new Map<string, typeof defs>();
  for (const def of defs) {
    const list = defsByKey.get(def.entityType) ?? [];
    list.push(def);
    defsByKey.set(def.entityType, list);
  }

  return rows.map((row) => ({
    slug: row.slug,
    entityKey: row.entityKey,
    labelSingular: row.labelSingular,
    labelPlural: row.labelPlural,
    description: row.description,
    fields: (defsByKey.get(row.entityKey) ?? []).map((d) => ({
      slug: d.slug,
      name: d.name,
      fieldType: d.fieldType,
      required: d.required ?? false,
      description: d.description,
      options: d.options ? d.options.map((o) => o.value) : null,
    })),
  }));
}
