/**
 * People: lists and profiles from the project's Durable Object (ADR PANEL-004),
 * plus what Basin knows about them (recent events, sessions, event counts).
 *
 * The profile is the object's, mutable and erasable; the activity is Basin's, a
 * minute or two behind. A cohort filter on the list is resolved in Basin (the
 * ids of the people who match), then each profile is read from the object.
 */

import type { Database } from '@weldsuite/worker-kit/db';
import type {
  PanelActivityEvent,
  PanelPeopleByEmailDto,
  PanelPersonByEmail,
  PanelPersonDto,
  PanelPersonProfile,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import {
  PanelQueryError,
  activityCountQuery,
  activityEventFrom,
  activityQuery,
  createRunner,
  eventsScope,
  resolveRange,
  runPanelQuery,
  type PanelQueryContext,
  type Row,
} from '@weldsuite/panel-domain/query';
import type { Env } from '../types';
import { listProjects } from './projects';
import { basinExecutor, QueryUnavailableError } from './query-engine';
import type { QueryRunDeps } from './query-run';
import { fullRange, markFavorites, sessionContext, sessionsSpec } from './recordings';
import { numberOf, textOf } from './rows';

const RECENT_EVENTS = 25;
const PROFILE_SESSIONS = 10;
const CARD_EVENTS = 10;
const CARD_SESSIONS = 5;
const MAX_CARD_PROJECTS = 25;
const MAX_COHORT_REACH = 500;

/** A recent event that is worth a line in a feed: not a page leave or an identity link. */
const FEED_EXCLUDED = ['$pageleave', '$identify'] as const;

function requireObject(env: Env, projectId: string) {
  if (!env.PANEL_PROJECT) throw new QueryUnavailableError('People are not configured here');
  return projectObjectStub(env.PANEL_PROJECT, projectId);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface PeoplePageInput {
  search?: string;
  cursor?: string | null;
  limit: number;
  cohortId?: string;
}

export interface PeoplePage {
  people: PanelPersonDto[];
  cursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

function matchesSearch(person: PanelPersonDto, search: string): boolean {
  const needle = search.toLowerCase();
  return [person.userId, person.email, person.name].some((value) => value?.toLowerCase().includes(needle));
}

function parseOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^o(\d{1,4})$/.exec(cursor);
  if (!match) throw new PanelQueryError('Invalid cursor');
  return Number(match[1]);
}

/** The people of a cohort, most recently seen first: the ids Basin finds, read as profiles from the object. */
async function cohortPeople(deps: QueryRunDeps, projectId: string, input: PeoplePageInput & { cohortId: string }): Promise<PeoplePage> {
  const { env } = deps;
  const stub = requireObject(env, projectId);
  const offset = parseOffset(input.cursor);
  if (offset + input.limit > MAX_COHORT_REACH) throw new PanelQueryError('Narrow the search to see further');

  // A sessions spec names the cohort, so the context loads its definition.
  const ctx = await sessionContext(deps, projectId, { cohortId: input.cohortId });
  const range = resolveRange(fullRange(ctx.now), 'UTC', ctx);
  const scope = eventsScope(ctx, range, range, { filters: [{ source: 'cohort', cohortId: input.cohortId }] });
  const [rows = []] = await createRunner(basinExecutor(env)).run([
    {
      name: 'people.cohort',
      sql:
        `SELECT ${scope.person} AS person, MAX(e.ts) AS last_seen FROM ${scope.from} ${scope.where()} ` +
        `GROUP BY ${scope.person} ORDER BY MAX(e.ts) DESC LIMIT ${MAX_COHORT_REACH + 1}`,
      columns: ['person', 'last_seen'],
    },
  ]);

  const ids = rows.map((row) => textOf(row.person)).filter((id) => id !== '');
  const profiles = (await Promise.all(ids.map((id) => stub.getPerson(id)))).filter((p): p is PanelPersonDto => p !== null);
  const unique = [...new Map(profiles.map((p) => [p.userId, p])).values()];
  const matching = input.search?.trim() ? unique.filter((p) => matchesSearch(p, input.search as string)) : unique;
  const page = matching.slice(offset, offset + input.limit);
  const hasMore = matching.length > offset + input.limit;
  return { people: page, cursor: hasMore ? `o${offset + input.limit}` : null, hasMore, totalCount: matching.length };
}

export async function listPeople(deps: QueryRunDeps, projectId: string, input: PeoplePageInput): Promise<PeoplePage> {
  if (input.cohortId) return cohortPeople(deps, projectId, { ...input, cohortId: input.cohortId });
  const stub = requireObject(deps.env, projectId);
  const page = await stub.listPeople({ search: input.search?.trim() || undefined, cursor: input.cursor ?? null, limit: input.limit });
  return { people: page.people, cursor: page.cursor, hasMore: page.cursor !== null, totalCount: page.totalCount };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function eventsFrom(rows: readonly Row[]): PanelActivityEvent[] {
  return rows.map(activityEventFrom);
}

async function sessionsOf(deps: QueryRunDeps, ctx: PanelQueryContext, distinctId: string, limit: number): Promise<PanelSessionRow[]> {
  const { result } = await runPanelQuery(sessionsSpec(ctx.projectId, { distinctId, limit }), ctx, basinExecutor(deps.env));
  const sessions = result.kind === 'sessions' ? result.result.sessions : [];
  return markFavorites(deps.tenantDb, ctx.projectId, sessions);
}

export interface ProfileOptions {
  /** Include the person's recordings (needs `panel_recordings:read`). */
  includeSessions: boolean;
}

/** Null when the object has no such person (never seen, or erased). */
export async function loadProfile(
  deps: QueryRunDeps,
  projectId: string,
  distinctId: string,
  options: ProfileOptions,
): Promise<PanelPersonProfile | null> {
  const stub = requireObject(deps.env, projectId);
  const person = await stub.getPerson(distinctId);
  if (!person) return null;

  const ctx = await sessionContext(deps, projectId);
  const [[eventRows = [], countRows = []], sessions] = await Promise.all([
    createRunner(basinExecutor(deps.env)).run([
      activityQuery(ctx, { distinctId: person.userId, limit: RECENT_EVENTS, days: 90, excludeNames: FEED_EXCLUDED }),
      activityCountQuery(ctx, person.userId),
    ]),
    options.includeSessions ? sessionsOf(deps, ctx, person.userId, PROFILE_SESSIONS) : Promise.resolve([]),
  ]);

  return {
    projectId,
    person,
    recentEvents: eventsFrom(eventRows),
    sessions,
    eventCount90d: numberOf(countRows[0]?.n),
  };
}

// ---------------------------------------------------------------------------
// By email (the WeldCRM person card)
// ---------------------------------------------------------------------------

/**
 * Profiles in any of the workspace's projects whose `$email` matches, each
 * with its recent events (and recordings when allowed). One project failing
 * to answer leaves its activity empty rather than breaking the card.
 */
export async function peopleByEmail(deps: QueryRunDeps, db: Database, email: string, options: ProfileOptions): Promise<PanelPeopleByEmailDto> {
  const { env } = deps;
  const namespace = env.PANEL_PROJECT;
  if (!namespace) throw new QueryUnavailableError('People are not configured here');
  const needle = email.trim().toLowerCase();

  const projects = (await listProjects(db)).slice(0, MAX_CARD_PROJECTS);
  const perProject = await Promise.all(
    projects.map(async (project): Promise<PanelPersonByEmail[]> => {
      const found = await projectObjectStub(namespace, project.id).findByEmail(needle);
      return Promise.all(
        found.map(async (person): Promise<PanelPersonByEmail> => {
          let recentEvents: PanelActivityEvent[] = [];
          let sessions: PanelSessionRow[] = [];
          try {
            const ctx = await sessionContext(deps, project.id);
            const [[rows = []], sessionRows] = await Promise.all([
              createRunner(basinExecutor(env)).run([
                activityQuery(ctx, { distinctId: person.userId, limit: CARD_EVENTS, days: 90, excludeNames: FEED_EXCLUDED }),
              ]),
              options.includeSessions ? sessionsOf(deps, ctx, person.userId, CARD_SESSIONS) : Promise.resolve([]),
            ]);
            recentEvents = eventsFrom(rows);
            sessions = sessionRows;
          } catch (err) {
            console.warn(`[panel-api] website activity for the CRM card failed (project ${project.id})`, err);
          }
          return { projectId: project.id, projectName: project.name, person, recentEvents, sessions };
        }),
      );
    }),
  );
  return { people: perProject.flat() };
}
