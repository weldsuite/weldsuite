/**
 * Computed company attributes — what the Companies grid shows for Attio's
 * "Team", "First/Last/Next interaction", "Connection strength", "Strongest
 * connection", "Next due task" and "Associated deals". None of it is stored
 * on the company: it is read from people, activities, tasks and deals.
 *
 * Built for one page of list rows at a time: a fixed handful of queries,
 * whatever the page size. Activities, tasks and deals hang off the company's
 * wrapping `parties` row (`counterpartyId`), people off `person_companies`.
 */

import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  CompanyAttributes,
  CompanyInteraction,
  ConnectionStrength,
} from '@weldsuite/app-api-client/schemas/companies';

/** Activity types that count as an interaction; tasks and notes don't. */
export const INTERACTION_TYPES = ['call', 'email', 'meeting', 'sms', 'linkedin', 'demo', 'presentation'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECTION_WINDOW_DAYS = 90;

/**
 * Attio-style buckets from the number of interactions in the last 90 days.
 * Older contact only, however much, is "very weak"; none at all is "none".
 */
export function connectionStrengthFor(recentCount: number, hasAnyPast: boolean): ConnectionStrength {
  if (recentCount >= 10) return 'very_strong';
  if (recentCount >= 5) return 'strong';
  if (recentCount >= 2) return 'good';
  if (recentCount === 1) return 'weak';
  return hasAnyPast ? 'very_weak' : 'none';
}

function emptyAttributes(): CompanyAttributes {
  return {
    team: [],
    firstInteraction: null,
    lastInteraction: null,
    nextInteraction: null,
    connectionStrength: 'none',
    strongestConnectionUserId: null,
    nextDueTask: null,
    deals: [],
  };
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Computed attributes for each of `companyIds` (every id gets an entry). */
export async function getCompanyAttributes(
  db: Database,
  companyIds: string[],
  now: Date = new Date(),
): Promise<Map<string, CompanyAttributes>> {
  const result = new Map<string, CompanyAttributes>(companyIds.map((id) => [id, emptyAttributes()]));
  if (companyIds.length === 0) return result;

  const { parties, personCompanies, people, crmActivities, tasks, crmOpportunities } = schema;

  const [partyRows, teamRows] = await Promise.all([
    db
      .select({ id: parties.id, companyId: parties.companyId })
      .from(parties)
      .where(and(inArray(parties.companyId, companyIds), isNull(parties.deletedAt))),
    db
      .select({
        companyId: personCompanies.companyId,
        id: people.id,
        name: people.displayName,
        email: people.email,
        directPhone: people.directPhone,
        mobilePhone: people.mobilePhone,
        title: people.title,
        role: personCompanies.role,
      })
      .from(personCompanies)
      .innerJoin(people, eq(people.id, personCompanies.personId))
      .where(
        and(
          inArray(personCompanies.companyId, companyIds),
          isNull(personCompanies.endedAt),
          isNull(people.deletedAt),
        ),
      )
      .orderBy(desc(personCompanies.isPrimary), asc(people.displayName)),
  ]);

  for (const row of teamRows) {
    result.get(row.companyId)?.team.push({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.directPhone ?? row.mobilePhone,
      jobTitle: row.title ?? row.role,
    });
  }

  // party id → company id. A company has at most one live wrapping party.
  const companyByParty = new Map<string, string>();
  for (const p of partyRows) if (p.companyId) companyByParty.set(p.id, p.companyId);
  const partyIds = [...companyByParty.keys()];
  if (partyIds.length === 0) return result;

  // When an activity happened (or is planned): its start, else due date,
  // else when it was logged. Decoded like the timestamp columns themselves
  // (stored as UTC without a zone), not as a local-time string.
  const when = sql<Date>`coalesce(${crmActivities.startTime}, ${crmActivities.dueDate}, ${crmActivities.createdAt})`.mapWith(
    crmActivities.startTime,
  );

  const [activityRows, taskRows, activityTaskRows, dealRows] = await Promise.all([
    db
      .select({
        partyId: crmActivities.counterpartyId,
        type: crmActivities.type,
        status: crmActivities.status,
        userId: crmActivities.assignedToId,
        at: when,
      })
      .from(crmActivities)
      .where(
        and(
          inArray(crmActivities.counterpartyId, partyIds),
          inArray(crmActivities.type, [...INTERACTION_TYPES]),
          isNull(crmActivities.deletedAt),
          notInArray(crmActivities.status, ['cancelled']),
        ),
      ),
    db
      .select({ partyId: tasks.counterpartyId, id: tasks.id, title: tasks.title, dueDate: tasks.dueDate })
      .from(tasks)
      .where(
        and(
          inArray(tasks.counterpartyId, partyIds),
          isNull(tasks.deletedAt),
          notInArray(tasks.status, ['done', 'cancelled']),
          sql`${tasks.dueDate} is not null`,
        ),
      ),
    // CRM "task" activities are tasks too.
    db
      .select({
        partyId: crmActivities.counterpartyId,
        id: crmActivities.id,
        title: crmActivities.subject,
        dueDate: crmActivities.dueDate,
      })
      .from(crmActivities)
      .where(
        and(
          inArray(crmActivities.counterpartyId, partyIds),
          eq(crmActivities.type, 'task'),
          isNull(crmActivities.deletedAt),
          inArray(crmActivities.status, ['planned', 'in_progress']),
          sql`${crmActivities.dueDate} is not null`,
        ),
      ),
    db
      .select({
        partyId: crmOpportunities.counterpartyId,
        id: crmOpportunities.id,
        name: crmOpportunities.name,
        stage: crmOpportunities.stage,
        status: crmOpportunities.status,
        amount: crmOpportunities.amount,
        currency: crmOpportunities.currency,
        closeDate: crmOpportunities.closeDate,
        ownerId: crmOpportunities.ownerId,
      })
      .from(crmOpportunities)
      .where(and(inArray(crmOpportunities.counterpartyId, partyIds), isNull(crmOpportunities.deletedAt)))
      .orderBy(desc(crmOpportunities.createdAt)),
  ]);

  // Interactions: first/last among the past ones, next among the planned
  // future ones; strength and strongest connection from the past ones.
  const recentSince = now.getTime() - CONNECTION_WINDOW_DAYS * DAY_MS;
  const stats = new Map<string, { recent: number; past: number; byUser: Map<string, { count: number; last: number }> }>();
  for (const row of activityRows) {
    const companyId = row.partyId ? companyByParty.get(row.partyId) : undefined;
    const attrs = companyId ? result.get(companyId) : undefined;
    if (!companyId || !attrs) continue;
    const at = new Date(row.at);
    const time = at.getTime();
    if (Number.isNaN(time)) continue;
    const interaction: CompanyInteraction = { at: at.toISOString(), type: row.type, userId: row.userId };

    if (time > now.getTime()) {
      if (row.status !== 'planned' && row.status !== 'in_progress') continue;
      if (!attrs.nextInteraction || time < Date.parse(attrs.nextInteraction.at)) attrs.nextInteraction = interaction;
      continue;
    }

    if (!attrs.firstInteraction || time < Date.parse(attrs.firstInteraction.at)) attrs.firstInteraction = interaction;
    if (!attrs.lastInteraction || time > Date.parse(attrs.lastInteraction.at)) attrs.lastInteraction = interaction;

    let s = stats.get(companyId);
    if (!s) {
      s = { recent: 0, past: 0, byUser: new Map() };
      stats.set(companyId, s);
    }
    s.past++;
    if (time >= recentSince) s.recent++;
    if (row.userId) {
      const u = s.byUser.get(row.userId) ?? { count: 0, last: 0 };
      u.count++;
      u.last = Math.max(u.last, time);
      s.byUser.set(row.userId, u);
    }
  }
  for (const [companyId, s] of stats) {
    const attrs = result.get(companyId)!;
    attrs.connectionStrength = connectionStrengthFor(s.recent, s.past > 0);
    // Most interactions wins; a tie goes to the more recent contact.
    let best: { userId: string; count: number; last: number } | null = null;
    for (const [userId, u] of s.byUser) {
      if (!best || u.count > best.count || (u.count === best.count && u.last > best.last)) best = { userId, ...u };
    }
    attrs.strongestConnectionUserId = best?.userId ?? null;
  }

  for (const row of [...taskRows, ...activityTaskRows]) {
    const companyId = row.partyId ? companyByParty.get(row.partyId) : undefined;
    const attrs = companyId ? result.get(companyId) : undefined;
    if (!attrs || !row.dueDate) continue;
    const due = new Date(row.dueDate);
    if (!attrs.nextDueTask || due.getTime() < Date.parse(attrs.nextDueTask.dueDate)) {
      attrs.nextDueTask = { id: row.id, title: row.title, dueDate: due.toISOString() };
    }
  }

  for (const row of dealRows) {
    const companyId = row.partyId ? companyByParty.get(row.partyId) : undefined;
    result.get(companyId ?? '')?.deals.push({
      id: row.id,
      name: row.name,
      stage: row.stage,
      status: row.status,
      amount: toNumber(row.amount),
      currency: row.currency,
      closeDate: row.closeDate ? new Date(row.closeDate).toISOString() : null,
      ownerId: row.ownerId,
    });
  }

  return result;
}
