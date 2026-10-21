/**
 * Computed company attributes — what the Companies grid shows for Attio's
 * "Team", "First/Last/Next interaction", "Connection strength", "Strongest
 * connection", "Next due task" and "Associated deals". None of it is stored
 * on the company: it is read from people, activities, tasks and deals.
 *
 * Built for one page of list rows at a time: a fixed handful of queries in
 * one round trip, whatever the page size. Activities, tasks and deals hang off
 * the company's wrapping `parties` row (`counterpartyId`), which every query
 * joins; people hang off `person_companies`. The database does the
 * aggregating, so a company with years of logged email costs a row per
 * teammate, not a row per email.
 */

import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
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

type AttributesById = Map<string, CompanyAttributes>;
type CompanyLinked = { companyId: string | null };
type TeamMember = CompanyAttributes['team'][number];
type Deal = CompanyAttributes['deals'][number];
type InteractionType = CompanyInteraction['type'];

interface TeamRow extends Omit<TeamMember, 'phone' | 'jobTitle'> {
  companyId: string;
  directPhone: string | null;
  mobilePhone: string | null;
  title: string | null;
  role: string | null;
}

/** One teammate's interactions with one company, aggregated in SQL. */
interface InteractionRow extends CompanyLinked {
  userId: string | null;
  /** Past interactions, and those of them in the last 90 days. */
  past: number;
  recent: number;
  firstAt: Date | null;
  firstType: InteractionType | null;
  lastAt: Date | null;
  lastType: InteractionType | null;
  /** The earliest planned future one. */
  nextAt: Date | null;
  nextType: InteractionType | null;
}

interface DueTaskRow extends CompanyLinked {
  id: string;
  title: string;
  dueDate: Date | string | null;
}

interface DealRow extends CompanyLinked, Omit<Deal, 'amount' | 'closeDate'> {
  amount: string | number | null;
  closeDate: Date | string | null;
}

interface InteractionStats {
  recent: number;
  past: number;
  byUser: Map<string, { count: number; last: number }>;
}

function addTeam(result: AttributesById, rows: TeamRow[]): void {
  for (const row of rows) {
    result.get(row.companyId)?.team.push({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.directPhone ?? row.mobilePhone,
      jobTitle: row.title ?? row.role,
    });
  }
}

function interaction(
  at: Date | null,
  type: InteractionType | null,
  userId: string | null,
): CompanyInteraction | null {
  return at && type ? { at: at.toISOString(), type, userId } : null;
}

const isEarlier = (candidate: CompanyInteraction, current: CompanyInteraction | null) =>
  !current || Date.parse(candidate.at) < Date.parse(current.at);
const isLater = (candidate: CompanyInteraction, current: CompanyInteraction | null) =>
  !current || Date.parse(candidate.at) > Date.parse(current.at);

/** Most interactions wins; a tie goes to the more recent contact. */
function strongestConnection(byUser: InteractionStats['byUser']): string | null {
  let best: { userId: string; count: number; last: number } | null = null;
  for (const [userId, u] of byUser) {
    if (!best || u.count > best.count || (u.count === best.count && u.last > best.last)) best = { userId, ...u };
  }
  return best?.userId ?? null;
}

/**
 * Interactions: first/last among the past ones, next among the planned
 * future ones; strength and strongest connection from the past ones. Each row
 * is one teammate's share of one company's interactions.
 */
function addInteractions(result: AttributesById, rows: InteractionRow[]): void {
  const stats = new Map<string, InteractionStats>();
  for (const row of rows) {
    const attrs = row.companyId ? result.get(row.companyId) : undefined;
    if (!row.companyId || !attrs) continue;

    const first = interaction(row.firstAt, row.firstType, row.userId);
    const last = interaction(row.lastAt, row.lastType, row.userId);
    const next = interaction(row.nextAt, row.nextType, row.userId);
    if (first && isEarlier(first, attrs.firstInteraction)) attrs.firstInteraction = first;
    if (last && isLater(last, attrs.lastInteraction)) attrs.lastInteraction = last;
    if (next && isEarlier(next, attrs.nextInteraction)) attrs.nextInteraction = next;

    const s = stats.get(row.companyId) ?? { recent: 0, past: 0, byUser: new Map() };
    stats.set(row.companyId, s);
    s.past += row.past;
    s.recent += row.recent;
    if (row.userId && row.past > 0 && row.lastAt) {
      s.byUser.set(row.userId, { count: row.past, last: row.lastAt.getTime() });
    }
  }
  for (const [companyId, s] of stats) {
    const attrs = result.get(companyId)!;
    attrs.connectionStrength = connectionStrengthFor(s.recent, s.past > 0);
    attrs.strongestConnectionUserId = strongestConnection(s.byUser);
  }
}

