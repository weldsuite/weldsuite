/**
 * Prospects: the outreach contact store (separate from the CRM; a CRM person
 * is only linked once a prospect replies or is marked interested).
 *
 * Imports upsert by lower-cased email. Every parseable row is stored with a
 * `validation` verdict so the user can see and fix it; only `valid` prospects
 * can be enrolled in a campaign.
 */

import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  emailDomain,
  reachProspectValidationSchema,
  type ImportReachProspectsInput,
  type ReachImportReport,
  type ReachProspect,
  type ReachProspectInput,
  type ReachProspectValidation,
  type UpdateReachProspectInput,
  type WeldReachLimits,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  companies,
  listMembers,
  lists,
  people,
  personCompanies,
  reachEnrollments,
  reachProspectListMembers,
  reachProspects,
  welddataLeads,
  welddataLists,
  type ReachProspect as ReachProspectRow,
} from '@weldsuite/db/schema';
import { completeAndPublishCampaigns } from './campaign-completion';
import { reachError } from './errors';
import type { ReachEventSink } from './events';
import { addProspectsToList, createList, findList, recountList } from './lists';
import { cursorCondition, likePattern, pageResult, parseLimit, type Page, type PageQuery } from './list-query';
import { loadSuppressionIndex } from './suppressions';
import { validateEmails, type MxLookup } from './validation';

const CHUNK = 500;

export function toProspect(row: ReachProspectRow): ReachProspect {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    companyName: row.companyName,
    companyDomain: row.companyDomain,
    title: row.title,
    timezone: row.timezone,
    customFields: row.customFields ?? {},
    source: row.source,
    sourceRef: row.sourceRef,
    personId: row.personId,
    validation: row.validation,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ImportRow {
  /** CRM `people.id` when the row comes from a CRM list. */
  personId?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  title?: string | null;
  timezone?: string | null;
  customFields?: Record<string, string> | null;
}

export interface ImportOptions {
  source: ReachProspect['source'];
  sourceRef?: string | null;
  createdBy?: string | null;
  /** limits.allowConsumerRecipients */
  allowConsumer: boolean;
  /** Tests inject a stub; defaults to DNS-over-HTTPS. */
  mxLookup?: MxLookup;
}

export interface StoredProspect {
  id: string;
  email: string;
  validation: ReachProspectValidation;
  isNew: boolean;
}

export interface ImportOutcome {
  stored: StoredProspect[];
  created: number;
  updated: number;
  skipped: ReachImportReport['skipped'];
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const clip = (v: string | null, max: number): string | null => (v === null ? null : v.slice(0, max));

/** Store the rows, report what was created, updated and why some cannot be used. */
export async function importProspects(
  db: Database,
  rows: readonly ImportRow[],
  options: ImportOptions,
): Promise<ImportOutcome> {
  const skippedCounts = new Map<ReachImportReport['skipped'][number]['reason'], number>();
  const bump = (reason: ReachImportReport['skipped'][number]['reason']) =>
    skippedCounts.set(reason, (skippedCounts.get(reason) ?? 0) + 1);

  const unique = new Map<string, ImportRow>();
  for (const row of rows) {
    const email = (row.email ?? '').trim().toLowerCase();
    if (email === '' || !email.includes('@') || email.length > 320) {
      bump('invalid_row');
      continue;
    }
    if (unique.has(email)) {
      bump('duplicate');
      continue;
    }
    unique.set(email, row);
  }
  const emails = [...unique.keys()];
  if (emails.length === 0) return { stored: [], created: 0, updated: 0, skipped: reportSkipped(skippedCounts) };

  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += CHUNK) {
    const found = await db
      .select({ email: reachProspects.email })
      .from(reachProspects)
      .where(inArray(reachProspects.email, emails.slice(i, i + CHUNK)));
    for (const f of found) existing.add(f.email);
  }

  const suppressed = await loadSuppressionIndex(db, emails);
  const verdicts = await validateEmails(emails, {
    allowConsumer: options.allowConsumer,
    suppressed,
    mxLookup: options.mxLookup,
  });

  const now = new Date();
  const stored: StoredProspect[] = [];
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const inserted = await db
      .insert(reachProspects)
      .values(
        chunk.map((email) => {
          const row = unique.get(email) as ImportRow;
          return {
            id: generateId('rpro'),
            email,
            firstName: clip(blankToNull(row.firstName), 100),
            lastName: clip(blankToNull(row.lastName), 100),
            companyName: clip(blankToNull(row.companyName), 200),
            companyDomain: emailDomain(email) || null,
            personId: blankToNull(row.personId),
            title: clip(blankToNull(row.title), 200),
            timezone: clip(blankToNull(row.timezone), 64),
            customFields: row.customFields ?? {},
            source: options.source,
            sourceRef: options.sourceRef ?? null,
            validation: verdicts.get(email) ?? 'valid',
            createdBy: options.createdBy ?? null,
          };
        }),
      )
      .onConflictDoUpdate({
        target: reachProspects.email,
        set: {
          firstName: sql`coalesce(excluded.first_name, ${reachProspects.firstName})`,
          lastName: sql`coalesce(excluded.last_name, ${reachProspects.lastName})`,
          companyName: sql`coalesce(excluded.company_name, ${reachProspects.companyName})`,
          title: sql`coalesce(excluded.title, ${reachProspects.title})`,
          timezone: sql`coalesce(excluded.timezone, ${reachProspects.timezone})`,
          personId: sql`coalesce(${reachProspects.personId}, excluded.person_id)`,
          customFields: sql`${reachProspects.customFields} || excluded.custom_fields`,
          validation: sql`excluded.validation`,
          deletedAt: null,
          updatedAt: now,
        },
      })
      .returning({ id: reachProspects.id, email: reachProspects.email, validation: reachProspects.validation });
    for (const r of inserted) stored.push({ ...r, isNew: !existing.has(r.email) });
  }

  for (const s of stored) if (s.validation !== 'valid') bump(s.validation);
  const created = stored.filter((s) => s.isNew).length;
  return { stored, created, updated: stored.length - created, skipped: reportSkipped(skippedCounts) };
}

