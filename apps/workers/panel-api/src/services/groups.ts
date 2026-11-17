/**
 * Group analytics: group types (`panel_group_types`, the project's
 * configuration), group profiles (the project's Durable Object, ADR
 * PANEL-004) and what Basin knows about a group (its recent events, its
 * members and its event count).
 *
 * A project collects at most `MAX_GROUP_TYPES` types. The object hands out
 * the slots: a type takes one the first time data names it or when a member
 * creates it here, and gives it back when its configuration is deleted. A
 * type can therefore be collected without a row (data named it first), which
 * the list shows as not configured.
 *
 * Group activity is read with an event-property filter on `$group_<type>`,
 * through `eventsScope`, so every statement carries the workspace and project
 * scope, the time bound and the erased-id exclusion like any other query.
 *
 * The WeldCRM match reads the type's `crmMatchProperty` from the profile and
 * looks for a company in the same tenant DB: by website host (or email
 * domain) when the value is a domain, URL or email address, else by name.
 */

import { and, asc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { PanelGroupType } from '@weldsuite/db/schema';
import type { PanelActivityEvent } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { groupKeyProperty, type PanelFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  PanelGroupCrmCompanyDto,
  PanelGroupDto,
  PanelGroupMemberDto,
  PanelGroupProfileDto,
  PanelGroupTypeDto,
  ParsedCreatePanelGroupTypeInput,
  ParsedUpdatePanelGroupTypeInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { projectObjectStub, type PanelGroup, type PanelProjectObjectApi } from '@weldsuite/panel-domain/project-object';
import {
  activityEventFrom,
  createRunner,
  eventsScope,
  lit,
  resolveRange,
  type PanelQueryContext,
  type PanelSqlQuery,
} from '@weldsuite/panel-domain/query';
import { MAX_GROUP_TYPES } from '@weldsuite/panel-domain/wire';
import type { Env } from '../types';
import { basinExecutor, QueryUnavailableError } from './query-engine';
import type { QueryRunDeps } from './query-run';
import { sessionContext, today } from './recordings';
import { isoOf, numberOf, textOf } from './rows';

const { companies, panelGroupTypes } = schema;

const RECENT_EVENTS = 25;
const TOP_MEMBERS = 50;
const CRM_CANDIDATES = 20;
const DAY_MS = 86_400_000;

/** A recent event that is worth a line in a feed: not a page leave or an identity link. */
const FEED_EXCLUDED = ['$pageleave', '$identify'] as const;

const ACTIVITY_COLUMNS = ['event_id', 'name', 'ts', 'path', 'url', 'title', 'session_id', 'el_text', 'error_message', 'properties'] as const;

/** The project's object; throws {@link QueryUnavailableError} (503) when the binding is missing. */
export function requireGroupObject(env: Env, projectId: string): PanelProjectObjectApi {
  if (!env.PANEL_PROJECT) throw new QueryUnavailableError('Groups are not configured here');
  return projectObjectStub(env.PANEL_PROJECT, projectId);
}

/** The types the project's object collects, or null when the binding is missing here. */
export async function collectedGroupTypes(env: Env, projectId: string): Promise<string[] | null> {
  if (!env.PANEL_PROJECT) return null;
  return projectObjectStub(env.PANEL_PROJECT, projectId).groupTypes();
}

// ---------------------------------------------------------------------------
// Group types (tenant DB)
// ---------------------------------------------------------------------------

/** `company` → Company / Companies, `billing_account` → Billing account / Billing accounts. */
export function defaultGroupTypeNames(groupType: string): { nameSingular: string; namePlural: string } {
  const words = groupType.replaceAll('_', ' ').trim();
  const singular = words.charAt(0).toUpperCase() + words.slice(1);
  let plural: string;
  if (/[^aeiou]y$/.test(singular)) plural = `${singular.slice(0, -1)}ies`;
  else if (/(?:s|x|z|ch|sh)$/.test(singular)) plural = `${singular}es`;
  else plural = `${singular}s`;
  return { nameSingular: singular, namePlural: plural };
}

export function toGroupTypeDto(row: PanelGroupType, collecting: boolean): PanelGroupTypeDto {
  return {
    id: row.id,
    projectId: row.projectId,
    groupType: row.groupType,
    nameSingular: row.nameSingular,
    namePlural: row.namePlural,
    crmMatchProperty: row.crmMatchProperty,
    configured: true,
    collecting,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A type the object collects that has no row. */
export function unconfiguredGroupTypeDto(projectId: string, groupType: string): PanelGroupTypeDto {
  return {
    id: null,
    projectId,
    groupType,
    ...defaultGroupTypeNames(groupType),
    crmMatchProperty: null,
    configured: false,
    collecting: true,
    createdAt: null,
    updatedAt: null,
  };
}

/** The configured rows (oldest first), then the collected types without a row (in the order they were taken). */
export function mergeGroupTypes(projectId: string, rows: readonly PanelGroupType[], collected: readonly string[] | null): PanelGroupTypeDto[] {
  const taken = new Set(collected ?? []);
  const configured = new Set(rows.map((r) => r.groupType));
  return [
    ...rows.map((row) => toGroupTypeDto(row, taken.has(row.groupType))),
    ...(collected ?? []).filter((type) => !configured.has(type)).map((type) => unconfiguredGroupTypeDto(projectId, type)),
  ];
}

/** What a group type puts on the entity bus. */
export function groupTypeEventData(row: PanelGroupType) {
  return { id: row.id, projectId: row.projectId, groupType: row.groupType, nameSingular: row.nameSingular, namePlural: row.namePlural };
}

export async function listGroupTypeRows(db: Database, projectId: string): Promise<PanelGroupType[]> {
  return db
    .select()
    .from(panelGroupTypes)
    .where(eq(panelGroupTypes.projectId, projectId))
    .orderBy(asc(panelGroupTypes.createdAt), asc(panelGroupTypes.id));
}

export async function getGroupTypeRow(db: Database, id: string): Promise<PanelGroupType | null> {
  const [row] = await db.select().from(panelGroupTypes).where(eq(panelGroupTypes.id, id)).limit(1);
  return row ?? null;
}

export async function groupTypeRowFor(db: Database, projectId: string, groupType: string): Promise<PanelGroupType | null> {
  const [row] = await db
    .select()
    .from(panelGroupTypes)
    .where(and(eq(panelGroupTypes.projectId, projectId), eq(panelGroupTypes.groupType, groupType)))
    .limit(1);
  return row ?? null;
}

export type CreateGroupTypeResult =
  | { kind: 'created'; row: PanelGroupType }
  | { kind: 'duplicate' }
  /** No slot: `types` are the configured types (row limit) or the object's (slot limit). */
  | { kind: 'limit'; types: string[] };

/**
 * Configures a type: refuses a duplicate and a sixth row, then asks the
 * object for a slot (it may already hold five types data named first), and
 * only then writes the row.
 */
export async function createGroupType(env: Env, db: Database, input: ParsedCreatePanelGroupTypeInput): Promise<CreateGroupTypeResult> {
  const existing = await listGroupTypeRows(db, input.projectId);
  if (existing.some((row) => row.groupType === input.groupType)) return { kind: 'duplicate' };
  if (existing.length >= MAX_GROUP_TYPES) return { kind: 'limit', types: existing.map((row) => row.groupType) };

  const types = await requireGroupObject(env, input.projectId).ensureGroupTypes([input.groupType]);
  if (!types.includes(input.groupType)) return { kind: 'limit', types };

  try {
    const [row] = await db
      .insert(panelGroupTypes)
      .values({
        id: generateId('pngt'),
        projectId: input.projectId,
        groupType: input.groupType,
        nameSingular: input.nameSingular,
        namePlural: input.namePlural,
        crmMatchProperty: input.crmMatchProperty ?? null,
      })
      .returning();
    if (!row) throw new Error('The group type was not written');
    return { kind: 'created', row };
  } catch (err) {
    // Created by a concurrent request between the check and the insert.
    if (isUniqueViolation(err)) return { kind: 'duplicate' };
    throw err;
  }
}

export async function updateGroupType(db: Database, id: string, input: ParsedUpdatePanelGroupTypeInput): Promise<PanelGroupType | null> {
  const patch: Partial<Pick<PanelGroupType, 'nameSingular' | 'namePlural' | 'crmMatchProperty'>> = {};
  if (input.nameSingular !== undefined) patch.nameSingular = input.nameSingular;
  if (input.namePlural !== undefined) patch.namePlural = input.namePlural;
  if (input.crmMatchProperty !== undefined) patch.crmMatchProperty = input.crmMatchProperty;
  const [row] = await db
    .update(panelGroupTypes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(panelGroupTypes.id, id))
    .returning();
  return row ?? null;
}

/**
 * Deletes the row, then frees the object's slot. Best effort on the slot: a
 * missing binding or a failing object leaves the type collected (it then
 * shows as not configured, and can be configured and deleted again).
 */
export async function deleteGroupType(env: Env, db: Database, id: string): Promise<PanelGroupType | null> {
  const [row] = await db.delete(panelGroupTypes).where(eq(panelGroupTypes.id, id)).returning();
  if (!row) return null;
  if (!env.PANEL_PROJECT) {
    console.warn(`[panel-api] PANEL_PROJECT is not bound; the slot of a deleted group type stays taken (project ${row.projectId})`);
    return row;
  }
  try {
    await projectObjectStub(env.PANEL_PROJECT, row.projectId).releaseGroupType(row.groupType);
  } catch (err) {
    console.warn(`[panel-api] could not free a deleted group type's slot (project ${row.projectId})`, err);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Groups (the project's object)
// ---------------------------------------------------------------------------

function displayName(properties: Record<string, unknown>): string | null {
  for (const key of ['$name', 'name']) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

export function toGroupDto(group: PanelGroup): PanelGroupDto {
  return {
    groupType: group.groupType,
    groupKey: group.groupKey,
    name: displayName(group.properties),
    properties: group.properties,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
  };
}

export interface GroupsPageInput {
  type: string;
  search?: string;
  cursor?: string | null;
  limit: number;
}

export interface GroupsPage {
  groups: PanelGroupDto[];
  cursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

export async function listGroups(env: Env, projectId: string, input: GroupsPageInput): Promise<GroupsPage> {
  const page = await requireGroupObject(env, projectId).listGroups({
    groupType: input.type,
    search: input.search?.trim() || undefined,
    cursor: input.cursor ?? null,
    limit: input.limit,
  });
  return { groups: page.groups.map(toGroupDto), cursor: page.cursor, hasMore: page.cursor !== null, totalCount: page.totalCount };
}

/** Deletes the profile (the object writes a `deleted` row to `groups_v1`); false when there was none. */
export async function deleteGroup(env: Env, workspaceId: string, projectId: string, groupType: string, groupKey: string): Promise<boolean> {
  return requireGroupObject(env, projectId).deleteGroup({ workspaceId, projectId, groupType, groupKey });
}

// ---------------------------------------------------------------------------
// Group activity (Basin)
// ---------------------------------------------------------------------------

/** Events whose `$group_<type>` property is the key. */
export function groupFilter(groupType: string, groupKey: string): PanelFilter {
  return { source: 'event', key: groupKeyProperty(groupType), operator: 'eq', value: groupKey };
}

/** The last `days` days (today included), within the plan's retention. */
function lastDays(ctx: PanelQueryContext, days: number) {
  const now = ctx.now ?? new Date();
  return resolveRange({ from: today(new Date(now.getTime() - (days - 1) * DAY_MS)), to: today(now) }, 'UTC', ctx);
}

/** The group's recent events, its counts (events, people, first and last event) and its most recently seen people. */
export function groupActivityQueries(ctx: PanelQueryContext, groupType: string, groupKey: string, days: number): PanelSqlQuery[] {
  const range = lastDays(ctx, days);
  const scope = eventsScope(ctx, range, range, { filters: [groupFilter(groupType, groupKey)] });
  const feed = `e.name NOT IN (${FEED_EXCLUDED.map(lit).join(', ')})`;
  return [
    {
      name: 'groups.events',
      sql:
        `SELECT e.event_id AS event_id, e.name AS name, e.ts AS ts, e.path AS path, e.url AS url, e.title AS title, e.session_id AS session_id, ` +
        `e.el_text AS el_text, e.error_message AS error_message, e.properties AS properties ` +
        `FROM ${scope.from} ${scope.where(feed)} ORDER BY e.ts DESC LIMIT ${RECENT_EVENTS}`,
      columns: ACTIVITY_COLUMNS,
    },
    {
      name: 'groups.stats',
      sql:
        `SELECT COUNT(*) AS n, COUNT(DISTINCT ${scope.person}) AS members, MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen ` +
        `FROM ${scope.from} ${scope.where()}`,
      columns: ['n', 'members', 'first_seen', 'last_seen'],
    },
    {
      name: 'groups.members',
      sql:
        `SELECT ${scope.person} AS person, MAX(e.ts) AS last_seen, COUNT(*) AS n FROM ${scope.from} ${scope.where()} ` +
        `GROUP BY ${scope.person} ORDER BY MAX(e.ts) DESC LIMIT ${TOP_MEMBERS}`,
      columns: ['person', 'last_seen', 'n'],
    },
  ];
}

export interface GroupProfileOptions {
  days: number;
  /** How to look up the WeldCRM company; null when the caller cannot read companies. */
  crm: CrmLookup | null;
}

/** Null when the object has no such group and no event in the window names it. */
export async function loadGroupProfile(
  deps: QueryRunDeps,
  projectId: string,
  groupType: string,
  groupKey: string,
  options: GroupProfileOptions,
): Promise<PanelGroupProfileDto | null> {
  const stub = requireGroupObject(deps.env, projectId);
  const execute = basinExecutor(deps.env);
  const [group, typeRow, ctx] = await Promise.all([
    stub.getGroup(groupType, groupKey),
    groupTypeRowFor(deps.tenantDb, projectId, groupType),
    sessionContext(deps, projectId),
  ]);
  const [eventRows = [], statRows = [], memberRows = []] = await createRunner(execute).run(groupActivityQueries(ctx, groupType, groupKey, options.days));

  const stats = statRows[0] ?? {};
  const eventCount = numberOf(stats.n);
  if (!group && eventCount === 0) return null;

  const recentEvents: PanelActivityEvent[] = eventRows.map(activityEventFrom);
  const members: PanelGroupMemberDto[] = memberRows
    .map((row) => ({ distinctId: textOf(row.person), lastSeen: isoOf(row.last_seen), eventCount: numberOf(row.n) }))
    .filter((member) => member.distinctId !== '');

  const matchProperty = typeRow?.crmMatchProperty ?? null;
  const matchValue = group && matchProperty ? group.properties[matchProperty] : undefined;
  const crmCompany =
    options.crm && (typeof matchValue === 'string' || typeof matchValue === 'number')
      ? await matchCrmCompany(deps.tenantDb, String(matchValue), options.crm)
      : null;

  return {
    projectId,
    group: group
      ? toGroupDto(group)
      : { groupType, groupKey, name: null, properties: {}, firstSeen: isoOf(stats.first_seen), lastSeen: isoOf(stats.last_seen) },
    hasProfile: group !== null,
    days: options.days,
    recentEvents,
    eventCount,
    members,
    memberCount: numberOf(stats.members),
    crmCompany,
  };
}

// ---------------------------------------------------------------------------
// WeldCRM company match
// ---------------------------------------------------------------------------

export interface CrmLookup {
  /** Only companies this member owns (callers without `companies:scope:all`). */
  ownerScope?: string;
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `acme.com` from `acme.com`, `https://www.acme.com/about` or `ceo@acme.com`; null when the value is none of those. */
export function domainOf(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase() ?? '';
  if (text === '' || /\s/.test(text)) return null;
  const at = text.lastIndexOf('@');
  const candidate = at >= 0 && !text.includes('://') ? text.slice(at + 1) : text;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(candidate) ? candidate : `https://${candidate}`).hostname.replace(/^www\./, '');
    return DOMAIN.test(host) ? host : null;
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The company a group's match value names: a live (not deleted) company whose
 * website host or email domain is the value's domain, else whose name or
 * display name equals the value (case-insensitive). Oldest first on ties.
 */
export async function matchCrmCompany(db: Database, value: string, lookup: CrmLookup): Promise<PanelGroupCrmCompanyDto | null> {
  const needle = value.trim();
  if (needle === '') return null;
  const live: SQL[] = [isNull(companies.deletedAt)];
  if (lookup.ownerScope) live.push(eq(companies.ownerId, lookup.ownerScope));
  const columns = { id: companies.id, displayName: companies.displayName, website: companies.website, email: companies.email };
  const toDto = (c: { id: string; displayName: string; website: string | null }): PanelGroupCrmCompanyDto => ({
    id: c.id,
    name: c.displayName,
    domain: domainOf(c.website),
  });

  const domain = domainOf(needle);
  if (domain) {
    const like = escapeLike(domain);
    const candidates = await db
      .select(columns)
      .from(companies)
      .where(and(...live, or(ilike(companies.website, `%${like}%`), ilike(companies.email, `%@${like}`))))
      .orderBy(asc(companies.createdAt), asc(companies.id))
      .limit(CRM_CANDIDATES);
    const hit =
      candidates.find((c) => domainOf(c.website) === domain) ?? candidates.find((c) => c.email !== null && domainOf(c.email) === domain);
    if (hit) return toDto(hit);
  }

  const lower = needle.toLowerCase();
  const [byName] = await db
    .select(columns)
    .from(companies)
    .where(and(...live, or(sql`lower(${companies.displayName}) = ${lower}`, sql`lower(${companies.name}) = ${lower}`)))
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(1);
  return byName ? toDto(byName) : null;
}
