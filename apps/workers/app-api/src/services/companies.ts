/**
 * Companies service — identity layer for organisations.
 *
 * Pure business logic; no Hono context. Stamps `displayName` on every
 * write so renderers can read one column without branching on type.
 *
 * Supplier is a status flag on this row, not a separate entity. The
 * wrapping Party row (for billing/commercial fields) is lazily created
 * the first time the company is flagged isSupplier — that's the
 * dual-write compat shim that keeps the legacy api-worker
 * `/crm/customers` and `/crm/contacts` routes returning populated rows.
 */

import { eq, and, desc, isNull, like, or, sql, inArray, type SQL } from 'drizzle-orm';
import { computeChanges } from '@weldsuite/entity-events';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
  getDefinitionsForEntityType,
} from './custom-field-values';
import {
  parseCustomFieldKey,
  customFieldOrderBy,
  customFieldFilter,
} from './custom-field-query';
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
  ListCompaniesQuery,
  ImportCompanyRecord,
  ExportCompaniesQuery,
} from '@weldsuite/app-api-client/schemas/companies';

type CompanyRow = typeof schema.companies.$inferSelect;

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export function deriveDisplayName(input: {
  name?: string | null;
  tradingName?: string | null;
}): string {
  return input.tradingName?.trim() || input.name?.trim() || 'Unnamed Company';
}

/**
 * Lazily create or update the wrapping `parties` row when this company is
 * flagged as a supplier. Writes only the wrapper columns —
 * `displayName`/`role`/`partyCode`/`billingAddress`/accounting fields. The
 * legacy identity columns (`companyName`, `email`, `phone`, etc.) live on
 * the `companies` table; the wrapping party row joins to it via
 * `parties.companyId`.
 */