function addNextDueTasks(result: AttributesById, rows: DueTaskRow[]): void {
  for (const row of rows) {
    const attrs = row.companyId ? result.get(row.companyId) : undefined;
    if (!attrs || !row.dueDate) continue;
    const due = new Date(row.dueDate);
    if (!attrs.nextDueTask || due.getTime() < Date.parse(attrs.nextDueTask.dueDate)) {
      attrs.nextDueTask = { id: row.id, title: row.title, dueDate: due.toISOString() };
    }
  }
}

function addDeals(result: AttributesById, rows: DealRow[]): void {
  for (const row of rows) {
    if (!row.companyId) continue;
    result.get(row.companyId)?.deals.push({
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

  // Activities, tasks and deals of these companies: through each company's
  // live wrapping party (at most one per company).
  const wrappingParty = (counterpartyId: AnyPgColumn) =>
    and(eq(parties.id, counterpartyId), isNull(parties.deletedAt));
  const ofTheseCompanies = inArray(parties.companyId, companyIds);

  // When an activity happened (or is planned): its start, else due date,
  // else when it was logged. The columns hold UTC without a zone, so `now`
  // is compared as its UTC wall-clock time, and the aggregated timestamps
  // are decoded like the columns themselves, not as local-time strings.
  const when = sql`coalesce(${crmActivities.startTime}, ${crmActivities.dueDate}, ${crmActivities.createdAt})`;
  const utc = (date: Date) => sql`${date.toISOString()}::timestamp`;
  const recentSince = new Date(now.getTime() - CONNECTION_WINDOW_DAYS * DAY_MS);
  const isPast = sql`${when} <= ${utc(now)}`;
  const isRecent = sql`${isPast} and ${when} >= ${utc(recentSince)}`;
  const isPlanned = sql`${when} > ${utc(now)} and ${inArray(crmActivities.status, ['planned', 'in_progress'])}`;
  const at = (aggregate: 'min' | 'max', filter: SQL) =>
    sql<Date | null>`${sql.raw(aggregate)}(${when}) filter (where ${filter})`.mapWith(crmActivities.startTime);
  const typeAt = (order: 'asc' | 'desc', filter: SQL) =>
    sql<InteractionType | null>`(array_agg(${crmActivities.type} order by ${when} ${sql.raw(order)}) filter (where ${filter}))[1]`;
  const count = (filter: SQL) => sql<number>`count(*) filter (where ${filter})`.mapWith(Number);

  const [teamRows, interactionRows, taskRows, activityTaskRows, dealRows] = await Promise.all([
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
    // One row per company and teammate.
    db
      .select({
        companyId: parties.companyId,
        userId: crmActivities.assignedToId,
        past: count(isPast),
        recent: count(isRecent),
        firstAt: at('min', isPast),
        firstType: typeAt('asc', isPast),
        lastAt: at('max', isPast),
        lastType: typeAt('desc', isPast),
        nextAt: at('min', isPlanned),
        nextType: typeAt('asc', isPlanned),
      })
      .from(crmActivities)
      .innerJoin(parties, wrappingParty(crmActivities.counterpartyId))
      .where(
        and(
          ofTheseCompanies,
          inArray(crmActivities.type, [...INTERACTION_TYPES]),
          isNull(crmActivities.deletedAt),
          notInArray(crmActivities.status, ['cancelled']),
        ),
      )
      .groupBy(parties.companyId, crmActivities.assignedToId),
    // The first open task per company…
    db
      .selectDistinctOn([parties.companyId], {
        companyId: parties.companyId,
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
      })
      .from(tasks)
      .innerJoin(parties, wrappingParty(tasks.counterpartyId))
      .where(
        and(
          ofTheseCompanies,
          isNull(tasks.deletedAt),
          notInArray(tasks.status, ['done', 'cancelled']),
          sql`${tasks.dueDate} is not null`,
        ),
      )
      .orderBy(parties.companyId, asc(tasks.dueDate)),
    // …and the first open CRM "task" activity, which is a task too.
    db
      .selectDistinctOn([parties.companyId], {
        companyId: parties.companyId,
        id: crmActivities.id,
        title: crmActivities.subject,
        dueDate: crmActivities.dueDate,
      })
      .from(crmActivities)
      .innerJoin(parties, wrappingParty(crmActivities.counterpartyId))
      .where(
        and(
          ofTheseCompanies,
          eq(crmActivities.type, 'task'),
          isNull(crmActivities.deletedAt),
          inArray(crmActivities.status, ['planned', 'in_progress']),
          sql`${crmActivities.dueDate} is not null`,
        ),
      )
      .orderBy(parties.companyId, asc(crmActivities.dueDate)),
    db
      .select({
        companyId: parties.companyId,
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
      .innerJoin(parties, wrappingParty(crmOpportunities.counterpartyId))
      .where(and(ofTheseCompanies, isNull(crmOpportunities.deletedAt)))
      .orderBy(desc(crmOpportunities.createdAt)),
  ]);

  addTeam(result, teamRows);
  addInteractions(result, interactionRows);
  addNextDueTasks(result, [...taskRows, ...activityTaskRows]);
  addDeals(result, dealRows);

  return result;
}