function reportSkipped(counts: Map<ReachImportReport['skipped'][number]['reason'], number>): ReachImportReport['skipped'] {
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Soft-delete a prospect: out of every list, and its queued/active enrollments
 * stop. Returns the campaigns that lost an enrollment so the caller can
 * complete the ones with nothing left.
 */
export async function softDeleteProspect(db: Database, id: string): Promise<{ campaignIds: string[] } | null> {
  const now = new Date();
  const [row] = await db
    .update(reachProspects)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .returning({ id: reachProspects.id });
  if (!row) return null;

  const memberships = await db
    .delete(reachProspectListMembers)
    .where(eq(reachProspectListMembers.prospectId, id))
    .returning({ listId: reachProspectListMembers.listId });
  for (const listId of new Set(memberships.map((m) => m.listId))) await recountList(db, listId);

  const stopped = await db
    .update(reachEnrollments)
    .set({ status: 'failed', stoppedReason: 'prospect_deleted', claimedAt: null, nextSendAt: null, updatedAt: now })
    .where(and(eq(reachEnrollments.prospectId, id), inArray(reachEnrollments.status, ['queued', 'active'])))
    .returning({ campaignId: reachEnrollments.campaignId });
  return { campaignIds: [...new Set(stopped.map((s) => s.campaignId))] };
}

// ---------------------------------------------------------------------------
// Sources: CRM lists and WeldData lists
// ---------------------------------------------------------------------------

export const MAX_SOURCE_LIST_ROWS = 10_000;

export type SourceListError = 'not_found' | 'wrong_kind' | 'smart_list' | 'too_large';

export type SourceListResult =
  | { ok: true; name: string; rows: ImportRow[] }
  | { ok: false; error: SourceListError };

function splitName(full: string | null): { firstName: string | null; lastName: string | null } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

/** The company name of each person in `personIds`: the primary current company, else any current one. */
async function currentCompanyNames(db: Database, personIds: string[]): Promise<Map<string, string>> {
  const links = await db
    .select({
      personId: personCompanies.personId,
      companyId: personCompanies.companyId,
      isPrimary: personCompanies.isPrimary,
      startedAt: personCompanies.startedAt,
    })
    .from(personCompanies)
    .where(and(inArray(personCompanies.personId, personIds), isNull(personCompanies.endedAt)));
  const companyIds = [...new Set(links.map((l) => l.companyId))];
  const companyNames = new Map<string, string>();
  if (companyIds.length > 0) {
    const cs = await db
      .select({ id: companies.id, name: companies.displayName })
      .from(companies)
      .where(and(inArray(companies.id, companyIds), isNull(companies.deletedAt)));
    for (const c of cs) companyNames.set(c.id, c.name);
  }
  const companyOf = new Map<string, string>();
  const ranked = [...links].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  for (const link of ranked) {
    const name = companyNames.get(link.companyId);
    if (name && !companyOf.has(link.personId)) companyOf.set(link.personId, name);
  }
  return companyOf;
}

/** Import rows for a chunk of CRM people; people without an email are skipped. */
async function crmPersonRows(db: Database, personIds: string[]): Promise<ImportRow[]> {
  const persons = await db
    .select({
      id: people.id,
      email: people.email,
      firstName: people.firstName,
      lastName: people.lastName,
      displayName: people.displayName,
      title: people.title,
    })
    .from(people)
    .where(and(inArray(people.id, personIds), isNull(people.deletedAt)));

  const companyOf = await currentCompanyNames(db, personIds);

  const rows: ImportRow[] = [];
  for (const p of persons) {
    if (!p.email) continue;
    const fallback = splitName(p.displayName);
    rows.push({
      email: p.email,
      personId: p.id,
      firstName: p.firstName ?? fallback.firstName,
      lastName: p.lastName ?? fallback.lastName,
      title: p.title,
      companyName: companyOf.get(p.id) ?? null,
    });
  }
  return rows;
}

/** People of a static CRM list (kind person), with their current primary company. */
export async function loadCrmListRows(db: Database, crmListId: string): Promise<SourceListResult> {
  const [list] = await db
    .select({ id: lists.id, name: lists.name, kind: lists.kind, type: lists.type })
    .from(lists)
    .where(and(eq(lists.id, crmListId), isNull(lists.deletedAt)))
    .limit(1);
  if (!list) return { ok: false, error: 'not_found' };
  if (list.kind !== 'person') return { ok: false, error: 'wrong_kind' };
  if (list.type !== 'static') return { ok: false, error: 'smart_list' };

  const members = await db
    .select({ entityId: listMembers.entityId })
    .from(listMembers)
    .where(eq(listMembers.listId, crmListId))
    .limit(MAX_SOURCE_LIST_ROWS + 1);
  if (members.length > MAX_SOURCE_LIST_ROWS) return { ok: false, error: 'too_large' };

  const personIds = members.map((m) => m.entityId);
  const rows: ImportRow[] = [];
  for (let i = 0; i < personIds.length; i += CHUNK) {
    rows.push(...(await crmPersonRows(db, personIds.slice(i, i + CHUNK))));
  }
  return { ok: true, name: list.name, rows };
}

/** Person leads of a WeldData list that have an email address. */
export async function loadWeldDataListRows(db: Database, listId: string): Promise<SourceListResult> {
  const [list] = await db
    .select({ id: welddataLists.id, name: welddataLists.name, kind: welddataLists.kind })
    .from(welddataLists)
    .where(and(eq(welddataLists.id, listId), isNull(welddataLists.deletedAt)))
    .limit(1);
  if (!list) return { ok: false, error: 'not_found' };
  if (list.kind !== 'person') return { ok: false, error: 'wrong_kind' };

  const leads = await db
    .select()
    .from(welddataLeads)
    .where(and(eq(welddataLeads.listId, listId), isNull(welddataLeads.deletedAt)))
    .limit(MAX_SOURCE_LIST_ROWS + 1);
  if (leads.length > MAX_SOURCE_LIST_ROWS) return { ok: false, error: 'too_large' };

  const rows: ImportRow[] = [];
  for (const lead of leads) {
    if (!lead.email) continue;
    const { firstName, lastName } = splitName(lead.name);
    const customFields: Record<string, string> = {};
    for (const [key, value] of [
      ['country', lead.country],
      ['industry', lead.industry],
      ['location', lead.location],
      ['companySize', lead.companySize],
    ] as const) {
      if (value) customFields[key] = value;
    }
    rows.push({ email: lead.email, firstName, lastName, title: lead.title, companyName: lead.companyName, customFields });
  }
  return { ok: true, name: list.name, rows };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Per-prospect events published by one import (a 5 000-row import must not become 5 000 queue messages). */
export const MAX_IMPORT_EVENTS = 100;

export interface ProspectDeps {
  db: Database;
  emit: ReachEventSink;
  /** Recorded as the creator of new prospects and lists. */
  userId: string;
  /** The workspace's resolved limits (`resolveWeldReachLimits`): consumer addresses are refused unless allowed. */
  limits: Pick<WeldReachLimits, 'allowConsumerRecipients'>;
  /** Tests inject a stub; defaults to DNS-over-HTTPS. */
  mxLookup?: MxLookup;
}

async function emitProspect(
  emit: ReachEventSink,
  action: 'created' | 'updated' | 'deleted',
  row: Pick<ReachProspectRow, 'id'> & Partial<ReachProspectRow>,
): Promise<void> {
  await emit({ entityType: 'reach_prospect', action, entityId: row.id, data: row });
}

export interface ListProspectsQuery extends PageQuery {
  search?: string;
  validation?: string;
  listId?: string;
}

export async function listProspects(db: Database, q: ListProspectsQuery = {}): Promise<Page<ReachProspect>> {
  const limit = parseLimit(q.limit);

  const conditions: SQL[] = [isNull(reachProspects.deletedAt)];
  if (q.search?.trim()) {
    const pattern = likePattern(q.search);
    const match = or(
      ilike(reachProspects.email, pattern),
      ilike(reachProspects.firstName, pattern),
      ilike(reachProspects.lastName, pattern),
      ilike(reachProspects.companyName, pattern),
    );
    if (match) conditions.push(match);
  }
  if (q.validation) {
    const parsed = reachProspectValidationSchema.safeParse(q.validation);
    if (!parsed.success) throw reachError.badRequest('Unknown validation filter');
    conditions.push(eq(reachProspects.validation, parsed.data));
  }
  if (q.listId) {
    conditions.push(
      inArray(
        reachProspects.id,
        db.select({ id: reachProspectListMembers.prospectId }).from(reachProspectListMembers).where(eq(reachProspectListMembers.listId, q.listId)),
      ),
    );
  }

  const after = await cursorCondition(db, reachProspects, q.cursor);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachProspects)
      .where(and(...conditions, after))
      .orderBy(desc(reachProspects.createdAt), desc(reachProspects.id))
      .limit(limit + 1),
    db.$count(reachProspects, and(...conditions)),
  ]);
  return pageResult(rows, limit, total, toProspect);
}

