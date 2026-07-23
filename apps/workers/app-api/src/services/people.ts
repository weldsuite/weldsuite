/**
 * People service — identity layer for individuals.
 *
 * Includes individual customers, employees of companies, and previously-
 * anonymous helpdesk visitors that resolved to a real identity.
 *
 * Pure business logic; no Hono context. Stamps `displayName` on every
 * write. Lazily creates the wrapping Party row when isSupplier flips on
 * — see `companies.ts` for the same pattern.
 */

import { eq, and, desc, isNull, like, or, sql, inArray, ilike, type SQL } from 'drizzle-orm';
import { computeChanges } from '@weldsuite/entity-events';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from './custom-field-values';
import type {
  CreatePersonInput,
  UpdatePersonInput,
  ListPeopleQuery,
  ImportPersonRecord,
  ExportPeopleQuery,
} from '@weldsuite/core-api-client/schemas/people';

type PersonRow = typeof schema.people.$inferSelect;

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export function deriveDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
}): string {
  const combined = `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim();
  return combined || input.fullName?.trim() || input.email?.trim() || 'Unnamed';
}

/**
 * Lazily create or update the wrapping `parties` row when this person is
 * flagged as a supplier. Writes only the wrapper columns —
 * `displayName`/`role`/`partyCode`/`billingAddress`/accounting fields. The
 * legacy identity columns live on the `people` table; the wrapping party
 * row joins via `parties.personId`.
 */
async function ensureWrappingParty(db: Database, person: PersonRow): Promise<void> {
  const { parties } = schema;
  if (!person.isSupplier) return;

  const [existing] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(eq(parties.personId, person.id))
    .limit(1);

  const wrapperFields = {
    role: 'supplier' as const,
    displayName: person.displayName,
    partyCode: person.partyCode,
    billingAddress: person.primaryAddress,
    archivedAt: person.archivedAt,
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
    kind: 'person',
    personId: person.id,
    ...wrapperFields,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Shared filter fields for list + export. */
type PeopleFilter = Pick<
  ListPeopleQuery,
  'search' | 'status' | 'ownerId' | 'isSupplier' | 'isLead' | 'companyId' | 'listId' | 'inCrm'
>;

/**
 * Build the base WHERE conditions shared by `listPeople` and `exportPeople`.
 * Returns `null` when the filter can only ever match zero rows so callers can
 * short-circuit.
 *
 * @param ownerScope - when set, restrict results to rows owned by this userId
 *   (callers without `people:scope:all` pass their own userId here).
 */
async function buildPeopleConditions(
  db: Database,
  params: PeopleFilter,
  ownerScope?: string,
): Promise<SQL[] | null> {
  const { people, personCompanies, lists, listMembers } = schema;
  const conditions: SQL[] = [isNull(people.deletedAt)];

  if (ownerScope) conditions.push(eq(people.ownerId, ownerScope));

  if (params.search) {
    const term = `%${params.search}%`;
    conditions.push(
      or(
        like(people.displayName, term),
        like(people.fullName, term),
        like(people.firstName, term),
        like(people.lastName, term),
        like(people.email, term),
      )!,
    );
  }
  if (params.status) conditions.push(eq(people.status, params.status));
  if (params.ownerId) conditions.push(eq(people.ownerId, params.ownerId));
  if (params.isSupplier !== undefined) conditions.push(eq(people.isSupplier, params.isSupplier));
  if (params.isLead !== undefined) conditions.push(eq(people.isLead, params.isLead));
  if (params.inCrm !== undefined) conditions.push(eq(people.inCrm, params.inCrm));

  if (params.companyId) {
    const linked = await db
      .select({ personId: personCompanies.personId })
      .from(personCompanies)
      .where(
        and(eq(personCompanies.companyId, params.companyId), isNull(personCompanies.endedAt)),
      );
    if (linked.length === 0) return null;
    conditions.push(
      inArray(
        people.id,
        linked.map((l) => l.personId),
      ),
    );
  }

  // List-membership filter — only kind='person' lists target people.
  // Mismatched kind returns empty as defence in depth.
  if (params.listId) {
    const [listRow] = await db
      .select({ kind: lists.kind })
      .from(lists)
      .where(and(eq(lists.id, params.listId), isNull(lists.deletedAt)))
      .limit(1);
    if (!listRow || listRow.kind !== 'person') return null;
    const memberRows = await db
      .select({ entityId: listMembers.entityId })
      .from(listMembers)
      .where(eq(listMembers.listId, params.listId));
    if (memberRows.length === 0) return null;
    conditions.push(
      inArray(
        people.id,
        memberRows.map((m) => m.entityId),
      ),
    );
  }

  return conditions;
}

export async function listPeople(
  db: Database,
  params: ListPeopleQuery,
  ownerScope?: string,
): Promise<ListResult<PersonRow>> {
  const { people } = schema;
  const limit = Math.min(params.limit ?? 25, 100);

  const base = await buildPeopleConditions(db, params, ownerScope);
  if (!base) return { data: [], totalCount: 0, hasMore: false, cursor: null };
  const conditions = [...base];

  const filterOnly = and(...conditions);

  if (params.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: people.createdAt, id: people.id })
      .from(people)
      .where(eq(people.id, params.cursor))
      .limit(1);
    if (cursorRow) {
      conditions.push(
        sql`(${people.createdAt} < ${cursorRow.createdAt} OR (${people.createdAt} = ${cursorRow.createdAt} AND ${people.id} < ${cursorRow.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(people)
      .where(where)
      .orderBy(desc(people.createdAt), desc(people.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(people).where(filterOnly),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  return {
    // Phase 3: customFields comes from the typed values table, not the blob.
    data: await hydrateCustomFields(db, 'person', data),
    totalCount: Number(countResult[0]?.count ?? 0),
    hasMore,
    cursor: nextCursor,
  };
}

/** Hard ceiling on a single export so a runaway tenant can't OOM the worker. */
const EXPORT_ROW_LIMIT = 50_000;

/**
 * Every person matching `filter` (no pagination), newest first. Used by the
 * `/export` endpoint; the client renders the rows to CSV/XLSX.
 *
 * @param ownerScope - when set, restrict results to rows owned by this userId.
 */
export async function exportPeople(
  db: Database,
  filter: ExportPeopleQuery,
  ownerScope?: string,
): Promise<PersonRow[]> {
  const { people } = schema;
  const base = await buildPeopleConditions(db, filter, ownerScope);
  if (!base) return [];
  const rows = await db
    .select()
    .from(people)
    .where(and(...base))
    .orderBy(desc(people.createdAt), desc(people.id))
    .limit(EXPORT_ROW_LIMIT);
  return hydrateCustomFields(db, 'person', rows);
}

export async function getPerson(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<PersonRow | null> {
  const { people } = schema;
  const conditions: SQL[] = [eq(people.id, id), isNull(people.deletedAt)];
  if (ownerScope) conditions.push(eq(people.ownerId, ownerScope));
  const [row] = await db
    .select()
    .from(people)
    .where(and(...conditions))
    .limit(1);
  return hydrateCustomFieldsOne(db, 'person', row ?? null);
}

/**
 * Insert a person row (no company linking). Shared by `createPerson` and the
 * importer; the importer additionally supplies `partyCode` (the upsert key),
 * which the normal create surface never sets.
 */
async function insertPersonRow(
  db: Database,
  input: CreatePersonInput & { partyCode?: string | null },
): Promise<PersonRow> {
  const { people } = schema;
  const id = generateId('person');
  const now = new Date();
  const fullName =
    input.fullName?.trim() ||
    `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim() ||
    null;
  const displayName = deriveDisplayName(input);

  await db.insert(people).values({
    id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    partyCode: input.partyCode?.trim() || null,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    fullName,
    displayName,
    dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
    gender: input.gender ?? null,
    title: input.title ?? null,
    department: input.department ?? null,
    role: input.role ?? null,
    email: input.email || null,
    alternateEmails: input.alternateEmails ?? null,
    directPhone: input.directPhone ?? null,
    mobilePhone: input.mobilePhone ?? null,
    extension: input.extension ?? null,
    primaryAddress: input.primaryAddress ?? null,
    addresses: input.addresses ?? null,
    avatarUrl: input.avatarUrl ?? null,
    linkedinUrl: input.linkedinUrl ?? null,
    twitterHandle: input.twitterHandle ?? null,
    ownerId: input.ownerId ?? null,
    accountManagerId: input.accountManagerId ?? null,
    status: input.status ?? 'active',
    lifecycleStage: input.lifecycleStage ?? null,
    rating: input.rating ?? null,
    source: input.source ?? null,
    isSupplier: input.isSupplier ?? false,
    isLead: input.isLead ?? false,
    isFavorite: input.isFavorite ?? false,
    // Omitted → column default `true`. Email-guest resolvers pass `false`.
    inCrm: input.inCrm,
    isDecisionMaker: input.isDecisionMaker ?? false,
    isBillingContact: input.isBillingContact ?? false,
    isTechnicalContact: input.isTechnicalContact ?? false,
    influenceLevel: input.influenceLevel ?? null,
    preferredContactMethod: input.preferredContactMethod ?? null,
    preferredLanguage: input.preferredLanguage ?? null,
    bestTimeToContact: input.bestTimeToContact ?? null,
    marketingConsent: input.marketingConsent ?? false,
    emailOptIn: input.emailOptIn ?? false,
    smsOptIn: input.smsOptIn ?? false,
    doNotCall: input.doNotCall ?? false,
    tags: input.tags ?? null,
    interests: input.interests ?? null,
    customFields: input.customFields ?? null,
    notes: input.notes ?? null,
    internalNotes: input.internalNotes ?? null,
  });

  const created = await getPerson(db, id);
  if (!created) throw new Error('Person disappeared after insert');

  await ensureWrappingParty(db, created);

  return created;
}

export async function createPerson(
  db: Database,
  input: CreatePersonInput,
): Promise<PersonRow> {
  const { personCompanies } = schema;
  const created = await insertPersonRow(db, input);

  if (input.companyIds?.length) {
    const now = new Date();
    for (const companyId of input.companyIds) {
      await db.insert(personCompanies).values({
        id: generateId('pc'),
        createdAt: now,
        updatedAt: now,
        personId: created.id,
        companyId,
        isPrimary: companyId === input.primaryCompanyId,
      });
    }
  }

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'person', created.id, input.customFields);

  return created;
}

/**
 * Look up a person by case-insensitive email; create one if missing.
 * Used by meeting / participant resolvers and other places that need to
 * attach a guest by email without duplicating identity rows.
 *
 * NOT owner-scoped: this is an identity-resolution helper used by WeldMail
 * and WeldMeet to attach participants by email. Scoping it would break mail
 * threading for unowned contacts.
 */
export async function findOrCreatePersonByEmail(
  db: Database,
  args: { email: string; displayName?: string; firstName?: string; lastName?: string },
): Promise<PersonRow> {
  const { people } = schema;
  const email = args.email.trim().toLowerCase();
  if (!email) throw new Error('findOrCreatePersonByEmail: email is required');

  const [existing] = await db
    .select()
    .from(people)
    .where(and(sql`LOWER(${people.email}) = ${email}`, isNull(people.deletedAt)))
    .limit(1);
  if (existing) return existing;

  let firstName = args.firstName?.trim();
  let lastName = args.lastName?.trim();
  if (!firstName && !lastName) {
    const trimmed = args.displayName?.trim() ?? '';
    if (trimmed) {
      const [first = '', ...rest] = trimmed.split(/\s+/);
      firstName = first;
      lastName = rest.join(' ');
    }
  }

  return createPerson(db, {
    email,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    // Email-guest identity (mail / meet participant) — not a CRM member.
    inCrm: false,
  });
}

export class PersonVersionConflictError extends Error {
  readonly isConflict = true as const;
  constructor() {
    super('Person was modified by someone else; please reload.');
    this.name = 'PersonVersionConflictError';
  }
}

export interface UpdatePersonResult {
  row: PersonRow;
  /** Per-field diff between before/after, or null when nothing changed. */
  changes: Record<string, { old: unknown; new: unknown }> | null;
}

export async function updatePerson(
  db: Database,
  id: string,
  input: UpdatePersonInput,
  ownerScope?: string,
): Promise<UpdatePersonResult | null> {
  const { people } = schema;
  const fetchConditions: SQL[] = [eq(people.id, id), isNull(people.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(people.ownerId, ownerScope));
  const [existing] = await db
    .select()
    .from(people)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;

  if (input.ifVersion !== undefined && existing.version !== input.ifVersion) {
    throw new PersonVersionConflictError();
  }

  const {
    ifVersion: _ignored,
    companyIds: _ignore2,
    primaryCompanyId: _ignore3,
    dateOfBirth,
    ...rest
  } = input;

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
    version: existing.version + 1,
  };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) updates[k] = v;
  if (dateOfBirth !== undefined) {
    updates.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
  }

  if (
    rest.firstName !== undefined ||
    rest.lastName !== undefined ||
    rest.fullName !== undefined
  ) {
    const firstName = rest.firstName ?? existing.firstName;
    const lastName = rest.lastName ?? existing.lastName;
    const fullName =
      rest.fullName ??
      (firstName || lastName
        ? `${firstName ?? ''} ${lastName ?? ''}`.trim()
        : existing.fullName);
    updates.fullName = fullName;
    updates.displayName = deriveDisplayName({
      firstName,
      lastName,
      fullName,
      email: rest.email ?? existing.email,
    });
  }

  await db.update(people).set(updates).where(eq(people.id, id));

  const updated = await getPerson(db, id);
  if (!updated) return null;

  await ensureWrappingParty(db, updated);

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'person', id, rest.customFields);

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
  row: PersonRow;
}

export interface ImportPeopleResult {
  imported: number;
  updated: number;
  failed: number;
  total: number;
  errors: { row: number; ref: string; error: string }[];
  /** Created/updated rows so the route can emit one entity event each. */
  changedRows: ImportChangedRow[];
}

/**
 * Upsert a batch of people. Each record is matched to an existing person by
 * `partyCode` first, then by case-insensitive `email`; matches are patched,
 * the rest are created. People are imported standalone — no company linking.
 * Per-row failures are collected and never abort the batch. The caller submits
 * batches of ≤500.
 */
export async function importPeople(
  db: Database,
  records: ImportPersonRecord[],
): Promise<ImportPeopleResult> {
  const { people } = schema;
  const result: ImportPeopleResult = {
    imported: 0,
    updated: 0,
    failed: 0,
    total: records.length,
    errors: [],
    changedRows: [],
  };

  const norm = (s?: string | null) => s?.trim() ?? '';
  const hasName = (r: ImportPersonRecord) =>
    !!(norm(r.firstName) || norm(r.lastName) || norm(r.fullName) || norm(r.email));

  const partyCodes = [...new Set(records.map((r) => norm(r.partyCode)).filter(Boolean))];
  const emails = [...new Set(records.map((r) => norm(r.email).toLowerCase()).filter(Boolean))];

  const byPartyCode = new Map<string, PersonRow>();
  const byEmail = new Map<string, PersonRow>();

  if (partyCodes.length) {
    const rows = await db
      .select()
      .from(people)
      .where(and(isNull(people.deletedAt), inArray(people.partyCode, partyCodes)));
    for (const r of rows) if (r.partyCode) byPartyCode.set(r.partyCode, r);
  }
  if (emails.length) {
    const rows = await db
      .select()
      .from(people)
      .where(
        and(
          isNull(people.deletedAt),
          or(...emails.map((e) => sql`lower(${people.email}) = ${e}`))!,
        ),
      );
    for (const r of rows) if (r.email) byEmail.set(r.email.toLowerCase(), r);
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const ref =
      norm(rec.partyCode) ||
      norm(rec.email) ||
      norm(rec.fullName) ||
      `${norm(rec.firstName)} ${norm(rec.lastName)}`.trim() ||
      `#${i + 1}`;
    try {
      const pc = norm(rec.partyCode);
      const em = norm(rec.email).toLowerCase();
      const match = (pc && byPartyCode.get(pc)) || (em && byEmail.get(em)) || null;

      if (match) {
        // Merge imported custom fields into the existing blob so a partial
        // import doesn't wipe custom fields the row already had (updatePerson
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
        const updated = await updatePerson(
          db,
          match.id,
          recForUpdate as unknown as UpdatePersonInput,
        );
        if (!updated) {
          result.failed++;
          result.errors.push({ row: i + 1, ref, error: 'Matched person no longer exists' });
          continue;
        }
        result.updated++;
        result.changedRows.push({ id: updated.row.id, action: 'updated', row: updated.row });
        if (updated.row.partyCode) byPartyCode.set(updated.row.partyCode, updated.row);
        if (updated.row.email) byEmail.set(updated.row.email.toLowerCase(), updated.row);
      } else {
        if (!hasName(rec)) {
          result.failed++;
          result.errors.push({
            row: i + 1,
            ref,
            error: 'Missing a name or email to create a person',
          });
          continue;
        }
        const created = await insertPersonRow(
          db,
          rec as unknown as CreatePersonInput & { partyCode?: string | null },
        );
        // Phase 1 dual-write: mirror the customFields blob into the typed values table.
        await syncValuesForEntity(db, 'person', created.id, created.customFields);
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

export async function deletePerson(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<boolean> {
  const { people } = schema;
  const fetchConditions: SQL[] = [eq(people.id, id), isNull(people.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(people.ownerId, ownerScope));
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return false;
  await db
    .update(people)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(people.id, id));
  return true;
}

export async function archivePerson(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<PersonRow | null> {
  const { people } = schema;
  const fetchConditions: SQL[] = [eq(people.id, id), isNull(people.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(people.ownerId, ownerScope));
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;
  await db
    .update(people)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(people.id, id));
  const updated = await getPerson(db, id);
  if (updated) await ensureWrappingParty(db, updated);
  return updated;
}

export async function unarchivePerson(
  db: Database,
  id: string,
  ownerScope?: string,
): Promise<PersonRow | null> {
  const { people } = schema;
  const fetchConditions: SQL[] = [eq(people.id, id), isNull(people.deletedAt)];
  if (ownerScope) fetchConditions.push(eq(people.ownerId, ownerScope));
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;
  await db
    .update(people)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(people.id, id));
  const updated = await getPerson(db, id);
  if (updated) await ensureWrappingParty(db, updated);
  return updated;
}

/**
 * Promote a mail-only identity into the CRM — flips `inCrm` to `true` so the
 * person surfaces in the WeldCRM People grid. Idempotent; returns the person
 * even if it was already in the CRM. When the person has no owner yet, we
 * assign the acting user so it lands under their scope afterward.
 *
 * @param ownerScope - when set (caller lacks `people:scope:all`), the operation
 *   is restricted to rows the caller already owns OR unowned mail identities
 *   (`ownerId IS NULL`). The unowned case is essential: auto-created senders
 *   never have an owner, and promoting them is the whole point of this
 *   endpoint. Rows owned by *other* users are never matched, mirroring the
 *   owner-scoping on `PATCH /:id` / archive / unarchive.
 */
export async function addPersonToCrm(
  db: Database,
  id: string,
  actingUserId?: string,
  ownerScope?: string,
): Promise<PersonRow | null> {
  const { people } = schema;
  const fetchConditions: SQL[] = [eq(people.id, id), isNull(people.deletedAt)];
  if (ownerScope) {
    fetchConditions.push(or(eq(people.ownerId, ownerScope), isNull(people.ownerId))!);
  }
  const [existing] = await db
    .select({ id: people.id, ownerId: people.ownerId })
    .from(people)
    .where(and(...fetchConditions))
    .limit(1);
  if (!existing) return null;
  await db
    .update(people)
    .set({
      inCrm: true,
      ownerId: existing.ownerId ?? actingUserId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(people.id, id));
  const updated = await getPerson(db, id);
  if (updated) await ensureWrappingParty(db, updated);
  return updated;
}

/**
 * Every company a person is affiliated with, enriched with the joined
 * company's displayName / industry / avatar so the panel can render
 * without an N+1 lookup.
 *
 * @param ownerScope - when set, the person must be owned by this userId;
 *   returns empty array if the person doesn't belong to the scoped owner.
 */
export async function listPersonCompanies(
  db: Database,
  personId: string,
  ownerScope?: string,
) {
  // Verify the caller is allowed to see this person under the owner scope.
  if (ownerScope) {
    const person = await getPerson(db, personId, ownerScope);
    if (!person) return [];
  }
  const { personCompanies, companies } = schema;
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
      companyDisplayName: companies.displayName,
      companyName: companies.name,
      companyIndustry: companies.industry,
      companyAvatarUrl: companies.avatarUrl,
    })
    .from(personCompanies)
    .leftJoin(
      companies,
      and(eq(companies.id, personCompanies.companyId), isNull(companies.deletedAt)),
    )
    .where(eq(personCompanies.personId, personId))
    .orderBy(desc(personCompanies.isPrimary), desc(personCompanies.createdAt));

  return rows
    .filter((r) => r.companyDisplayName !== null)
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
      company: {
        id: r.companyId,
        displayName: r.companyDisplayName!,
        name: r.companyName,
        industry: r.companyIndustry,
        avatarUrl: r.companyAvatarUrl,
      },
    }));
}

export interface PersonDetailOptions {
  activitiesLimit?: number;
  ticketsLimit?: number;
  companiesLimit?: number;
}

/**
 * Aggregate read for the person detail page — fetches the person, their
 * companies, recent activities, recent helpdesk tickets, and counts.
 * Symmetric to `getCompanyDetail` in companies.ts.
 */
export async function getPersonDetail(
  db: Database,
  personId: string,
  options: PersonDetailOptions = {},
  ownerScope?: string,
) {
  const activitiesLimit = Math.min(options.activitiesLimit ?? 10, 50);
  const ticketsLimit = Math.min(options.ticketsLimit ?? 10, 50);
  const companiesLimit = Math.min(options.companiesLimit ?? 20, 50);

  const { people, crmActivities, helpdeskTickets } = schema;

  const detailConditions: SQL[] = [eq(people.id, personId), isNull(people.deletedAt)];
  if (ownerScope) detailConditions.push(eq(people.ownerId, ownerScope));
  const [personRow] = await db
    .select()
    .from(people)
    .where(and(...detailConditions))
    .limit(1);
  if (!personRow) return null;
  const person = (await hydrateCustomFieldsOne(db, 'person', personRow))!;

  const companiesPromise = listPersonCompanies(db, personId).then((rows) =>
    rows.slice(0, companiesLimit),
  );

  const activitiesPromise = db
    .select()
    .from(crmActivities)
    .where(and(eq(crmActivities.personId, personId), isNull(crmActivities.deletedAt)))
    .orderBy(desc(crmActivities.createdAt))
    .limit(activitiesLimit);

  const ticketsPromise = db
    .select()
    .from(helpdeskTickets)
    .where(and(eq(helpdeskTickets.personId, personId), isNull(helpdeskTickets.deletedAt)))
    .orderBy(desc(helpdeskTickets.createdAt))
    .limit(ticketsLimit);

  const companiesCountPromise = db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.personCompanies)
    .where(eq(schema.personCompanies.personId, personId));

  const activitiesCountPromise = db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmActivities)
    .where(and(eq(crmActivities.personId, personId), isNull(crmActivities.deletedAt)));

  const ticketsCountPromise = db
    .select({ count: sql<number>`count(*)::int` })
    .from(helpdeskTickets)
    .where(and(eq(helpdeskTickets.personId, personId), isNull(helpdeskTickets.deletedAt)));

  const notesCountPromise = db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmActivities)
    .where(
      and(
        eq(crmActivities.personId, personId),
        eq(crmActivities.type, 'note'),
        isNull(crmActivities.deletedAt),
      ),
    );

  const tasksCountPromise = db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmActivities)
    .where(
      and(
        eq(crmActivities.personId, personId),
        eq(crmActivities.type, 'task'),
        isNull(crmActivities.deletedAt),
      ),
    );

  const [
    companiesRows,
    activitiesRows,
    ticketsRows,
    companiesCount,
    activitiesCount,
    ticketsCount,
    notesCount,
    tasksCount,
  ] = await Promise.all([
    companiesPromise,
    activitiesPromise,
    ticketsPromise,
    companiesCountPromise,
    activitiesCountPromise,
    ticketsCountPromise,
    notesCountPromise,
    tasksCountPromise,
  ]);

  const lastActivity =
    activitiesRows.length > 0 ? activitiesRows[0]!.createdAt?.toISOString() ?? null : null;

  return {
    person,
    companies: companiesRows,
    activities: activitiesRows,
    tickets: ticketsRows,
    counts: {
      companies: Number(companiesCount[0]?.count ?? 0),
      activities: Number(activitiesCount[0]?.count ?? 0),
      tickets: Number(ticketsCount[0]?.count ?? 0),
      notes: Number(notesCount[0]?.count ?? 0),
      tasks: Number(tasksCount[0]?.count ?? 0),
    },
    lastActivity,
  };
}

export interface PersonNavigationOptions {
  listId?: string;
}

/**
 * Prev/next navigation pointers for the person detail page.
 */
export async function getPersonNavigation(
  db: Database,
  personId: string,
  options: PersonNavigationOptions = {},
  ownerScope?: string,
) {
  const { people, lists, listMembers } = schema;

  if (options.listId) {
    const [listRow] = await db
      .select({ id: lists.id, name: lists.name })
      .from(lists)
      .where(and(eq(lists.id, options.listId), isNull(lists.deletedAt)))
      .limit(1);
    const contextName = listRow?.name ?? 'People List';

    const listMemberConditions: SQL[] = [
      eq(listMembers.listId, options.listId),
      isNull(people.deletedAt),
    ];
    if (ownerScope) listMemberConditions.push(eq(people.ownerId, ownerScope));

    const members = await db
      .select({ entityId: listMembers.entityId })
      .from(listMembers)
      .innerJoin(people, eq(people.id, listMembers.entityId))
      .where(and(...listMemberConditions))
      .orderBy(desc(listMembers.addedAt));

    const memberIds = members.map((m) => m.entityId);
    const currentIndex = memberIds.indexOf(personId);
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

  const currentConditions: SQL[] = [eq(people.id, personId), isNull(people.deletedAt)];
  if (ownerScope) currentConditions.push(eq(people.ownerId, ownerScope));
  const [current] = await db
    .select({ id: people.id, createdAt: people.createdAt })
    .from(people)
    .where(and(...currentConditions))
    .limit(1);
  if (!current) return null;

  const baseNavConditions: SQL[] = [isNull(people.deletedAt)];
  if (ownerScope) baseNavConditions.push(eq(people.ownerId, ownerScope));

  const [totalCountRow, previousRow, nextRow, currentIndexRow] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(people).where(and(...baseNavConditions)),
    db
      .select({ id: people.id })
      .from(people)
      .where(and(...baseNavConditions, sql`${people.createdAt} > ${current.createdAt}`))
      .orderBy(people.createdAt)
      .limit(1),
    db
      .select({ id: people.id })
      .from(people)
      .where(and(...baseNavConditions, sql`${people.createdAt} < ${current.createdAt}`))
      .orderBy(desc(people.createdAt))
      .limit(1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(people)
      .where(and(...baseNavConditions, sql`${people.createdAt} > ${current.createdAt}`)),
  ]);

  return {
    currentIndex: Number(currentIndexRow[0]?.count ?? 0) + 1,
    totalCount: Number(totalCountRow[0]?.count ?? 0),
    previousId: previousRow[0]?.id ?? null,
    nextId: nextRow[0]?.id ?? null,
    contextName: 'All People',
  };
}

// ---------------------------------------------------------------------------
// Mail recipient resolver helpers
// ---------------------------------------------------------------------------

/**
 * Minimal person projection returned by mail-recipient resolvers.
 * Deliberately small — callers only need identity + avatar.
 */
export interface PersonSummary {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/**
 * Resolve a batch of email addresses to their matching Person rows
 * (case-insensitive). Returns only people that are not soft-deleted.
 * Addresses that have no person row are silently omitted — the caller is
 * responsible for deciding whether to create a new person.
 *
 * NOT owner-scoped: used by WeldMail for identity resolution / avatar hydration
 * across message recipients. Scoping by owner would break mail threading for
 * unowned contacts.
 */
export async function resolveByEmails(
  db: Database,
  emails: string[],
): Promise<PersonSummary[]> {
  if (emails.length === 0) return [];
  const { people } = schema;
  // Normalise inputs once; compare via LOWER() so case differences don't
  // produce duplicates or misses.
  const normalised = Array.from(new Set(emails.map((e) => e.trim().toLowerCase())));
  const rows = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      avatarUrl: people.avatarUrl,
    })
    .from(people)
    .where(
      and(
        isNull(people.deletedAt),
        inArray(sql`LOWER(${people.email})`, normalised),
      ),
    );
  return rows;
}

/**
 * Return recently-touched Person rows, ordered by `updatedAt` desc.
 *
 * The mail pipeline upserts/touches a person row on every inbound/outbound
 * message via `services/mail/contacts.ts`, so `updatedAt` is a reliable
 * proxy for "recently corresponded with". Optionally filter by mail account
 * by joining against `mailMessages.accountId` when a simpler mail-history
 * join is available; for now the updatedAt-desc approach is used as
 * documented in the task spec.
 *
 * NOT owner-scoped: used by WeldMail for mail recipient suggestions. Limiting
 * to the logged-in user's own contacts would prevent team members from
 * suggesting shared contacts when composing email.
 */
export async function listRecentCorrespondents(
  db: Database,
  opts: { accountId?: string; limit?: number },
): Promise<PersonSummary[]> {
  const { people, mailMessages } = schema;
  const limit = Math.min(opts.limit ?? 10, 50);

  if (opts.accountId) {
    // Prefer a "recently-messaged" join: find distinct email addresses in
    // the account's messages (from/to), then resolve to people. We look at
    // the most recent 200 messages to keep the query fast.
    const recentMessages = await db
      .select({
        fromEmail: sql<string | null>`(${mailMessages.from}->>'email')`,
        toEmails: mailMessages.to,
      })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.accountId, opts.accountId),
          isNull(mailMessages.deletedAt),
        ),
      )
      .orderBy(desc(mailMessages.sentDate))
      .limit(200);

    const emailSet = new Set<string>();
    for (const row of recentMessages) {
      if (row.fromEmail) emailSet.add(row.fromEmail.trim().toLowerCase());
      if (Array.isArray(row.toEmails)) {
        for (const addr of row.toEmails as Array<{ email?: string }>) {
          if (addr?.email) emailSet.add(addr.email.trim().toLowerCase());
        }
      }
    }

    const emailList = Array.from(emailSet).slice(0, 200);
    if (emailList.length === 0) return [];

    const rows = await db
      .select({
        id: people.id,
        displayName: people.displayName,
        firstName: people.firstName,
        lastName: people.lastName,
        email: people.email,
        avatarUrl: people.avatarUrl,
      })
      .from(people)
      .where(
        and(
          isNull(people.deletedAt),
          isNull(people.archivedAt),
          inArray(sql`LOWER(${people.email})`, emailList),
        ),
      )
      .orderBy(desc(people.updatedAt))
      .limit(limit);
    return rows;
  }

  // No accountId — fall back to updatedAt desc across the whole tenant.
  const rows = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      avatarUrl: people.avatarUrl,
    })
    .from(people)
    .where(and(isNull(people.deletedAt), isNull(people.archivedAt)))
    .orderBy(desc(people.updatedAt))
    .limit(limit);
  return rows;
}

