/**
 * WeldObjects — semantic search documents for user-defined objects.
 *
 * The loaders in documents.ts are a static array, one per compile-time entity
 * type. Custom objects can't be in it: their entity types are created at
 * runtime, and a workspace may have any number of them.
 *
 * `search_index` was built for exactly this. Its header notes the table is
 * "deliberately generic (`entity_type` + `entity_id`) rather than a vector
 * column per searchable table: adding a new searchable entity becomes a
 * registry entry in the search service, not a fresh migration". Custom objects
 * take that one step further — they aren't even a registry entry, they're a
 * loader built on demand from the object's own field definitions.
 *
 * ## What gets embedded
 *
 * The record title plus every text-ish field value, rendered as
 * `Field label: value` lines so the embedding sees the field's meaning and not
 * just a bag of strings. Numbers, dates, booleans and refs are excluded: they
 * carry no semantic signal, and including them would let a date change churn
 * the content hash and trigger a needless re-embed.
 */

import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import type { IndexableDocument, DocumentPage } from './documents';
import { getValuesForEntities } from '../custom-field-values';
import { getCustomObjectByEntityKey, type CustomObjectRow } from '../custom-objects';
import { getDefinitionsForEntityType } from '../custom-field-values';

const records = schema.customObjectRecords;

/** Field types whose values are worth embedding. */
const SEMANTIC_FIELD_TYPES = new Set([
  'text',
  'textarea',
  'url',
  'email',
  'phone',
  'single_select',
  'multi_select',
]);

/**
 * A custom object's loader has the same shape as a static one but is
 * parameterised by the object row, and its `entityType` is the runtime
 * `co_<slug>` key rather than a `SearchEntityType`.
 */
export interface CustomObjectDocumentLoader {
  entityKey: string;
  load(db: Database, entityId: string): Promise<IndexableDocument | null>;
  page(db: Database, afterId: string | null, limit: number): Promise<DocumentPage>;
}

function renderContent(
  object: CustomObjectRow,
  definitions: Array<{ slug: string; name: string; fieldType: string; sortOrder: number | null }>,
  title: string,
  fields: Record<string, unknown>,
): string {
  const lines: string[] = [`${object.labelSingular}: ${title}`];

  const ordered = [...definitions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  for (const def of ordered) {
    if (!SEMANTIC_FIELD_TYPES.has(def.fieldType)) continue;
    const raw = fields[def.slug];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (!value.trim()) continue;
    lines.push(`${def.name}: ${value}`);
  }

  return lines.join('\n').replace(/[ \t]+/g, ' ').trim();
}

/** Build a loader for one custom object. */
export function buildCustomObjectLoader(object: CustomObjectRow): CustomObjectDocumentLoader {
  const url = (id: string) => `/objects/${object.slug}/${id}`;

  const toDocuments = async (
    db: Database,
    rows: Array<typeof records.$inferSelect>,
  ): Promise<IndexableDocument[]> => {
    if (rows.length === 0) return [];

    const definitions = await getDefinitionsForEntityType(db, object.entityKey);
    const valuesByRecord = await getValuesForEntities(
      db,
      object.entityKey,
      rows.map((r) => r.id),
      definitions,
    );

    const out: IndexableDocument[] = [];
    for (const row of rows) {
      // A record with no title has nothing worth matching on — skip rather
      // than index its id.
      const title = row.title?.trim();
      if (!title) continue;

      const content = renderContent(
        object,
        definitions,
        title,
        valuesByRecord[row.id] ?? {},
      );
      if (!content) continue;

      out.push({
        // The runtime key. `IndexableDocument.entityType` is typed as
        // SearchEntityType for the static loaders' benefit; the column it
        // lands in is a plain varchar(30), which is why the slug is capped at
        // 24 characters.
        entityType: object.entityKey as IndexableDocument['entityType'],
        entityId: row.id,
        title,
        subtitle: object.labelSingular,
        url: url(row.id),
        content,
      });
    }
    return out;
  };

  return {
    entityKey: object.entityKey,

    async load(db, entityId) {
      const rows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.id, entityId),
            eq(records.entityKey, object.entityKey),
            isNull(records.deletedAt),
          ),
        )
        .limit(1);
      const [doc] = await toDocuments(db, rows);
      return doc ?? null;
    },

    async page(db, afterId, limit) {
      const conditions = [eq(records.entityKey, object.entityKey), isNull(records.deletedAt)];
      if (afterId) conditions.push(gt(records.id, afterId));

      const rows = await db
        .select()
        .from(records)
        .where(and(...conditions))
        .orderBy(asc(records.id))
        .limit(limit);

      return {
        documents: await toDocuments(db, rows),
        // `rowsRead` counts SCANNED rows, not emitted documents — a titleless
        // record is dropped from `documents` but must still advance the
        // cursor, or the backfill would stall on it forever.
        rowsRead: rows.length,
        lastScannedId: rows.length > 0 ? rows[rows.length - 1]!.id : null,
      };
    },
  };
}