export async function getProspect(db: Database, id: string): Promise<ReachProspect> {
  const [row] = await db
    .select()
    .from(reachProspects)
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .limit(1);
  if (!row) throw reachError.notFound('Prospect', id);
  return toProspect(row);
}

/** Add one prospect (validated like an import row), optionally onto a list. */
export async function createProspect(
  deps: ProspectDeps,
  input: ReachProspectInput & { listId?: string },
): Promise<ReachProspect> {
  const { db } = deps;
  const { listId, ...fields } = input;

  const [existing] = await db.select().from(reachProspects).where(eq(reachProspects.email, fields.email)).limit(1);
  if (existing && !existing.deletedAt) throw reachError.conflict('A prospect with this email already exists');
  if (listId && !(await findList(db, listId))) throw reachError.notFound('List', listId);

  const outcome = await importProspects(db, [fields], {
    source: 'manual',
    createdBy: deps.userId,
    allowConsumer: deps.limits.allowConsumerRecipients,
    mxLookup: deps.mxLookup,
  });
  const stored = outcome.stored[0];
  if (!stored) throw reachError.badRequest('The email address is not valid');
  if (listId) await addProspectsToList(db, listId, [stored.id]);

  const [row] = await db.select().from(reachProspects).where(eq(reachProspects.id, stored.id)).limit(1);
  if (!row) throw reachError.internal('Failed to create the prospect');
  await emitProspect(deps.emit, 'created', row);
  return toProspect(row);
}

