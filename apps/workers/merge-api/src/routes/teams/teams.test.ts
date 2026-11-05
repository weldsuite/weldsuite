/**
 * DB-backed tests for /api/merge/teams, /labels and /cycles on a real tenant
 * schema (pglite). What must not regress:
 *   1. Teams, labels and cycles are read with merge_teams:read and changed only
 *      with merge_teams:manage.
 *   2. A team key is fixed once the team has issues, and a team with live
 *      issues cannot be deleted (409).
 *   3. Cycle numbers run per team; deleting a cycle leaves its issues without one.
 *   4. Every mutation publishes its entity event.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  MergeCycleDto,
  MergeLabelDto,
  MergeTeamDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import teamsRoutes from './index';
import labelsRoutes from '../labels';
import cyclesRoutes from '../cycles';
import {
  ADMIN,
  MEMBER,
  VIEWER,
  clearEvents,
  errorCode,
  eventTypes,
  events,
  jsonInit,
  makeApp,
  newId,
  ok,
  openDb,
  resetTables,
} from '../../test/helpers';
import { seedIssue, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

const teams = (grants = ADMIN) => makeApp(db, '/api/merge/teams', teamsRoutes, { grants });
const labels = (grants = ADMIN) => makeApp(db, '/api/merge/labels', labelsRoutes, { grants });
const cycles = (grants = ADMIN) => makeApp(db, '/api/merge/cycles', cyclesRoutes, { grants });

describe('teams', () => {
  it('creates a team with an upper-cased key and publishes merge_team:created', async () => {
    const res = await teams().request('/api/merge/teams', jsonInit({ key: ' plat ', name: ' Platform ', color: '#6e56cf' }));
    const team = await ok<MergeTeamDto>(res, 201);
    expect(team).toMatchObject({ key: 'PLAT', name: 'Platform', color: '#6e56cf', description: null, openIssueCount: 0 });
    expect(team.id).toMatch(/^mtm_/);
    expect(eventTypes()).toEqual(['merge_team:created']);
    expect(events[0]!.data).toEqual({ id: newId(team.id), key: 'PLAT', name: 'Platform' });
  });

  it('refuses a duplicate key with 409', async () => {
    await seedTeam(db, 'PLAT');
    const res = await teams().request('/api/merge/teams', jsonInit({ key: 'plat', name: 'Other' }));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('CONFLICT');
    expect(events).toEqual([]);
  });

  it('refuses bad input with 400 and changes nothing', async () => {
    const bad: Array<[unknown, string]> = [
      [{}, 'missing key and name'],
      [{ key: 'P', name: 'x' }, 'key too short'],
      [{ key: '1ABC', name: 'x' }, 'key starting with a digit'],
      [{ key: 'PLATFORMXXL', name: 'x' }, 'key too long'],
      [{ key: 'PLAT', name: '   ' }, 'blank name'],
      [{ key: 'PLAT', name: 'x', color: 'red' }, 'colour not hex'],
    ];
    for (const [body, why] of bad) {
      const res = await teams().request('/api/merge/teams', jsonInit(body));
      expect(res.status, why).toBe(400);
    }
    expect(await db.select().from(schema.mergeTeams)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('lists teams by key with their open issue counts, and reads one', async () => {
    const api = await seedTeam(db, 'API');
    const plat = await seedTeam(db, 'PLAT');
    await seedIssue(db, plat.id, 1, { status: 'todo' });
    await seedIssue(db, plat.id, 2, { status: 'done' });
    await seedIssue(db, plat.id, 3, { status: 'canceled' });
    await seedIssue(db, plat.id, 4, { status: 'in_progress' });
    await seedIssue(db, plat.id, 5, { status: 'todo', deletedAt: new Date() });

    const res = await teams(VIEWER).request('/api/merge/teams');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: MergeTeamDto[]; pagination: unknown };
    expect(body.data.map((t) => [t.key, t.openIssueCount])).toEqual([
      ['API', 0],
      ['PLAT', 2],
    ]);
    expect(body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });

    expect(await ok<MergeTeamDto>(await teams().request(`/api/merge/teams/${api.id}`))).toMatchObject({ key: 'API' });
    const missing = await teams().request('/api/merge/teams/mtm_unknown');
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('NOT_FOUND');
  });

  it('renames a team freely, and changes its key only while it has no issues', async () => {
    const team = await seedTeam(db, 'OLD');
    const renamed = await ok<MergeTeamDto>(
      await teams().request(`/api/merge/teams/${team.id}`, jsonInit({ name: 'Renamed', key: 'new' }, 'PATCH')),
    );
    expect(renamed).toMatchObject({ key: 'NEW', name: 'Renamed' });
    expect(eventTypes()).toEqual(['merge_team:updated']);

    await seedIssue(db, team.id, 1);
    const locked = await teams().request(`/api/merge/teams/${team.id}`, jsonInit({ key: 'OTHER' }, 'PATCH'));
    expect(locked.status).toBe(409);
    // The same key is not a change.
    const same = await teams().request(`/api/merge/teams/${team.id}`, jsonInit({ key: 'new', name: 'Again' }, 'PATCH'));
    expect(same.status).toBe(200);

    await seedTeam(db, 'TAKEN');
    const other = await seedTeam(db, 'FREE');
    const taken = await teams().request(`/api/merge/teams/${other.id}`, jsonInit({ key: 'TAKEN' }, 'PATCH'));
    expect(taken.status).toBe(409);

    expect((await teams().request(`/api/merge/teams/${team.id}`, jsonInit({}, 'PATCH'))).status).toBe(400);
    expect((await teams().request('/api/merge/teams/mtm_unknown', jsonInit({ name: 'x' }, 'PATCH'))).status).toBe(404);
  });

  it('refuses to delete a team with live issues, and deletes an empty one with its cycles and labels', async () => {
    const busy = await seedTeam(db, 'BUSY');
    await seedIssue(db, busy.id, 1);
    expect((await teams().request(`/api/merge/teams/${busy.id}`, { method: 'DELETE' })).status).toBe(409);

    const empty = await seedTeam(db, 'EMPTY');
    await db.insert(schema.mergeLabels).values({ id: 'mlb_x', teamId: empty.id, name: 'bug' });
    clearEvents();
    expect((await teams().request(`/api/merge/teams/${empty.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_team:deleted']);
    const [gone] = await db.select().from(schema.mergeTeams).where(eq(schema.mergeTeams.id, empty.id));
    expect(gone!.deletedAt).not.toBeNull();
    const [label] = await db.select().from(schema.mergeLabels).where(eq(schema.mergeLabels.id, 'mlb_x'));
    expect(label!.deletedAt).not.toBeNull();
    expect((await teams().request(`/api/merge/teams/${empty.id}`)).status).toBe(404);
    // Its key is free again.
    expect((await teams().request('/api/merge/teams', jsonInit({ key: 'EMPTY', name: 'Again' }))).status).toBe(201);
  });

  it('lets any reader read teams, and only merge_teams:manage change them', async () => {
    const team = await seedTeam(db, 'PLAT');
    for (const grants of [MEMBER, VIEWER]) {
      expect((await teams(grants).request('/api/merge/teams')).status).toBe(200);
      expect((await teams(grants).request('/api/merge/teams', jsonInit({ key: 'NEW', name: 'x' }))).status).toBe(403);
      expect((await teams(grants).request(`/api/merge/teams/${team.id}`, jsonInit({ name: 'x' }, 'PATCH'))).status).toBe(403);
      expect((await teams(grants).request(`/api/merge/teams/${team.id}`, { method: 'DELETE' })).status).toBe(403);
    }
    expect((await teams([]).request('/api/merge/teams')).status).toBe(403);
    expect(events).toEqual([]);
  });
});

describe('labels', () => {
  it('creates a team label and a workspace-wide label, and lists a team with the wide ones', async () => {
    const team = await seedTeam(db, 'PLAT');
    const other = await seedTeam(db, 'API');
    const mine = await ok<MergeLabelDto>(await labels().request('/api/merge/labels', jsonInit({ teamId: team.id, name: 'bug', color: '#d73a4a' })), 201);
    expect(mine).toMatchObject({ teamId: team.id, name: 'bug', color: '#d73a4a' });
    const wide = await ok<MergeLabelDto>(await labels().request('/api/merge/labels', jsonInit({ name: 'security' })), 201);
    expect(wide.teamId).toBeNull();
    await ok(await labels().request('/api/merge/labels', jsonInit({ teamId: other.id, name: 'mobile' })), 201);
    expect(eventTypes()).toEqual(['merge_label:created', 'merge_label:created', 'merge_label:created']);

    const forTeam = await ok<MergeLabelDto[]>(await labels(VIEWER).request(`/api/merge/labels?teamId=${team.id}`));
    expect(forTeam.map((l) => l.name)).toEqual(['bug', 'security']);
    const all = await ok<MergeLabelDto[]>(await labels(VIEWER).request('/api/merge/labels'));
    expect(all.map((l) => l.name)).toEqual(['bug', 'mobile', 'security']);
  });

  it('refuses a duplicate name in the same scope, an unknown team, and bad input', async () => {
    const team = await seedTeam(db, 'PLAT');
    await labels().request('/api/merge/labels', jsonInit({ teamId: team.id, name: 'Bug' }));
    const dupe = await labels().request('/api/merge/labels', jsonInit({ teamId: team.id, name: 'bug' }));
    expect(dupe.status).toBe(409);
    expect((await labels().request('/api/merge/labels', jsonInit({ teamId: 'mtm_unknown', name: 'x' }))).status).toBe(404);
    expect((await labels().request('/api/merge/labels', jsonInit({ name: '' }))).status).toBe(400);
    expect((await labels().request('/api/merge/labels', jsonInit({ name: 'x', color: 'blue' }))).status).toBe(400);
  });

  it('updates and deletes a label, 404 for an unknown one, 403 without manage', async () => {
    const label = await ok<MergeLabelDto>(await labels().request('/api/merge/labels', jsonInit({ name: 'bug' })), 201);
    clearEvents();
    const updated = await ok<MergeLabelDto>(
      await labels().request(`/api/merge/labels/${label.id}`, jsonInit({ name: 'defect', color: null }, 'PATCH')),
    );
    expect(updated).toMatchObject({ name: 'defect', color: null });
    expect((await labels().request(`/api/merge/labels/${label.id}`, jsonInit({}, 'PATCH'))).status).toBe(400);
    expect((await labels(MEMBER).request(`/api/merge/labels/${label.id}`, jsonInit({ name: 'x' }, 'PATCH'))).status).toBe(403);
    expect((await labels(MEMBER).request(`/api/merge/labels/${label.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await labels().request('/api/merge/labels/mlb_unknown', jsonInit({ name: 'x' }, 'PATCH'))).status).toBe(404);

    expect((await labels().request(`/api/merge/labels/${label.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_label:updated', 'merge_label:deleted']);
    expect((await labels().request(`/api/merge/labels/${label.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await ok<MergeLabelDto[]>(await labels().request('/api/merge/labels'))).toEqual([]);
  });
});

describe('cycles', () => {
  const body = (teamId: string, extra: Record<string, unknown> = {}) => ({
    teamId,
    startsAt: '2026-11-02',
    endsAt: '2026-11-15',
    ...extra,
  });

  it('numbers cycles per team and counts their issues', async () => {
    const plat = await seedTeam(db, 'PLAT');
    const api = await seedTeam(db, 'API');
    const first = await ok<MergeCycleDto>(await cycles().request('/api/merge/cycles', jsonInit(body(plat.id, { name: 'Sprint' }))), 201);
    const second = await ok<MergeCycleDto>(await cycles().request('/api/merge/cycles', jsonInit(body(plat.id))), 201);
    const otherTeam = await ok<MergeCycleDto>(await cycles().request('/api/merge/cycles', jsonInit(body(api.id))), 201);
    expect([first.number, second.number, otherTeam.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({ name: 'Sprint', startsAt: '2026-11-02', endsAt: '2026-11-15', issueCount: 0 });
    expect(eventTypes()).toEqual(['merge_cycle:created', 'merge_cycle:created', 'merge_cycle:created']);

    await seedIssue(db, plat.id, 1, { cycleId: first.id, status: 'done' });
    await seedIssue(db, plat.id, 2, { cycleId: first.id, status: 'todo' });
    await seedIssue(db, plat.id, 3, { cycleId: first.id, status: 'todo', deletedAt: new Date() });
    const listed = await ok<MergeCycleDto[]>(await cycles(VIEWER).request(`/api/merge/cycles?teamId=${plat.id}`));
    expect(listed.map((c) => [c.number, c.issueCount, c.completedIssueCount])).toEqual([
      [2, 0, 0],
      [1, 2, 1],
    ]);
  });

  it('never reuses a deleted cycle number, and frees its issues', async () => {
    const team = await seedTeam(db, 'PLAT');
    const cycle = await ok<MergeCycleDto>(await cycles().request('/api/merge/cycles', jsonInit(body(team.id))), 201);
    const issue = await seedIssue(db, team.id, 1, { cycleId: cycle.id, title: 'Keep me', priority: 2 });
    clearEvents();

    expect((await cycles().request(`/api/merge/cycles/${cycle.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_cycle:deleted']);
    const [after] = await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, issue.id));
    expect(after).toMatchObject({ cycleId: null, title: 'Keep me', priority: 2 });

    const next = await ok<MergeCycleDto>(await cycles().request('/api/merge/cycles', jsonInit(body(team.id))), 201);
    expect(next.number).toBe(2);
  });

  it('updates a cycle, and refuses a range that ends before it starts', async () => {
    const team = await seedTeam(db, 'PLAT');
    const cycle = await ok<MergeCycleDto>(await cycles().request('/api/merge/cycles', jsonInit(body(team.id))), 201);
    const updated = await ok<MergeCycleDto>(
      await cycles().request(`/api/merge/cycles/${cycle.id}`, jsonInit({ name: 'Renamed', endsAt: '2026-11-20' }, 'PATCH')),
    );
    expect(updated).toMatchObject({ name: 'Renamed', endsAt: '2026-11-20', number: 1 });

    const early = await cycles().request(`/api/merge/cycles/${cycle.id}`, jsonInit({ endsAt: '2026-11-01' }, 'PATCH'));
    expect(early.status).toBe(422);
    expect((await cycles().request('/api/merge/cycles', jsonInit(body(team.id, { endsAt: '2026-11-01' })))).status).toBe(400);
    expect((await cycles().request('/api/merge/cycles', jsonInit(body(team.id, { startsAt: 'tomorrow' })))).status).toBe(400);
    expect((await cycles().request(`/api/merge/cycles/${cycle.id}`, jsonInit({}, 'PATCH'))).status).toBe(400);
    expect((await cycles().request('/api/merge/cycles', jsonInit(body('mtm_unknown')))).status).toBe(404);
    expect((await cycles().request('/api/merge/cycles/mcy_unknown', jsonInit({ name: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await cycles().request('/api/merge/cycles/mcy_unknown', { method: 'DELETE' })).status).toBe(404);
  });

  it('needs merge_teams:manage to change cycles', async () => {
    const team = await seedTeam(db, 'PLAT');
    expect((await cycles(MEMBER).request('/api/merge/cycles', jsonInit(body(team.id)))).status).toBe(403);
    expect((await cycles(MEMBER).request('/api/merge/cycles/mcy_x', jsonInit({ name: 'x' }, 'PATCH'))).status).toBe(403);
    expect((await cycles(MEMBER).request('/api/merge/cycles/mcy_x', { method: 'DELETE' })).status).toBe(403);
    expect((await cycles([]).request('/api/merge/cycles')).status).toBe(403);
  });
});
