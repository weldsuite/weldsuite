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

type AttributesById = Map<string, CompanyAttributes>;
type PartyLinked = { partyId: string | null };
type TeamMember = CompanyAttributes['team'][number];
type Deal = CompanyAttributes['deals'][number];

interface TeamRow extends Omit<TeamMember, 'phone' | 'jobTitle'> {
  companyId: string;
  directPhone: string | null;
  mobilePhone: string | null;
  title: string | null;
  role: string | null;
}

interface ActivityRow extends PartyLinked {
  type: CompanyInteraction['type'];
  status: string | null;
  userId: string | null;
  at: Date;
}

interface DueTaskRow extends PartyLinked {
  id: string;
  title: string;
  dueDate: Date | string | null;
}

interface DealRow extends PartyLinked, Omit<Deal, 'amount' | 'closeDate'> {
  amount: string | number | null;
  closeDate: Date | string | null;
}

interface InteractionStats {
  recent: number;
  past: number;
  byUser: Map<string, { count: number; last: number }>;
}

/** The company a party-linked row belongs to, with its attributes entry. */
function companyForParty(
  result: AttributesById,
  companyByParty: Map<string, string>,
  partyId: string | null,
): { companyId: string; attrs: CompanyAttributes } | null {
  const companyId = partyId ? companyByParty.get(partyId) : undefined;
  const attrs = companyId ? result.get(companyId) : undefined;
  return companyId && attrs ? { companyId, attrs } : null;
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

const isEarlier = (time: number, current: CompanyInteraction | null) => !current || time < Date.parse(current.at);
const isLater = (time: number, current: CompanyInteraction | null) => !current || time > Date.parse(current.at);

function countInteraction(
  stats: Map<string, InteractionStats>,
  companyId: string,
  userId: string | null,
  time: number,
  recentSince: number,
): void {
  let s = stats.get(companyId);
  if (!s) {
    s = { recent: 0, past: 0, byUser: new Map() };
    stats.set(companyId, s);
  }
  s.past++;
  if (time >= recentSince) s.recent++;
  if (!userId) return;
  const u = s.byUser.get(userId) ?? { count: 0, last: 0 };
  u.count++;
  u.last = Math.max(u.last, time);
  s.byUser.set(userId, u);
}

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
 * future ones; strength and strongest connection from the past ones.
 */
function addInteractions(
  result: AttributesById,
  companyByParty: Map<string, string>,
  rows: ActivityRow[],
  now: Date,
): void {
  const nowTime = now.getTime();
  const recentSince = nowTime - CONNECTION_WINDOW_DAYS * DAY_MS;
  const stats = new Map<string, InteractionStats>();
  for (const row of rows) {
    const target = companyForParty(result, companyByParty, row.partyId);
    const at = new Date(row.at);
    const time = at.getTime();
    if (!target || Number.isNaN(time)) continue;
    const { companyId, attrs } = target;
    const interaction: CompanyInteraction = { at: at.toISOString(), type: row.type, userId: row.userId };

    if (time > nowTime) {
      const planned = row.status === 'planned' || row.status === 'in_progress';
      if (planned && isEarlier(time, attrs.nextInteraction)) attrs.nextInteraction = interaction;
      continue;
    }

    if (isEarlier(time, attrs.firstInteraction)) attrs.firstInteraction = interaction;
    if (isLater(time, attrs.lastInteraction)) attrs.lastInteraction = interaction;
    countInteraction(stats, companyId, row.userId, time, recentSince);
  }
  for (const [companyId, s] of stats) {
    const attrs = result.get(companyId)!;
    attrs.connectionStrength = connectionStrengthFor(s.recent, s.past > 0);
    attrs.strongestConnectionUserId = strongestConnection(s.byUser);
  }
}

function addNextDueTasks(result: AttributesById, companyByParty: Map<string, string>, rows: DueTaskRow[]): void {
  for (const row of rows) {
    const attrs = companyForParty(result, companyByParty, row.partyId)?.attrs;
    if (!attrs || !row.dueDate) continue;
    const due = new Date(row.dueDate);
    if (!attrs.nextDueTask || due.getTime() < Date.parse(attrs.nextDueTask.dueDate)) {
      attrs.nextDueTask = { id: row.id, title: row.title, dueDate: due.toISOString() };
    }
  }
}

function addDeals(result: AttributesById, companyByParty: Map<string, string>, rows: DealRow[]): void {
  for (const row of rows) {
    companyForParty(result, companyByParty, row.partyId)?.attrs.deals.push({
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

  addTeam(result, teamRows);

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

  addInteractions(result, companyByParty, activityRows, now);
  addNextDueTasks(result, companyByParty, [...taskRows, ...activityTaskRows]);
  addDeals(result, companyByParty, dealRows);

  return result;
}