export interface BulkUpdatePeopleInput {
  personIds: string[];
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
 * Atomic multi-row patch on a small set of safe fields. Mirror of
 * `bulkUpdateCompanies` in companies.ts.
 *
 * @param ownerScope - when set, only rows owned by this userId are eligible;
 *   IDs that belong to a different owner are reported as failed (not found).
 */
export async function bulkUpdatePeople(
  db: Database,
  input: BulkUpdatePeopleInput,
  ownerScope?: string,
): Promise<BulkUpdateResult> {
  const { people } = schema;
  const ids = Array.from(new Set(input.personIds));
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

  const beforeConditions: SQL[] = [isNull(people.deletedAt)];
  if (ownerScope) beforeConditions.push(eq(people.ownerId, ownerScope));
  const before = await db
    .select({
      id: people.id,
      ownerId: people.ownerId,
      accountManagerId: people.accountManagerId,
      status: people.status,
      lifecycleStage: people.lifecycleStage,
    })
    .from(people)
    .where(and(...beforeConditions));
  const beforeById = new Map(before.map((r) => [r.id, r]));

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (setFields.ownerId !== undefined) updates.ownerId = setFields.ownerId;
  if (setFields.accountManagerId !== undefined) updates.accountManagerId = setFields.accountManagerId;
  if (setFields.status !== undefined) updates.status = setFields.status;
  if (setFields.lifecycleStage !== undefined) updates.lifecycleStage = setFields.lifecycleStage;

  const bulkUpdateConditions: SQL[] = [
    sql`${people.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
    isNull(people.deletedAt),
  ];
  if (ownerScope) bulkUpdateConditions.push(eq(people.ownerId, ownerScope));

  const updated = await db
    .update(people)
    .set(updates)
    .where(and(...bulkUpdateConditions))
    .returning({ id: people.id });

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