async function ensureWrappingParty(db: Database, company: CompanyRow): Promise<void> {
  const { parties } = schema;
  if (!company.isSupplier) return;

  const [existing] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(eq(parties.companyId, company.id))
    .limit(1);

  const wrapperFields = {
    role: 'supplier' as const,
    displayName: company.displayName,
    partyCode: company.partyCode,
    billingAddress: company.primaryAddress,
    archivedAt: company.archivedAt,
  };

  if (existing) {
    await db
      .update(parties)
      .set({ ...wrapperFields, updatedAt: new Date() })
      .where(eq(parties.id, existing.id));
    return;
  }

  await db.insert(parties).values({
    id: generateId('party'),
    kind: 'company',
    companyId: company.id,
    ...wrapperFields,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Shared filter fields for list + export. */
type CompanyFilter = Pick<
  ListCompaniesQuery,
  | 'search'
  | 'status'
  | 'ownerId'
  | 'industry'
  | 'isSupplier'
  | 'isLead'
  | 'listId'
  | 'customFilter'
>;

/**
 * Build the base WHERE conditions shared by `listCompanies` and
 * `exportCompanies`. Returns `null` when the filter can only ever match zero
 * rows (e.g. a list of the wrong kind or with no members) so callers can
 * short-circuit.
 *
 * @param ownerScope - when set, restrict results to rows owned by this userId
 *   (callers without `companies:scope:all` pass their own userId here).
 */
async function buildCompanyConditions(
  db: Database,
  params: CompanyFilter,
  ownerScope?: string,
): Promise<SQL[] | null> {
  const { companies, lists, listMembers } = schema;
  const conditions: SQL[] = [isNull(companies.deletedAt)];

  if (ownerScope) conditions.push(eq(companies.ownerId, ownerScope));

  if (params.search) {
    const term = `%${params.search}%`;
    conditions.push(
      or(
        like(companies.displayName, term),
        like(companies.name, term),
        like(companies.tradingName, term),
        like(companies.email, term),
        like(companies.vatNumber, term),
      )!,
    );
  }
  if (params.status) conditions.push(eq(companies.status, params.status));
  if (params.ownerId) conditions.push(eq(companies.ownerId, params.ownerId));
  if (params.industry) conditions.push(eq(companies.industry, params.industry));
  if (params.isSupplier !== undefined) conditions.push(eq(companies.isSupplier, params.isSupplier));
  if (params.isLead !== undefined) conditions.push(eq(companies.isLead, params.isLead));

  // List-membership filter — only kind='company' lists target companies.
  // Mismatched kind returns empty as defence in depth.
  if (params.listId) {
    const [listRow] = await db
      .select({ kind: lists.kind })
      .from(lists)
      .where(and(eq(lists.id, params.listId), isNull(lists.deletedAt)))
      .limit(1);
    if (!listRow || listRow.kind !== 'company') return null;
    const memberRows = await db
      .select({ entityId: listMembers.entityId })
      .from(listMembers)
      .where(eq(listMembers.listId, params.listId));
    if (memberRows.length === 0) return null;
    conditions.push(
      inArray(
        companies.id,
        memberRows.map((m) => m.entityId),
      ),
    );
  }

  // Custom-field filter (`customFilter=<slug>:<value>`). Applied here rather
  // than in listCompanies so /export honours the same filter as the grid.
  if (params.customFilter) {
    const sep = params.customFilter.indexOf(':');
    if (sep <= 0) return null;
    const slug = params.customFilter.slice(0, sep);
    const value = params.customFilter.slice(sep + 1);

    const defs = await getDefinitionsForEntityType(db, 'company');
    const def = defs.find((d) => d.slug === slug);
    // Unknown field, or a value that can't be coerced to the field's type:
    // match nothing. Dropping the filter instead would WIDEN the result set,
    // which is the opposite of what the caller asked for.
    if (!def) return null;
    const fragment = customFieldFilter(
      'company',
      companies.id,
      def as unknown as Parameters<typeof customFieldFilter>[2],
      value,
    );
    if (!fragment) return null;
    conditions.push(fragment);
  }

  return conditions;
}

/**
 * Resolve a `custom:<slug>` sort key to its definition, or null when the key
 * isn't a custom field / the field doesn't exist.
 */
async function resolveCustomSort(db: Database, sort: string | undefined) {
  const slug = parseCustomFieldKey(sort);
  if (!slug) return null;
  const defs = await getDefinitionsForEntityType(db, 'company');
  return defs.find((d) => d.slug === slug) ?? null;
}

export async function listCompanies(
  db: Database,
  params: ListCompaniesQuery,
  ownerScope?: string,
): Promise<ListResult<CompanyRow>> {
  const { companies } = schema;
  const limit = Math.min(params.limit ?? 25, 100);

  const base = await buildCompanyConditions(db, params, ownerScope);
  if (!base) return { data: [], totalCount: 0, hasMore: false, cursor: null };
  const conditions = [...base];

  const filterOnly = and(...conditions);

  // Sorting by a custom field invalidates the keyset cursor, which is keyed on
  // (createdAt, id) — those columns no longer describe the row order. Fall back
  // to OFFSET paging for custom sorts only, so the default path keeps its
  // keyset performance. `cursor` carries the numeric offset in this mode, which
  // keeps the response envelope identical for callers.
  const customSort = await resolveCustomSort(db, params.sort);

  if (customSort) {
    const offset = params.cursor ? Math.max(0, Number.parseInt(params.cursor, 10) || 0) : 0;
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(companies)
        .where(filterOnly)
        .orderBy(
          customFieldOrderBy(
            'company',
            companies.id,
            customSort as unknown as Parameters<typeof customFieldOrderBy>[2],
            params.sortDir ?? 'asc',
          ),
          // Stable tie-break: rows sharing a value (or both null) keep a
          // deterministic order across pages, otherwise OFFSET can repeat or
          // skip rows between requests.
          desc(companies.id),
        )
        .limit(limit + 1)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(companies).where(filterOnly),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return {
      data: await hydrateCustomFields(db, 'company', data),
      totalCount: Number(countResult[0]?.count ?? 0),
      hasMore,
      cursor: hasMore ? String(offset + limit) : null,
    };
  }

  if (params.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: companies.createdAt, id: companies.id })
      .from(companies)
      .where(eq(companies.id, params.cursor))
      .limit(1);
    if (cursorRow) {
      conditions.push(
        sql`(${companies.createdAt} < ${cursorRow.createdAt} OR (${companies.createdAt} = ${cursorRow.createdAt} AND ${companies.id} < ${cursorRow.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(companies)
      .where(where)
      .orderBy(desc(companies.createdAt), desc(companies.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(companies).where(filterOnly),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  return {
    // Phase 3: customFields comes from the typed values table, not the blob.
    data: await hydrateCustomFields(db, 'company', data),
    totalCount: Number(countResult[0]?.count ?? 0),
    hasMore,
    cursor: nextCursor,
  };
}

/** Hard ceiling on a single export so a runaway tenant can't OOM the worker. */
const EXPORT_ROW_LIMIT = 50_000;

/**
 * Every company matching `filter` (no pagination), newest first. Used by the
 * `/export` endpoint; the client renders the rows to CSV/XLSX.
 *
 * @param ownerScope - when set, restrict results to rows owned by this userId.
 */
export async function exportCompanies(
  db: Database,
  filter: ExportCompaniesQuery,
  ownerScope?: string,
): Promise<CompanyRow[]> {
  const { companies } = schema;
  const base = await buildCompanyConditions(db, filter, ownerScope);
  if (!base) return [];
  const rows = await db
    .select()
    .from(companies)
    .where(and(...base))
    .orderBy(desc(companies.createdAt), desc(companies.id))
    .limit(EXPORT_ROW_LIMIT);
  return hydrateCustomFields(db, 'company', rows);
}

export async function getCompany(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<CompanyRow | null> {
  const { companies } = schema;
  const conditions: SQL[] = [eq(companies.id, id), isNull(companies.deletedAt)];
  if (ownerScope) conditions.push(eq(companies.ownerId, ownerScope));
  const [row] = await db
    .select()
    .from(companies)
    .where(and(...conditions))
    .limit(1);
  return hydrateCustomFieldsOne(db, 'company', row ?? null);
}

/**
 * Insert a company row. Shared by `createCompany` and the importer; the
 * importer additionally supplies `partyCode` (the upsert key), which the
 * normal create surface never sets.
 */
async function insertCompanyRow(
  db: Database,
  input: CreateCompanyInput & { partyCode?: string | null },
): Promise<CompanyRow> {
  const { companies } = schema;
  const id = generateId('company');
  const now = new Date();
  const displayName = deriveDisplayName(input);

  await db.insert(companies).values({
    id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    partyCode: input.partyCode?.trim() || null,
    name: input.name,
    tradingName: input.tradingName ?? null,
    displayName,
    registrationNumber: input.registrationNumber ?? null,
    vatNumber: input.vatNumber ?? null,
    industry: input.industry ?? null,
    employeeCount: input.employeeCount ?? null,
    website: input.website ?? null,
    email: input.email || null,
    alternateEmails: input.alternateEmails ?? null,
    phone: input.phone ?? null,
    mobile: input.mobile ?? null,
    fax: input.fax ?? null,
    primaryAddress: input.primaryAddress ?? null,
    addresses: input.addresses ?? null,
    avatarUrl: input.avatarUrl ?? null,
    linkedinUrl: input.linkedinUrl ?? null,
    twitterHandle: input.twitterHandle ?? null,
    facebookUrl: input.facebookUrl ?? null,
    ownerId: input.ownerId ?? null,
    accountManagerId: input.accountManagerId ?? null,
    status: input.status ?? 'prospect',
    lifecycleStage: input.lifecycleStage ?? null,
    segment: input.segment ?? null,
    rating: input.rating ?? null,
    source: input.source ?? null,
    isSupplier: input.isSupplier ?? false,
    isLead: input.isLead ?? false,
    isFavorite: input.isFavorite ?? false,
    preferredContactMethod: input.preferredContactMethod ?? null,
    preferredLanguage: input.preferredLanguage ?? null,
    timezone: input.timezone ?? null,
    marketingConsent: input.marketingConsent ?? false,
    emailOptIn: input.emailOptIn ?? false,
    smsOptIn: input.smsOptIn ?? false,
    doNotCall: input.doNotCall ?? false,
    tags: input.tags ?? null,
    customFields: input.customFields ?? null,
    notes: input.notes ?? null,
    internalNotes: input.internalNotes ?? null,
  });

  const created = await getCompany(db, id);
  if (!created) throw new Error('Company disappeared after insert');

  await ensureWrappingParty(db, created);

  return created;
}

export async function createCompany(
  db: Database,
  input: CreateCompanyInput,
): Promise<CompanyRow> {
  const created = await insertCompanyRow(db, input);
  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'company', created.id, input.customFields);
  return created;
}

export class CompanyVersionConflictError extends Error {
  readonly isConflict = true as const;
  constructor() {
    super('Company was modified by someone else; please reload.');
    this.name = 'CompanyVersionConflictError';
  }
}

export interface UpdateCompanyResult {
  row: CompanyRow;
  /** Per-field diff between before/after, or null when nothing changed. */
  changes: Record<string, { old: unknown; new: unknown }> | null;
}

export async function updateCompany(
  db: Database,
  id: string,
  input: UpdateCompanyInput,
  ownerScope?: string,
): Promise<UpdateCompanyResult | null> {
  const { companies } = schema;
  const fetchConditions: SQL[] = [eq(companies.id, id), isNull(companies.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(companies.ownerId, ownerScope));
  const [existing] = await db
    .select()
    .from(companies)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;

  if (input.ifVersion !== undefined && existing.version !== input.ifVersion) {
    throw new CompanyVersionConflictError();
  }

  const { ifVersion: _ignored, ...rest } = input;
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
    version: existing.version + 1,
  };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) updates[k] = v;

  if (rest.name !== undefined || rest.tradingName !== undefined) {
    updates.displayName = deriveDisplayName({
      name: rest.name ?? existing.name,
      tradingName: rest.tradingName ?? existing.tradingName,
    });
  }

  await db.update(companies).set(updates).where(eq(companies.id, id));

  const updated = await getCompany(db, id);
  if (!updated) return null;

  await ensureWrappingParty(db, updated);

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'company', id, rest.customFields);

  const changes = computeChanges(
    existing as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    ['updatedAt', 'version'],
  );

  return { row: updated, changes };
}

export interface ImportChangedRow {
  id: string;
  action: 'created' | 'updated';
  row: CompanyRow;
}

export interface ImportCompaniesResult {
  imported: number;
  updated: number;
  failed: number;
  total: number;
  errors: { row: number; ref: string; error: string }[];
  /** Created/updated rows so the route can emit one entity event each. */
  changedRows: ImportChangedRow[];
}

/**
 * Upsert a batch of companies. Each record is matched to an existing company
 * by `partyCode` first, then by case-insensitive `email`; matches are patched,
 * the rest are created (`name` required). Per-row failures are collected and
 * never abort the batch. The caller submits batches of ≤500.
 */
export async function importCompanies(
  db: Database,
  records: ImportCompanyRecord[],
): Promise<ImportCompaniesResult> {
  const { companies } = schema;
  const result: ImportCompaniesResult = {
    imported: 0,
    updated: 0,
    failed: 0,
    total: records.length,
    errors: [],
    changedRows: [],
  };

  const norm = (s?: string | null) => s?.trim() ?? '';
  const partyCodes = [...new Set(records.map((r) => norm(r.partyCode)).filter(Boolean))];
  const emails = [...new Set(records.map((r) => norm(r.email).toLowerCase()).filter(Boolean))];

  const byPartyCode = new Map<string, CompanyRow>();
  const byEmail = new Map<string, CompanyRow>();

  if (partyCodes.length) {
    const rows = await db
      .select()
      .from(companies)
      .where(and(isNull(companies.deletedAt), inArray(companies.partyCode, partyCodes)));
    for (const r of rows) if (r.partyCode) byPartyCode.set(r.partyCode, r);
  }
  if (emails.length) {
    const rows = await db
      .select()
      .from(companies)
      .where(
        and(
          isNull(companies.deletedAt),
          or(...emails.map((e) => sql`lower(${companies.email}) = ${e}`))!,
        ),
      );
    for (const r of rows) if (r.email) byEmail.set(r.email.toLowerCase(), r);
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const ref = norm(rec.partyCode) || norm(rec.email) || norm(rec.name) || `#${i + 1}`;
    try {
      const pc = norm(rec.partyCode);
      const em = norm(rec.email).toLowerCase();
      const match = (pc && byPartyCode.get(pc)) || (em && byEmail.get(em)) || null;

      if (match) {
        // Merge imported custom fields into the existing blob so a partial
        // import doesn't wipe custom fields the row already had (updateCompany
        // overwrites `customFields` wholesale — correct for the edit form, not
        // for an import that maps only some columns).
        const recForUpdate = rec.customFields
          ? {
              ...rec,
              customFields: {
                ...((match.customFields as Record<string, unknown> | null) ?? {}),
                ...rec.customFields,
              },
            }
          : rec;
        const updated = await updateCompany(
          db,
          match.id,
          recForUpdate as unknown as UpdateCompanyInput,
        );
        if (!updated) {
          result.failed++;
          result.errors.push({ row: i + 1, ref, error: 'Matched company no longer exists' });
          continue;
        }
        result.updated++;
        result.changedRows.push({ id: updated.row.id, action: 'updated', row: updated.row });
        if (updated.row.partyCode) byPartyCode.set(updated.row.partyCode, updated.row);
        if (updated.row.email) byEmail.set(updated.row.email.toLowerCase(), updated.row);
      } else {
        if (!norm(rec.name)) {
          result.failed++;
          result.errors.push({ row: i + 1, ref, error: 'Missing required field: name' });
          continue;
        }
        const created = await insertCompanyRow(
          db,
          rec as unknown as CreateCompanyInput & { partyCode?: string | null },
        );
        // Phase 1 dual-write: mirror the customFields blob into the typed values table.
        await syncValuesForEntity(db, 'company', created.id, created.customFields);
        result.imported++;
        result.changedRows.push({ id: created.id, action: 'created', row: created });
        if (created.partyCode) byPartyCode.set(created.partyCode, created);
        if (created.email) byEmail.set(created.email.toLowerCase(), created);
      }
    } catch (err) {
      result.failed++;
      result.errors.push({
        row: i + 1,
        ref,
        error: err instanceof Error ? err.message : 'Import failed',
      });
    }
  }

  return result;
}

export async function deleteCompany(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<boolean> {
  const { companies } = schema;
  const fetchConditions: SQL[] = [eq(companies.id, id), isNull(companies.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(companies.ownerId, ownerScope));
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return false;
  await db
    .update(companies)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(companies.id, id));
  return true;
}

export async function archiveCompany(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<CompanyRow | null> {
  const { companies } = schema;
  const fetchConditions: SQL[] = [eq(companies.id, id), isNull(companies.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(companies.ownerId, ownerScope));
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;
  await db
    .update(companies)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(companies.id, id));
  const updated = await getCompany(db, id);
  if (updated) await ensureWrappingParty(db, updated);
  return updated;
}

export async function unarchiveCompany(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<CompanyRow | null> {
  const { companies } = schema;
  const fetchConditions: SQL[] = [eq(companies.id, id), isNull(companies.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(companies.ownerId, ownerScope));
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;
  await db
    .update(companies)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(companies.id, id));
  const updated = await getCompany(db, id);
  if (updated) await ensureWrappingParty(db, updated);
  return updated;
}

/**
 * Every person linked to a company, enriched with the joined person's
 * displayName/email/avatar so the UI can render rows without an N+1
 * lookup. Drops rows whose person was soft-deleted — those can't be
 * opened and only confuse the user.
 *
 * @param ownerScope - when set, the company must be owned by this userId;
 *   returns empty array if the company doesn't belong to the scoped owner.
 */
export async function listCompanyPeople(
  db: Database,
  companyId: string,
  ownerScope?: string,
) {
  // Verify the caller is allowed to see this company under the owner scope.
  if (ownerScope) {
    const company = await getCompany(db, companyId, ownerScope);
    if (!company) return [];
  }
  const { personCompanies, people } = schema;
  const rows = await db
    .select({
      id: personCompanies.id,
      createdAt: personCompanies.createdAt,
      updatedAt: personCompanies.updatedAt,
      personId: personCompanies.personId,
      companyId: personCompanies.companyId,
      role: personCompanies.role,
      isPrimary: personCompanies.isPrimary,
      startedAt: personCompanies.startedAt,
      endedAt: personCompanies.endedAt,
      personDisplayName: people.displayName,
      personFirstName: people.firstName,
      personLastName: people.lastName,
      personEmail: people.email,
      personAvatarUrl: people.avatarUrl,
    })
    .from(personCompanies)
    .leftJoin(people, and(eq(people.id, personCompanies.personId), isNull(people.deletedAt)))
    .where(eq(personCompanies.companyId, companyId))
    .orderBy(desc(personCompanies.isPrimary), desc(personCompanies.createdAt));

  return rows
    .filter((r) => r.personDisplayName !== null)
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      personId: r.personId,
      companyId: r.companyId,
      role: r.role,
      isPrimary: r.isPrimary,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      person: {
        id: r.personId,
        displayName: r.personDisplayName!,
        firstName: r.personFirstName,
        lastName: r.personLastName,
        email: r.personEmail,
        avatarUrl: r.personAvatarUrl,
      },
    }));
}

export interface CompanyDetailOptions {
  activitiesLimit?: number;
  ordersLimit?: number;
  opportunitiesLimit?: number;
  peopleLimit?: number;
}

/**
 * Aggregate read for the company detail page — single round-trip that
 * fetches the company, its people, recent activities/orders/opportunities,
 * list memberships, and counts. Replaces the legacy
 * `GET /crm/customers/:id/detail`.
 *
 * Related rows (activities/orders/opportunities/invoices) link to the
 * company via its wrapping `parties` row (`counterparty_id` → `parties.id`,
 * `parties.company_id` → `companies.id`). Companies without a wrapping
 * party simply return empty arrays / zero counts for those sections.
 */
export async function getCompanyDetail(
  db: Database,
  companyId: string,
  options: CompanyDetailOptions = {},
  ownerScope?: string,
) {
  const activitiesLimit = Math.min(options.activitiesLimit ?? 10, 50);
  const ordersLimit = Math.min(options.ordersLimit ?? 10, 50);
  const opportunitiesLimit = Math.min(options.opportunitiesLimit ?? 10, 50);
  const peopleLimit = Math.min(options.peopleLimit ?? 20, 50);

  const { companies, parties, crmActivities, crmOpportunities, orders, lists, listMembers } = schema;

  const detailConditions: SQL[] = [eq(companies.id, companyId), isNull(companies.deletedAt)];
  if (ownerScope) detailConditions.push(eq(companies.ownerId, ownerScope));
  const [companyRow] = await db
    .select()
    .from(companies)
    .where(and(...detailConditions))
    .limit(1);
  if (!companyRow) return null;
  const company = (await hydrateCustomFieldsOne(db, 'company', companyRow))!;

  // Find the wrapping party row (when one exists). Required to filter the
  // counterparty-keyed tables (activities/orders/opportunities/invoices).
  const [wrappingParty] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), isNull(parties.deletedAt)))
    .limit(1);
  const partyId = wrappingParty?.id ?? null;

  const peoplePromise = listCompanyPeople(db, companyId).then((rows) =>
    rows.slice(0, peopleLimit),
  );

  const activitiesPromise = partyId
    ? db
        .select()
        .from(crmActivities)
        .where(
          and(
            eq(crmActivities.counterpartyId, partyId),
            isNull(crmActivities.deletedAt),
          ),
        )
        .orderBy(desc(crmActivities.createdAt))
        .limit(activitiesLimit)
    : Promise.resolve([] as Array<typeof crmActivities.$inferSelect>);

  const opportunitiesPromise = partyId
    ? db
        .select()
        .from(crmOpportunities)
        .where(
          and(
            eq(crmOpportunities.counterpartyId, partyId),
            isNull(crmOpportunities.deletedAt),
          ),
        )
        .orderBy(desc(crmOpportunities.createdAt))
        .limit(opportunitiesLimit)
    : Promise.resolve([] as Array<typeof crmOpportunities.$inferSelect>);

  const ordersPromise = partyId
    ? db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.counterpartyId, partyId),
            isNull(orders.deletedAt),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(ordersLimit)
    : Promise.resolve([] as Array<typeof orders.$inferSelect>);

  const listsPromise = db
    .select({
      id: lists.id,
      name: lists.name,
      color: lists.color,
      icon: lists.icon,
      description: lists.description,
      addedAt: listMembers.addedAt,
    })
    .from(listMembers)
    .innerJoin(lists, eq(lists.id, listMembers.listId))
    .where(
      and(
        eq(listMembers.entityId, companyId),
        eq(lists.kind, 'company'),
        isNull(lists.deletedAt),
      ),
    )
    .orderBy(desc(listMembers.addedAt));

  const peopleCountPromise = db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.personCompanies)
    .where(eq(schema.personCompanies.companyId, companyId));

  const activitiesCountPromise = partyId
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(crmActivities)
        .where(
          and(eq(crmActivities.counterpartyId, partyId), isNull(crmActivities.deletedAt)),
        )
    : Promise.resolve([{ count: 0 }]);

  const opportunitiesCountPromise = partyId
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(crmOpportunities)
        .where(
          and(eq(crmOpportunities.counterpartyId, partyId), isNull(crmOpportunities.deletedAt)),
        )
    : Promise.resolve([{ count: 0 }]);

  const ordersCountPromise = partyId
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(eq(orders.counterpartyId, partyId), isNull(orders.deletedAt)),
        )
    : Promise.resolve([{ count: 0 }]);

  const notesCountPromise = partyId
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(crmActivities)
        .where(
          and(
            eq(crmActivities.counterpartyId, partyId),
            eq(crmActivities.type, 'note'),
            isNull(crmActivities.deletedAt),
          ),
        )
    : Promise.resolve([{ count: 0 }]);

  const tasksCountPromise = partyId
    ? db
        .select({ count: sql<number>`count(*)::int` })
        .from(crmActivities)
        .where(
          and(
            eq(crmActivities.counterpartyId, partyId),
            eq(crmActivities.type, 'task'),
            isNull(crmActivities.deletedAt),
          ),
        )
    : Promise.resolve([{ count: 0 }]);

  const [
    peopleRows,
    activitiesRows,
    opportunitiesRows,
    ordersRows,
    listsRows,
    peopleCount,
    activitiesCount,
    opportunitiesCount,
    ordersCount,
    notesCount,
    tasksCount,
  ] = await Promise.all([
    peoplePromise,
    activitiesPromise,
    opportunitiesPromise,
    ordersPromise,
    listsPromise,
    peopleCountPromise,
    activitiesCountPromise,
    opportunitiesCountPromise,
    ordersCountPromise,
    notesCountPromise,
    tasksCountPromise,
  ]);

  const lastActivity =
    activitiesRows.length > 0 ? activitiesRows[0]!.createdAt?.toISOString() ?? null : null;

  return {
    company,
    people: peopleRows,
    activities: activitiesRows,
    opportunities: opportunitiesRows,
    orders: ordersRows,
    invoices: [] as unknown[],
    lists: listsRows,
    counts: {
      people: Number(peopleCount[0]?.count ?? 0),
      activities: Number(activitiesCount[0]?.count ?? 0),
      opportunities: Number(opportunitiesCount[0]?.count ?? 0),
      orders: Number(ordersCount[0]?.count ?? 0),
      invoices: 0,
      notes: Number(notesCount[0]?.count ?? 0),
      tasks: Number(tasksCount[0]?.count ?? 0),
    },
    lastActivity,
  };
}