/**
 * Postgres `undefined_table`. The WeldObjects tables arrive in a tenant
 * migration, and migrations are a separate rollout from worker code — a tenant
 * that hasn't been migrated yet (or a test database built from the migration
 * files as they stand today) simply has no `custom_objects` table.
 *
 * Search must degrade to "this tenant has no custom objects" in that case, NOT
 * take the whole reindex down: the backfill walks every entity type in one
 * loop, so an exception here would strand invoices, tickets and everything else
 * as collateral. Same posture as the roles permission-catalog merge.
 *
 * Deliberately narrow — only 42P01 is swallowed. A real query bug still throws.
 */
const UNDEFINED_TABLE = '42P01';

/**
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so the Postgres
 * `code` lives on `cause`, not on the thrown error itself. Walk the chain
 * rather than checking only the top level — a top-level-only check silently
 * never matches, which is worse than not having the guard at all.
 */
function isMissingTable(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: string }).code === UNDEFINED_TABLE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Resolve a `co_<slug>` entity key to a loader, or null when the object
 * doesn't exist or has search switched off.
 *
 * The `enableSearch` check lives here rather than at the call site so every
 * path — incremental indexing, backfill, reindex — honours it identically.
 * Turning search off for an object stops new indexing; existing rows are
 * cleared by the caller.
 */
export async function getCustomObjectLoader(
  db: Database,
  entityKey: string,
): Promise<CustomObjectDocumentLoader | null> {
  try {
    const object = await getCustomObjectByEntityKey(db, entityKey);
    if (!object || !object.enableSearch) return null;
    return buildCustomObjectLoader(object);
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** Entity keys of every object currently opted into search — drives backfill. */
export async function listSearchableCustomObjectKeys(db: Database): Promise<string[]> {
  try {
    const rows = await db
      .select({ entityKey: schema.customObjects.entityKey })
      .from(schema.customObjects)
      .where(
        and(
          eq(schema.customObjects.enableSearch, true),
          eq(schema.customObjects.status, 'active'),
          isNull(schema.customObjects.deletedAt),
        ),
      );
    return rows.map((r) => r.entityKey);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** Drop every index row for an object — used when `enableSearch` is switched off. */
export async function clearCustomObjectIndex(db: Database, entityKey: string): Promise<void> {
  await db.delete(schema.searchIndex).where(eq(schema.searchIndex.entityType, entityKey));
}

/**
 * Attach object labels and record hrefs to search hits whose entity type is a
 * custom object, so results render as "Machines · CNC-4100" rather than an
 * opaque `co_machine`.
 */
export async function decorateCustomObjectHits(
  db: Database,
  hits: Array<{ entityType: string; entityId: string }>,
): Promise<Record<string, { label: string; slug: string }>> {
  const keys = [...new Set(hits.map((h) => h.entityType).filter((t) => t.startsWith('co_')))];
  if (keys.length === 0) return {};

  const rows = await db
    .select({
      entityKey: schema.customObjects.entityKey,
      slug: schema.customObjects.slug,
      labelSingular: schema.customObjects.labelSingular,
    })
    .from(schema.customObjects)
    .where(
      and(
        inArray(schema.customObjects.entityKey, keys),
        isNull(schema.customObjects.deletedAt),
      ),
    );

  const out: Record<string, { label: string; slug: string }> = {};
  for (const row of rows) {
    out[row.entityKey] = { label: row.labelSingular, slug: row.slug };
  }
  return out;
}
