/**
 * Prospects: the outreach contact store (separate from the CRM; a CRM person
 * is only linked once a prospect replies or is marked interested).
 *
 * Imports upsert by lower-cased email. Every parseable row is stored with a
 * `validation` verdict so the user can see and fix it; only `valid` prospects
 * can be enrolled in a campaign.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  emailDomain,
  type ReachImportReport,
  type ReachProspect,
  type ReachProspectValidation,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  companies,
  listMembers,
  lists,
  people,
  personCompanies,
  reachEnrollments,
  reachProspectListMembers,
  reachProspectLists,
  reachProspects,
  welddataLeads,
  welddataLists,
  type ReachProspect as ReachProspectRow,
} from '@weldsuite/db/schema';
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
// Lists
// ---------------------------------------------------------------------------

/** Recount `prospect_count` from the live (not deleted) members. */
export async function recountList(db: Database, listId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reachProspectListMembers)
    .innerJoin(reachProspects, eq(reachProspects.id, reachProspectListMembers.prospectId))
    .where(and(eq(reachProspectListMembers.listId, listId), isNull(reachProspects.deletedAt)));
  const n = Number(row?.n ?? 0);
  await db.update(reachProspectLists).set({ prospectCount: n, updatedAt: new Date() }).where(eq(reachProspectLists.id, listId));
  return n;
}

export async function addProspectsToList(db: Database, listId: string, prospectIds: readonly string[]): Promise<number> {
  const unique = [...new Set(prospectIds)];
  let added = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    // Only prospects that exist and are not deleted can join a list.
    const live = await db
      .select({ id: reachProspects.id })
      .from(reachProspects)
      .where(and(inArray(reachProspects.id, chunk), isNull(reachProspects.deletedAt)));
    if (live.length === 0) continue;
    const inserted = await db
      .insert(reachProspectListMembers)
      .values(live.map((p) => ({ id: generateId('rplm'), listId, prospectId: p.id })))
      .onConflictDoNothing()
      .returning({ id: reachProspectListMembers.id });
    added += inserted.length;
  }
  await recountList(db, listId);
  return added;
}

export async function removeProspectsFromList(db: Database, listId: string, prospectIds: readonly string[]): Promise<number> {
  let removed = 0;
  const unique = [...new Set(prospectIds)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const gone = await db
      .delete(reachProspectListMembers)
      .where(
        and(eq(reachProspectListMembers.listId, listId), inArray(reachProspectListMembers.prospectId, unique.slice(i, i + CHUNK))),
      )
      .returning({ id: reachProspectListMembers.id });
    removed += gone.length;
  }
  await recountList(db, listId);
  return removed;
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