export async function updateProspect(
  deps: Pick<ProspectDeps, 'db' | 'emit'>,
  id: string,
  input: UpdateReachProspectInput,
): Promise<ReachProspect> {
  const { db } = deps;
  const [row] = await db
    .update(reachProspects)
    .set({
      ...(input.firstName !== undefined ? { firstName: blankToNull(input.firstName) } : {}),
      ...(input.lastName !== undefined ? { lastName: blankToNull(input.lastName) } : {}),
      ...(input.companyName !== undefined ? { companyName: blankToNull(input.companyName) } : {}),
      ...(input.title !== undefined ? { title: blankToNull(input.title) } : {}),
      ...(input.timezone !== undefined ? { timezone: blankToNull(input.timezone) } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .returning();
  if (!row) throw reachError.notFound('Prospect', id);
  await emitProspect(deps.emit, 'updated', row);
  return toProspect(row);
}

/** Soft-delete a prospect; campaigns that had it as their last live enrollment are completed. */
export async function deleteProspect(deps: Pick<ProspectDeps, 'db' | 'emit'>, id: string): Promise<void> {
  const { db } = deps;
  const removed = await softDeleteProspect(db, id);
  if (!removed) throw reachError.notFound('Prospect', id);
  await completeAndPublishCampaigns(db, deps.emit, removed.campaignIds);
  await emitProspect(deps.emit, 'deleted', { id });
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportTarget {
  /** An existing list to add to. */
  listId?: string;
  /** Or a list to create. */
  listName?: string;
}

/** Resolve (or create) the list an import adds to; throws 404 when the named list does not exist. */
async function resolveImportList(
  deps: Pick<ProspectDeps, 'db' | 'userId'>,
  target: ImportTarget,
  list: { source: 'csv' | 'crm_list' | 'welddata'; sourceRef: string | null },
): Promise<string | null> {
  const { db } = deps;
  if (target.listId) {
    if (!(await findList(db, target.listId))) throw reachError.notFound('List', target.listId);
    return target.listId;
  }
  if (target.listName) {
    const created = await createList(db, {
      name: target.listName,
      source: list.source,
      sourceRef: list.sourceRef,
      createdBy: deps.userId,
    });
    return created.id;
  }
  return null;
}

async function finishImport(deps: ProspectDeps, outcome: ImportOutcome, listId: string | null): Promise<ReachImportReport> {
  const { db } = deps;
  if (listId) await addProspectsToList(db, listId, outcome.stored.map((s) => s.id));

  const fresh = outcome.stored.filter((s) => s.isNew).slice(0, MAX_IMPORT_EVENTS);
  if (fresh.length > 0) {
    const rows = await db
      .select()
      .from(reachProspects)
      .where(inArray(reachProspects.id, fresh.map((s) => s.id)));
    for (const row of rows) await emitProspect(deps.emit, 'created', row);
  }
  return { listId, created: outcome.created, updated: outcome.updated, skipped: outcome.skipped };
}

const SOURCE_ERRORS: Record<SourceListError, string> = {
  not_found: 'List not found',
  wrong_kind: 'Only lists of people can be imported',
  smart_list: 'Smart lists cannot be imported; use a static list',
  too_large: 'This list is too large to import at once',
};

/** Import parsed rows (a CSV, or a JSON array from an API): stored with a verdict, optionally onto a list. */
export async function importProspectRows(deps: ProspectDeps, input: ImportReachProspectsInput): Promise<ReachImportReport> {
  const listId = await resolveImportList(deps, input, { source: 'csv', sourceRef: input.sourceRef ?? null });

  const rows: ImportRow[] = input.rows;
  const outcome = await importProspects(deps.db, rows, {
    source: 'csv',
    sourceRef: input.sourceRef ?? null,
    createdBy: deps.userId,
    allowConsumer: deps.limits.allowConsumerRecipients,
    mxLookup: deps.mxLookup,
  });
  return finishImport(deps, outcome, listId);
}

/** Import the people of a static CRM list into a new prospect list. The caller has checked read access to CRM lists and people. */
export async function importProspectsFromCrmList(
  deps: ProspectDeps,
  input: { crmListId: string; listName?: string },
): Promise<ReachImportReport> {
  const source = await loadCrmListRows(deps.db, input.crmListId);
  if (!source.ok) {
    throw source.error === 'not_found' ? reachError.notFound('CRM list', input.crmListId) : reachError.badRequest(SOURCE_ERRORS[source.error]);
  }
  const listId = await resolveImportList(deps, { listName: input.listName ?? source.name }, { source: 'crm_list', sourceRef: input.crmListId });

  const outcome = await importProspects(deps.db, source.rows, {
    source: 'crm_list',
    sourceRef: input.crmListId,
    createdBy: deps.userId,
    allowConsumer: deps.limits.allowConsumerRecipients,
    mxLookup: deps.mxLookup,
  });
  return finishImport(deps, outcome, listId);
}

/** Import the person leads of a WeldData list into a new prospect list. The caller has checked read access to the lists. */
export async function importProspectsFromWeldDataList(
  deps: ProspectDeps,
  input: { welddataListId: string; listName?: string },
): Promise<ReachImportReport> {
  const source = await loadWeldDataListRows(deps.db, input.welddataListId);
  if (!source.ok) {
    throw source.error === 'not_found'
      ? reachError.notFound('WeldData list', input.welddataListId)
      : reachError.badRequest(SOURCE_ERRORS[source.error]);
  }
  const listId = await resolveImportList(
    deps,
    { listName: input.listName ?? source.name },
    { source: 'welddata', sourceRef: input.welddataListId },
  );

  const outcome = await importProspects(deps.db, source.rows, {
    source: 'welddata',
    sourceRef: input.welddataListId,
    createdBy: deps.userId,
    allowConsumer: deps.limits.allowConsumerRecipients,
    mxLookup: deps.mxLookup,
  });
  return finishImport(deps, outcome, listId);
}