export interface CompanyNavigationOptions {
  listId?: string;
}

/**
 * Prev/next navigation pointers for the company detail page. Mirrors the
 * legacy `GET /crm/customers/:id/navigation` shape.
 */
export async function getCompanyNavigation(
  db: Database,
  companyId: string,
  options: CompanyNavigationOptions = {},
  ownerScope?: string,
) {
  const { companies, lists, listMembers } = schema;

  if (options.listId) {
    const [listRow] = await db
      .select({ id: lists.id, name: lists.name })
      .from(lists)
      .where(and(eq(lists.id, options.listId), isNull(lists.deletedAt)))
      .limit(1);
    const contextName = listRow?.name ?? 'Company List';

    const listMemberConditions: SQL[] = [
      eq(listMembers.listId, options.listId),
      isNull(companies.deletedAt),
    ];
    if (ownerScope) listMemberConditions.push(eq(companies.ownerId, ownerScope));

    const members = await db
      .select({ entityId: listMembers.entityId })
      .from(listMembers)
      .innerJoin(companies, eq(companies.id, listMembers.entityId))
      .where(and(...listMemberConditions))
      .orderBy(desc(listMembers.addedAt));

    const memberIds = members.map((m) => m.entityId);
    const currentIndex = memberIds.indexOf(companyId);
    if (currentIndex === -1) {
      return { currentIndex: 0, totalCount: memberIds.length, previousId: null, nextId: null, contextName };
    }
    return {
      currentIndex: currentIndex + 1,
      totalCount: memberIds.length,
      previousId: currentIndex > 0 ? memberIds[currentIndex - 1]! : null,
      nextId: currentIndex < memberIds.length - 1 ? memberIds[currentIndex + 1]! : null,
      contextName,
    };
  }

  const currentConditions: SQL[] = [eq(companies.id, companyId), isNull(companies.deletedAt)];
  if (ownerScope) currentConditions.push(eq(companies.ownerId, ownerScope));
  const [current] = await db
    .select({ id: companies.id, createdAt: companies.createdAt })
    .from(companies)
    .where(and(...currentConditions))
    .limit(1);
  if (!current) return null;

  const baseNavConditions: SQL[] = [isNull(companies.deletedAt)];
  if (ownerScope) baseNavConditions.push(eq(companies.ownerId, ownerScope));

  const [totalCountRow, previousRow, nextRow, currentIndexRow] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(companies).where(and(...baseNavConditions)),
    db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          ...baseNavConditions,
          sql`${companies.createdAt} > ${current.createdAt}`,
        ),
      )
      .orderBy(companies.createdAt)
      .limit(1),
    db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          ...baseNavConditions,
          sql`${companies.createdAt} < ${current.createdAt}`,
        ),
      )
      .orderBy(desc(companies.createdAt))
      .limit(1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(companies)
      .where(
        and(
          ...baseNavConditions,
          sql`${companies.createdAt} > ${current.createdAt}`,
        ),
      ),
  ]);

  return {
    currentIndex: Number(currentIndexRow[0]?.count ?? 0) + 1,
    totalCount: Number(totalCountRow[0]?.count ?? 0),
    previousId: previousRow[0]?.id ?? null,
    nextId: nextRow[0]?.id ?? null,
    contextName: 'All Companies',
  };
}

