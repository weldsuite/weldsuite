/**
 * app-api binding of the shared WeldObjects service
 * (`@weldsuite/db/lib/custom-objects`).
 *
 * The implementation and all design notes live in the shared module — it is
 * runtime-agnostic and takes an injected `generateId`, so app-api and
 * external-api share one copy rather than two that drift. This file re-exports
 * the read helpers unchanged and binds app-api's `generateId` into the writers,
 * matching how `services/custom-field-values.ts` wraps its shared module.
 *
 * The ONE thing implemented here rather than shared is `listRecords`: it sorts
 * and filters by custom field, which needs the SQL fragment builders in
 * `./custom-field-query.ts`. external-api uses the shared `listRecordsSimple`
 * instead — a true keyset cursor, no custom-field sorting.
 */

import { and, asc, desc, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import {
  createRecord as createRecordShared,
  updateRecord as updateRecordShared,
  type CustomObjectRow,
  type CustomObjectRecordWithFields,
} from '@weldsuite/db/lib/custom-objects';
import {
  getDefinitionsForEntityType,
  getValuesForEntities,
  type CustomFieldMap,
} from './custom-field-values';
import {
  customFieldFilter,
  customFieldOrderBy,
  parseCustomFieldKey,
} from './custom-field-query';
import { generateId } from '../lib/id';
import { schema } from '../db';
import type { Database } from '../db';

export {
  entityKeyForSlug,
  getCustomObjectBySlug,
  getCustomObjectByEntityKey,
  listCustomObjects,
  getCustomObjectCounts,
  resolveRecordTitle,
  getRecord,
  listRecordsSimple,
  deleteRecord,
  getDeleteImpact,
  deleteCustomObjectCascade,
  listAgentToolObjects,
} from '@weldsuite/db/lib/custom-objects';

export type {
  CustomObjectRow,
  CustomObjectRecordRow,
  CustomObjectRecordWithFields,
  DeleteObjectImpact,
  CustomObjectToolDescriptor,
  CustomObjectToolField,
} from '@weldsuite/db/lib/custom-objects';

const records = schema.customObjectRecords;

/** Create a record — app-api's `generateId` bound. */
export function createRecord(
  db: Database,
  object: CustomObjectRow,
  input: { fields?: CustomFieldMap; ownerId?: string | null },
  userId: string,
): Promise<CustomObjectRecordWithFields> {
  return createRecordShared(db, object, input, userId, generateId);
}

/** Update a record — app-api's `generateId` bound. */
export function updateRecord(
  db: Database,
  object: CustomObjectRow,
  existing: { id: string },
  input: { fields?: CustomFieldMap; ownerId?: string | null },
  userId: string,
): Promise<CustomObjectRecordWithFields> {
  return updateRecordShared(
    db,
    object,
    existing as Parameters<typeof updateRecordShared>[2],
    input,
    userId,
    generateId,
  );
}

// ---------------------------------------------------------------------------
// Rich list query
// ---------------------------------------------------------------------------

/**
 * Custom object lists support sorting by ANY custom field, and a keyset cursor
 * would need a different tuple per sort column plus a NULL-ordering rule that
 * matches the `NULLS LAST` in the ORDER BY. Rather than maintain four cursor
 * shapes, this encodes an offset.
 *
 * The API contract treats `cursor` as opaque, so this is legal. The trade-off
 * is the usual one: a row inserted or deleted mid-pagination shifts the window
 * by one. Every ORDER BY below appends `id`, so the ordering itself is total
 * and stable even when the sort column has ties or nulls.
 */
function encodeCursor(offset: number): string {
  return `o${offset}`;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor || !cursor.startsWith('o')) return 0;
  const n = Number.parseInt(cursor.slice(1), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface ListRecordsOptions {
  limit: number;
  cursor?: string;
  search?: string;
  /** Set to a user id to restrict to that owner (caller lacks `scope:all`). */
  ownerScope?: string;
  ownerId?: string;
  /** `title` | `createdAt` | `updatedAt` | `custom:<fieldSlug>` */
  sort?: string;
  direction?: 'asc' | 'desc';
  /** `{ 'custom:region': 'EU' }` */
  filters?: Record<string, string>;
}

export interface ListRecordsResult {
  data: CustomObjectRecordWithFields[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listRecords(
  db: Database,
  object: CustomObjectRow,
  opts: ListRecordsOptions,
): Promise<ListRecordsResult> {
  const definitions = await getDefinitionsForEntityType(db, object.entityKey);
  const defBySlug = new Map(definitions.map((d) => [d.slug, d]));

  const conditions: SQL[] = [
    eq(records.entityKey, object.entityKey),
    isNull(records.deletedAt),
  ];
  // See listRecordsSimple in @weldsuite/db/lib/custom-objects — `ownerScope`
  // wins, because combining both as equality yields a contradictory predicate
  // and an always-empty page that misrepresents a permission limit as "no
  // records".
  if (opts.ownerScope) {
    conditions.push(eq(records.ownerId, opts.ownerScope));
  } else if (opts.ownerId) {
    conditions.push(eq(records.ownerId, opts.ownerId));
  }
  if (opts.search) conditions.push(ilike(records.title, `%${opts.search}%`));

  // An unresolvable filter means "no rows match", never "drop the filter".
  // Silently widening a result set is the more dangerous failure — the caller
  // believes it narrowed.
  for (const [key, raw] of Object.entries(opts.filters ?? {})) {
    const fieldSlug = parseCustomFieldKey(key);
    if (!fieldSlug) continue;
    const def = defBySlug.get(fieldSlug);
    if (!def) return { data: [], totalCount: 0, hasMore: false, cursor: null };
    // `fieldType` is varchar on the row but a closed union in the helper —
    // the same widening cast services/companies.ts uses.
    const fragment = customFieldFilter(
      object.entityKey,
      records.id,
      def as unknown as Parameters<typeof customFieldFilter>[2],
      raw,
    );
    if (!fragment) return { data: [], totalCount: 0, hasMore: false, cursor: null };
    conditions.push(fragment);
  }

  const where = and(...conditions);
  const direction = opts.direction ?? 'desc';

  const orderBy: SQL[] = [];
  const customSortSlug = parseCustomFieldKey(opts.sort);
  if (customSortSlug) {
    const def = defBySlug.get(customSortSlug);
    if (def) {
      orderBy.push(
        customFieldOrderBy(
          object.entityKey,
          records.id,
          def as unknown as Parameters<typeof customFieldOrderBy>[2],
          direction,
        ),
      );
    }
  } else if (opts.sort === 'title') {
    orderBy.push(direction === 'asc' ? asc(records.title) : desc(records.title));
  } else if (opts.sort === 'updatedAt') {
    orderBy.push(direction === 'asc' ? asc(records.updatedAt) : desc(records.updatedAt));
  }
  if (orderBy.length === 0) {
    orderBy.push(direction === 'asc' ? asc(records.createdAt) : desc(records.createdAt));
  }
  orderBy.push(desc(records.id));

  const offset = decodeCursor(opts.cursor);

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(records)
      .where(where)
      .orderBy(...orderBy)
      .limit(opts.limit + 1)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(records).where(where),
  ]);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  const valuesByRecord = await getValuesForEntities(
    db,
    object.entityKey,
    page.map((r) => r.id),
    definitions,
  );

  return {
    data: page.map((r) => ({ ...r, fields: valuesByRecord[r.id] ?? {} })),
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor: hasMore ? encodeCursor(offset + opts.limit) : null,
  };
}
