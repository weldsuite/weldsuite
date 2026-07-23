/**
 * WeldData service — lists of saved external leads + conversion into CRM.
 *
 * Pure business logic; no Hono context. Saved leads are snapshots of external
 * (Lemlist) database rows and live only in the `welddata_*` tables until the
 * user explicitly converts one — at which point we materialise a real CRM
 * `people` / `companies` record via the existing CRM services.
 */

import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { createCompany } from './companies';
import { createPerson } from './people';
import type {
  AddLeadsInput,
  CreateColumnInput,
  CreateWelddataListInput,
  ListLeadsQuery,
  ListWelddataListsQuery,
  UpdateColumnInput,
  UpdateWelddataListInput,
} from '@weldsuite/app-api-client/schemas/welddata';

type ListRow = typeof schema.welddataLists.$inferSelect;
type LeadRow = typeof schema.welddataLeads.$inferSelect;
type ColumnRow = typeof schema.welddataColumns.$inferSelect;
type CellRow = typeof schema.welddataCells.$inferSelect;

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export interface WelddataListWithCount extends ListRow {
  leadCount: number;
}

export async function listLists(
  db: Database,
  params: ListWelddataListsQuery,
): Promise<ListResult<WelddataListWithCount>> {
  const { welddataLists, welddataLeads } = schema;
  const limit = Math.min(params.limit ?? 50, 100);

  const conditions: SQL[] = [isNull(welddataLists.deletedAt)];
  if (params.search) conditions.push(ilike(welddataLists.name, `%${params.search}%`));

  const filterOnly = and(...conditions);
  const paged = [...conditions];

  if (params.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: welddataLists.createdAt, id: welddataLists.id })
      .from(welddataLists)
      .where(eq(welddataLists.id, params.cursor))
      .limit(1);
    if (cursorRow) {
      paged.push(
        sql`(${welddataLists.createdAt} < ${cursorRow.createdAt} OR (${welddataLists.createdAt} = ${cursorRow.createdAt} AND ${welddataLists.id} < ${cursorRow.id}))`,
      );
    }
  }

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(welddataLists)
      .where(and(...paged))
      .orderBy(desc(welddataLists.createdAt), desc(welddataLists.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(welddataLists).where(filterOnly),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  // Attach non-deleted lead counts for the page in one grouped query.
  const ids = data.map((r) => r.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const countRows = await db
      .select({ listId: welddataLeads.listId, count: sql<number>`count(*)::int` })
      .from(welddataLeads)
      .where(and(inArray(welddataLeads.listId, ids), isNull(welddataLeads.deletedAt)))
      .groupBy(welddataLeads.listId);
    for (const r of countRows) counts.set(r.listId, Number(r.count));
  }

  return {
    data: data.map((r) => ({ ...r, leadCount: counts.get(r.id) ?? 0 })),
    totalCount: Number(countResult[0]?.count ?? 0),
    hasMore,
    cursor: hasMore && data.length > 0 ? data[data.length - 1]!.id : null,
  };
}

export async function getList(db: Database, id: string): Promise<WelddataListWithCount | null> {
  const { welddataLists, welddataLeads } = schema;
  const [row] = await db
    .select()
    .from(welddataLists)
    .where(and(eq(welddataLists.id, id), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!row) return null;
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(welddataLeads)
    .where(and(eq(welddataLeads.listId, id), isNull(welddataLeads.deletedAt)));
  return { ...row, leadCount: Number(count ?? 0) };
}

export async function createList(
  db: Database,
  input: CreateWelddataListInput,
  createdBy?: string,
): Promise<ListRow> {
  const { welddataLists } = schema;
  const id = generateId('wdlist');
  const now = new Date();
  await db.insert(welddataLists).values({
    id,
    createdAt: now,
    updatedAt: now,
    kind: input.kind ?? 'person',
    name: input.name,
    description: input.description ?? null,
    color: input.color ?? 'bg-blue-500',
    icon: input.icon ?? 'Database',
    createdBy: createdBy ?? null,
  });
  const [row] = await db.select().from(welddataLists).where(eq(welddataLists.id, id)).limit(1);
  if (!row) throw new Error('List disappeared after insert');
  return row;
}

export async function updateList(
  db: Database,
  id: string,
  input: UpdateWelddataListInput,
): Promise<ListRow | null> {
  const { welddataLists } = schema;
  const [existing] = await db
    .select({ id: welddataLists.id })
    .from(welddataLists)
    .where(and(eq(welddataLists.id, id), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) updates[k] = v;
  await db.update(welddataLists).set(updates).where(eq(welddataLists.id, id));
  const [row] = await db.select().from(welddataLists).where(eq(welddataLists.id, id)).limit(1);
  return row ?? null;
}

export async function deleteList(db: Database, id: string): Promise<boolean> {
  const { welddataLists, welddataLeads } = schema;
  const [existing] = await db
    .select({ id: welddataLists.id })
    .from(welddataLists)
    .where(and(eq(welddataLists.id, id), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!existing) return false;
  const now = new Date();
  await db.update(welddataLists).set({ deletedAt: now, updatedAt: now }).where(eq(welddataLists.id, id));
  // Soft-delete the list's leads too so counts stay consistent.
  await db
    .update(welddataLeads)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(welddataLeads.listId, id), isNull(welddataLeads.deletedAt)));
  return true;
}

// ---------------------------------------------------------------------------
// Saved leads
// ---------------------------------------------------------------------------

export interface AddLeadsResult {
  added: number;
  skipped: number;
}

/** Bulk-insert saved leads into a list. Duplicates (same listId+kind+lemlistId)
 * are ignored via the unique index. */
export async function addLeads(
  db: Database,
  listId: string,
  input: AddLeadsInput,
  addedBy?: string,
): Promise<AddLeadsResult | null> {
  const { welddataLists, welddataLeads } = schema;
  const [listRow] = await db
    .select({ id: welddataLists.id, kind: welddataLists.kind })
    .from(welddataLists)
    .where(and(eq(welddataLists.id, listId), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!listRow) return null;

  // A list only holds one kind — leads of the other kind are rejected (counted
  // as skipped) so person/company are never mixed.
  const matching = input.leads.filter((lead) => lead.kind === listRow.kind);
  const mismatched = input.leads.length - matching.length;
  if (matching.length === 0) {
    return { added: 0, skipped: input.leads.length };
  }

  const now = new Date();
  const values = matching.map((lead) => ({
    id: generateId('wdlead'),
    createdAt: now,
    updatedAt: now,
    listId,
    addedBy: addedBy ?? null,
    kind: lead.kind,
    lemlistId: lead.lemlistId ?? null,
    data: lead.data ?? null,
    name: lead.name ?? null,
    email: lead.email ?? null,
    title: lead.title ?? null,
    companyName: lead.companyName ?? null,
    domain: lead.domain ?? null,
    industry: lead.industry ?? null,
    location: lead.location ?? null,
    country: lead.country ?? null,
    companySize: lead.companySize ?? null,
    linkedinUrl: lead.linkedinUrl ?? null,
    convertedStatus: 'pending' as const,
  }));

  const inserted = await db
    .insert(welddataLeads)
    .values(values)
    .onConflictDoNothing({
      target: [welddataLeads.listId, welddataLeads.kind, welddataLeads.lemlistId],
    })
    .returning({ id: welddataLeads.id });

  return { added: inserted.length, skipped: values.length - inserted.length + mismatched };
}

export async function listLeads(
  db: Database,
  listId: string,
  params: ListLeadsQuery,
): Promise<ListResult<LeadRow> | null> {
  const { welddataLists, welddataLeads } = schema;
  const [listRow] = await db
    .select({ id: welddataLists.id })
    .from(welddataLists)
    .where(and(eq(welddataLists.id, listId), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!listRow) return null;

  const limit = Math.min(params.limit ?? 50, 100);
  const conditions: SQL[] = [eq(welddataLeads.listId, listId), isNull(welddataLeads.deletedAt)];
  if (params.kind) conditions.push(eq(welddataLeads.kind, params.kind));
  if (params.convertedStatus) conditions.push(eq(welddataLeads.convertedStatus, params.convertedStatus));
  if (params.search) {
    const term = `%${params.search}%`;
    conditions.push(
      or(
        ilike(welddataLeads.name, term),
        ilike(welddataLeads.email, term),
        ilike(welddataLeads.companyName, term),
      )!,
    );
  }

  const filterOnly = and(...conditions);
  const paged = [...conditions];
  if (params.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: welddataLeads.createdAt, id: welddataLeads.id })
      .from(welddataLeads)
      .where(eq(welddataLeads.id, params.cursor))
      .limit(1);
    if (cursorRow) {
      paged.push(
        sql`(${welddataLeads.createdAt} < ${cursorRow.createdAt} OR (${welddataLeads.createdAt} = ${cursorRow.createdAt} AND ${welddataLeads.id} < ${cursorRow.id}))`,
      );
    }
  }

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(welddataLeads)
      .where(and(...paged))
      .orderBy(desc(welddataLeads.createdAt), desc(welddataLeads.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(welddataLeads).where(filterOnly),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    totalCount: Number(countResult[0]?.count ?? 0),
    hasMore,
    cursor: hasMore && data.length > 0 ? data[data.length - 1]!.id : null,
  };
}

export async function getLead(db: Database, id: string): Promise<LeadRow | null> {
  const { welddataLeads } = schema;
  const [row] = await db
    .select()
    .from(welddataLeads)
    .where(and(eq(welddataLeads.id, id), isNull(welddataLeads.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function removeLead(db: Database, id: string): Promise<boolean> {
  const { welddataLeads } = schema;
  const [existing] = await db
    .select({ id: welddataLeads.id })
    .from(welddataLeads)
    .where(and(eq(welddataLeads.id, id), isNull(welddataLeads.deletedAt)))
    .limit(1);
  if (!existing) return false;
  await db
    .update(welddataLeads)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(welddataLeads.id, id));
  return true;
}

// ---------------------------------------------------------------------------
// Conversion into CRM
// ---------------------------------------------------------------------------

/** Split a "Full Name" into first/last for CRM creation. */
function splitName(name?: string | null): { firstName?: string; lastName?: string } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return {};
  const [first = '', ...rest] = trimmed.split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') || undefined };
}

/** Find an existing (non-deleted) company by case-insensitive name, else create one. */
async function findOrCreateCompany(
  db: Database,
  args: { name: string; website?: string | null; industry?: string | null; linkedinUrl?: string | null; ownerId?: string },
): Promise<{ id: string; created: boolean }> {
  const { companies } = schema;
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(sql`LOWER(${companies.name}) = ${args.name.toLowerCase()}`, isNull(companies.deletedAt)))
    .limit(1);
  if (existing) return { id: existing.id, created: false };

  const company = await createCompany(db, {
    name: args.name,
    website: args.website ?? undefined,
    industry: args.industry ?? undefined,
    linkedinUrl: args.linkedinUrl ?? undefined,
    ownerId: args.ownerId,
    isLead: true,
    source: 'welddata/lemlist',
  });
  return { id: company.id, created: true };
}

export interface ConvertResult {
  leadId: string;
  personId: string | null;
  companyId: string | null;
  createdPerson: boolean;
  createdCompany: boolean;
  /** True when the lead was already converted — a no-op. */
  alreadyConverted: boolean;
}

/** Minimal lead shape needed to materialise into CRM — satisfied by both a
 * saved `LeadRow` (whose `kind` column is a plain string) and an inline
 * search-result row (`SavedLeadInput`). Anything other than `'company'` is
 * treated as a person. */
export interface ConvertibleLead {
  kind: string;
  name?: string | null;
  email?: string | null;
  title?: string | null;
  companyName?: string | null;
  domain?: string | null;
  industry?: string | null;
  linkedinUrl?: string | null;
}

export interface MaterialiseResult {
  personId: string | null;
  companyId: string | null;
  createdPerson: boolean;
  createdCompany: boolean;
}

/**
 * Materialise a lead into CRM — find-or-create the company, create the person,
 * and link them — without touching any WeldData list row. Shared by both the
 * saved-lead `convertLead` flow and the search-grid "Convert to CRM" action
 * (where the lead was never persisted to a list).
 */
export async function convertSearchLead(
  db: Database,
  lead: ConvertibleLead,
  opts: { createCompany: boolean; ownerId?: string },
): Promise<MaterialiseResult> {
  let personId: string | null = null;
  let companyId: string | null = null;
  let createdPerson = false;
  let createdCompany = false;

  if (lead.kind === 'company') {
    const name = lead.companyName || lead.name;
    if (!name) throw new Error('Company lead has no name to convert');
    const result = await findOrCreateCompany(db, {
      name,
      website: lead.domain,
      industry: lead.industry,
      linkedinUrl: lead.linkedinUrl,
      ownerId: opts.ownerId,
    });
    companyId = result.id;
    createdCompany = result.created;
  } else {
    // Person lead.
    if (opts.createCompany && lead.companyName) {
      const result = await findOrCreateCompany(db, {
        name: lead.companyName,
        website: lead.domain,
        industry: lead.industry,
        ownerId: opts.ownerId,
      });
      companyId = result.id;
      createdCompany = result.created;
    }

    const { firstName, lastName } = splitName(lead.name);
    const person = await createPerson(db, {
      firstName,
      lastName,
      email: lead.email || undefined,
      title: lead.title || undefined,
      linkedinUrl: lead.linkedinUrl || undefined,
      ownerId: opts.ownerId,
      isLead: true,
      source: 'welddata/lemlist',
      ...(companyId ? { companyIds: [companyId], primaryCompanyId: companyId } : {}),
    });
    personId = person.id;
    createdPerson = true;
  }

  return { personId, companyId, createdPerson, createdCompany };
}

/**
 * Materialise a saved lead into CRM. Idempotent: an already-converted lead is
 * returned unchanged. Company leads create a `companies` row; person leads
 * create a `people` row and (when `createCompany`) find-or-create + link the
 * company via `person_companies` (handled by `createPerson`'s companyIds).
 */
export async function convertLead(
  db: Database,
  lead: LeadRow,
  opts: { createCompany: boolean; ownerId?: string },
): Promise<ConvertResult> {
  const { welddataLeads } = schema;

  if (lead.convertedStatus === 'converted') {
    return {
      leadId: lead.id,
      personId: lead.convertedPersonId,
      companyId: lead.convertedCompanyId,
      createdPerson: false,
      createdCompany: false,
      alreadyConverted: true,
    };
  }

  const { personId, companyId, createdPerson, createdCompany } = await convertSearchLead(
    db,
    lead,
    opts,
  );

  await db
    .update(welddataLeads)
    .set({
      convertedStatus: 'converted',
      convertedAt: new Date(),
      convertedPersonId: personId,
      convertedCompanyId: companyId,
      updatedAt: new Date(),
    })
    .where(eq(welddataLeads.id, lead.id));

  return { leadId: lead.id, personId, companyId, createdPerson, createdCompany, alreadyConverted: false };
}

/**
 * The set of Lemlist ids already saved in the given WeldData lists. Used to
 * filter already-saved leads out of a fresh database search. Empty input or no
 * matches yields an empty set.
 */
export async function getSavedLemlistIds(
  db: Database,
  listIds: string[],
): Promise<Set<string>> {
  const ids = Array.from(new Set(listIds)).filter(Boolean);
  if (ids.length === 0) return new Set();
  const { welddataLeads } = schema;
  const rows = await db
    .select({ lemlistId: welddataLeads.lemlistId })
    .from(welddataLeads)
    .where(
      and(
        inArray(welddataLeads.listId, ids),
        isNotNull(welddataLeads.lemlistId),
        isNull(welddataLeads.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.lemlistId).filter((v): v is string => Boolean(v)));
}

// ---------------------------------------------------------------------------
// CRM list membership (add converted leads to an existing CRM list)
// ---------------------------------------------------------------------------

/** Look up a CRM list (the `lists` table) by id, returning its kind. */
export async function getCrmList(
  db: Database,
  id: string,
): Promise<{ id: string; kind: string } | null> {
  const { lists } = schema;
  const [row] = await db
    .select({ id: lists.id, kind: lists.kind })
    .from(lists)
    .where(and(eq(lists.id, id), isNull(lists.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Add CRM entity ids to a CRM list's membership. Idempotent — ids already on
 * the list are skipped. Returns the number of rows actually inserted.
 */
export async function addCrmListMembers(
  db: Database,
  listId: string,
  entityIds: string[],
): Promise<number> {
  const { listMembers } = schema;
  const deduped = Array.from(new Set(entityIds));
  if (deduped.length === 0) return 0;

  const existing = await db
    .select({ entityId: listMembers.entityId })
    .from(listMembers)
    .where(and(eq(listMembers.listId, listId), inArray(listMembers.entityId, deduped)));
  const existingSet = new Set(existing.map((r) => r.entityId));
  const toAdd = deduped.filter((eid) => !existingSet.has(eid));
  if (toAdd.length === 0) return 0;

  await db.insert(listMembers).values(
    toAdd.map((entityId) => ({
      id: generateId('lm'),
      listId,
      entityId,
      addedAt: new Date(),
    })),
  );
  return toAdd.length;
}

// ---------------------------------------------------------------------------
// Enrichment columns + cells
// ---------------------------------------------------------------------------

export async function listColumns(db: Database, listId: string): Promise<ColumnRow[]> {
  const { welddataColumns } = schema;
  return db
    .select()
    .from(welddataColumns)
    .where(and(eq(welddataColumns.listId, listId), isNull(welddataColumns.deletedAt)))
    .orderBy(welddataColumns.sortOrder, welddataColumns.createdAt);
}

export async function getColumn(db: Database, id: string): Promise<ColumnRow | null> {
  const { welddataColumns } = schema;
  const [row] = await db
    .select()
    .from(welddataColumns)
    .where(and(eq(welddataColumns.id, id), isNull(welddataColumns.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createColumn(
  db: Database,
  listId: string,
  input: CreateColumnInput,
  createdBy?: string,
): Promise<ColumnRow | null> {
  const { welddataLists, welddataColumns } = schema;
  const [listRow] = await db
    .select({ id: welddataLists.id })
    .from(welddataLists)
    .where(and(eq(welddataLists.id, listId), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!listRow) return null;

  const [{ max } = { max: -1 }] = await db
    .select({ max: sql<number>`coalesce(max(${welddataColumns.sortOrder}), -1)` })
    .from(welddataColumns)
    .where(and(eq(welddataColumns.listId, listId), isNull(welddataColumns.deletedAt)));

  const id = generateId('wdcol');
  const now = new Date();
  await db.insert(welddataColumns).values({
    id,
    createdAt: now,
    updatedAt: now,
    listId,
    name: input.name,
    type: input.config.type,
    config: input.config as unknown as Record<string, unknown>,
    sortOrder: Number(max ?? -1) + 1,
    createdBy: createdBy ?? null,
  });
  return getColumn(db, id);
}

export async function updateColumn(
  db: Database,
  id: string,
  input: UpdateColumnInput,
): Promise<ColumnRow | null> {
  const { welddataColumns } = schema;
  const existing = await getColumn(db, id);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
  if (input.config !== undefined) {
    updates.config = input.config as unknown as Record<string, unknown>;
    updates.type = input.config.type;
  }
  await db.update(welddataColumns).set(updates).where(eq(welddataColumns.id, id));
  return getColumn(db, id);
}

export async function deleteColumn(db: Database, id: string): Promise<boolean> {
  const { welddataColumns, welddataCells } = schema;
  const existing = await getColumn(db, id);
  if (!existing) return false;
  const now = new Date();
  await db.update(welddataColumns).set({ deletedAt: now, updatedAt: now }).where(eq(welddataColumns.id, id));
  // Cells are meaningless without their column — hard-delete them.
  await db.delete(welddataCells).where(eq(welddataCells.columnId, id));
  return true;
}

/** Every cell belonging to the (non-deleted) columns of a list. */
/**
 * Cells left in `running` past this age are treated as dead. The enrichment
 * workflow flips a cell to `running`, runs its action, then flips it to
 * `done`/`error`. If the Worker isolate is evicted mid-action (CPU/duration
 * limit, deploy, OOM) that final write never happens and the cell spins
 * forever. Anything still `running` this long after its last update is
 * therefore an orphan, not live work (the slowest single action — a web-search
 * fallback — is well under a minute).
 */
export const STUCK_RUNNING_MS = 10 * 60 * 1000;

/**
 * Reconcile orphaned `running` cells → `error` so the grid stops spinning and
 * they become re-runnable. Scope by `columnId` or `listId`; an unscoped call is
 * a no-op (we never sweep the whole tenant blindly). Best-effort by design.
 */
export async function reclaimStuckRunningCells(
  db: Database,
  opts: { columnId?: string; listId?: string; cutoffMs?: number },
): Promise<void> {
  const { welddataColumns, welddataCells } = schema;
  const cutoff = new Date(Date.now() - (opts.cutoffMs ?? STUCK_RUNNING_MS));
  const conds = [eq(welddataCells.status, 'running'), lt(welddataCells.updatedAt, cutoff)];

  if (opts.columnId) {
    conds.push(eq(welddataCells.columnId, opts.columnId));
  } else if (opts.listId) {
    const cols = await db
      .select({ id: welddataColumns.id })
      .from(welddataColumns)
      .where(and(eq(welddataColumns.listId, opts.listId), isNull(welddataColumns.deletedAt)));
    if (cols.length === 0) return;
    conds.push(inArray(welddataCells.columnId, cols.map((c) => c.id)));
  } else {
    return;
  }

  await db
    .update(welddataCells)
    .set({ status: 'error', error: 'Timed out — please re-run.', updatedAt: new Date() })
    .where(and(...conds));
}

export async function listCells(db: Database, listId: string): Promise<CellRow[]> {
  const { welddataColumns, welddataCells } = schema;
  // Self-heal orphaned `running` cells before reading, so a stuck spinner
  // resolves itself on the next grid refresh instead of hanging indefinitely.
  await reclaimStuckRunningCells(db, { listId }).catch(() => {});
  const cols = await db
    .select({ id: welddataColumns.id })
    .from(welddataColumns)
    .where(and(eq(welddataColumns.listId, listId), isNull(welddataColumns.deletedAt)));
  if (cols.length === 0) return [];
  return db
    .select()
    .from(welddataCells)
    .where(inArray(welddataCells.columnId, cols.map((c) => c.id)));
}

/**
 * Resolve which leads a column run targets: explicit `leadIds`, else all
 * non-deleted leads in the list. `onlyMissing` drops leads that already have a
 * non-error cell for the column.
 */
export async function resolveTargetLeadIds(
  db: Database,
  listId: string,
  columnId: string,
  opts: { leadIds?: string[]; onlyMissing?: boolean },
): Promise<string[]> {
  const { welddataLeads, welddataCells } = schema;
  let ids = opts.leadIds;
  if (!ids || ids.length === 0) {
    const rows = await db
      .select({ id: welddataLeads.id })
      .from(welddataLeads)
      .where(and(eq(welddataLeads.listId, listId), isNull(welddataLeads.deletedAt)));
    ids = rows.map((r) => r.id);
  }
  if (opts.onlyMissing && ids.length > 0) {
    const done = await db
      .select({ leadId: welddataCells.leadId })
      .from(welddataCells)
      .where(and(eq(welddataCells.columnId, columnId), eq(welddataCells.status, 'done')));
    const doneSet = new Set(done.map((d) => d.leadId));
    ids = ids.filter((id) => !doneSet.has(id));
  }
  return ids;
}

/** Upsert cells to `pending` so the grid shows queued state immediately. */
export async function markCellsPending(
  db: Database,
  columnId: string,
  leadIds: string[],
): Promise<void> {
  if (leadIds.length === 0) return;
  const { welddataCells } = schema;
  const now = new Date();
  const values = leadIds.map((leadId) => ({
    id: generateId('wdcell'),
    createdAt: now,
    updatedAt: now,
    columnId,
    leadId,
    status: 'pending' as const,
  }));
  // Chunk to stay well under parameter limits on large lists.
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(welddataCells)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [welddataCells.columnId, welddataCells.leadId],
        set: { status: 'pending', error: null, updatedAt: now },
      });
  }
}