export interface BulkUpdateCompaniesInput {
  companyIds: string[];
  updates: {
    ownerId?: string | null;
    accountManagerId?: string | null;
    status?: string;
    lifecycleStage?: string;
  };
}

export interface BulkUpdateResult {
  updated: number;
  failed: Array<{ id: string; reason: string }>;
  changedRows: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

/**
 * Atomic multi-row patch on a small set of safe fields. Returns per-row
 * before/after snapshots so the caller can publish entity events.
 *
 * @param ownerScope - when set, only rows owned by this userId are eligible;
 *   IDs that belong to a different owner are reported as failed (not found).
 */
export async function bulkUpdateCompanies(
  db: Database,
  input: BulkUpdateCompaniesInput,
  ownerScope?: string,
): Promise<BulkUpdateResult> {
  const { companies } = schema;
  const ids = Array.from(new Set(input.companyIds));
  if (ids.length === 0) return { updated: 0, failed: [], changedRows: [] };

  const setFields = input.updates;
  if (
    setFields.ownerId === undefined &&
    setFields.accountManagerId === undefined &&
    setFields.status === undefined &&
    setFields.lifecycleStage === undefined
  ) {
    return { updated: 0, failed: ids.map((id) => ({ id, reason: 'No fields to update' })), changedRows: [] };
  }

  // Read the before-snapshot for each id so the route can emit events.
  const beforeConditions: SQL[] = [isNull(companies.deletedAt)];
  if (ownerScope) beforeConditions.push(eq(companies.ownerId, ownerScope));
  const before = await db
    .select({
      id: companies.id,
      ownerId: companies.ownerId,
      accountManagerId: companies.accountManagerId,
      status: companies.status,
      lifecycleStage: companies.lifecycleStage,
    })
    .from(companies)
    .where(and(...beforeConditions));
  const beforeById = new Map(before.map((r) => [r.id, r]));

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (setFields.ownerId !== undefined) updates.ownerId = setFields.ownerId;
  if (setFields.accountManagerId !== undefined) updates.accountManagerId = setFields.accountManagerId;
  if (setFields.status !== undefined) updates.status = setFields.status;
  if (setFields.lifecycleStage !== undefined) updates.lifecycleStage = setFields.lifecycleStage;

  const bulkUpdateConditions: SQL[] = [
    sql`${companies.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
    isNull(companies.deletedAt),
  ];
  if (ownerScope) bulkUpdateConditions.push(eq(companies.ownerId, ownerScope));

  const updated = await db
    .update(companies)
    .set(updates)
    .where(and(...bulkUpdateConditions))
    .returning({ id: companies.id });

  const updatedIds = new Set(updated.map((r) => r.id));
  const failed = ids
    .filter((id) => !updatedIds.has(id))
    .map((id) => ({ id, reason: 'Not found or already deleted' }));

  const changedRows = updated.map((r) => {
    const prev = beforeById.get(r.id);
    return {
      id: r.id,
      before: prev ? { ownerId: prev.ownerId, accountManagerId: prev.accountManagerId, status: prev.status, lifecycleStage: prev.lifecycleStage } : {},
      after: { ...setFields },
    };
  });

  return { updated: updated.length, failed, changedRows };
}

/**
 * Re-fetch the avatar/logo for a company via the provided fetcher. The
 * fetcher is dependency-injected so the route layer wires in `fetchAndStoreLogo`
 * (which needs R2 + workspaceId from the Hono context).
 */
export async function refreshCompanyLogo(
  db: Database,
  companyId: string,
  fetcher: (args: { website: string | null; companyName: string | null; email: string | null }) => Promise<string | null>,
  ownerScope?: string,
): Promise<{ company: CompanyRow; avatarUrl: string | null } | null> {
  const { companies } = schema;
  const logoConditions: SQL[] = [eq(companies.id, companyId), isNull(companies.deletedAt)];
  if (ownerScope) logoConditions.push(eq(companies.ownerId, ownerScope));
  const [existing] = await db
    .select()
    .from(companies)
    .where(and(...logoConditions))
    .limit(1);
  if (!existing) return null;

  const avatarUrl = await fetcher({
    website: existing.website ?? null,
    companyName: existing.name ?? null,
    email: existing.email ?? null,
  });

  if (avatarUrl) {
    await db
      .update(companies)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(companies.id, companyId));
  }

  const updated = await getCompany(db, companyId);
  return updated ? { company: updated, avatarUrl } : null;
}
