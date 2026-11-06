/**
 * The member's inbox state (PATCH /api/merge/inbox/items/:itemKey, POST
 * /api/merge/inbox/read-all) and how GET /api/merge/inbox applies it, on a real
 * tenant schema (pglite). What must not regress:
 *   1. Items start unread with no snooze; PATCH sets read, snoozedUntil and
 *      archived (and undoes them), only the fields given, per member.
 *   2. Archived and still-snoozed items are left out of the list unless
 *      `?include=archived` / `?include=snoozed`; a snooze that has passed is over.
 *   3. read-all marks the member's visible unread items read and counts them;
 *      another member's state is never touched.
 *   4. State changes publish no entity events; both routes need
 *      merge_pull_requests:read; bad input is 400.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MergeInboxItem } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeInboxItemStateDto, MergeInboxReadAllResult } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import inboxRoutes from './index';
import inboxStateRoutes from './state';
import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { ADMIN, ALICE, BOB, events, jsonInit, makeApp, ok, openDb, resetTables } from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

const combined = new Hono<{ Bindings: Env; Variables: Variables }>();
combined.route('/', inboxRoutes);
combined.route('/', inboxStateRoutes);

const BASE = '/api/merge/inbox';
const inbox = (userId = ALICE, grants = ADMIN) => makeApp(db, BASE, combined, { grants, userId });
const list = async (query = '', userId = ALICE) => ok<MergeInboxItem[]>(await inbox(userId).request(`${BASE}${query}`));
const patch = (itemKey: string, body: unknown, userId = ALICE, grants = ADMIN) =>
  inbox(userId, grants).request(`${BASE}/items/${encodeURIComponent(itemKey)}`, jsonInit(body, 'PATCH'));
const patchOk = async (itemKey: string, body: unknown, userId = ALICE) => ok<MergeInboxItemStateDto>(await patch(itemKey, body, userId));

/** Alice owns a failing pull request and has an assigned issue: two inbox items. */
async function seedAliceItems() {
  const team = await seedTeam(db, 'PLAT');
  const connection = await seedConnection(db);
  const repo = await seedRepository(db, connection.id);
  const pr = await seedPullRequest(db, repo.id, 1, { authorUserId: ALICE, checksStatus: 'failure' });
  const issue = await seedIssue(db, team.id, 1, { assigneeUserId: ALICE });
  return { pr, issue, prKey: `checks_failed:${pr.id}`, issueKey: `assigned:${issue.id}` };
}

describe('item state', () => {
  it('starts unread and unsnoozed, then marks read and back', async () => {
    const { prKey } = await seedAliceItems();
    expect((await list()).map((i) => [i.id, i.read, i.snoozedUntil])).toContainEqual([prKey, false, null]);

    expect(await patchOk(prKey, { read: true })).toEqual({ itemKey: prKey, read: true, snoozedUntil: null, archived: false });
    expect((await list()).find((i) => i.id === prKey)).toMatchObject({ read: true });
    expect(await patchOk(prKey, { read: false })).toMatchObject({ read: false });
    expect((await list()).find((i) => i.id === prKey)).toMatchObject({ read: false });
    expect(events).toEqual([]);
  });

  it('keeps the other fields when one changes', async () => {
    const { prKey } = await seedAliceItems();
    const until = new Date(Date.now() + 3600_000).toISOString();
    await patchOk(prKey, { read: true, snoozedUntil: until });
    expect(await patchOk(prKey, { archived: true })).toEqual({ itemKey: prKey, read: true, snoozedUntil: until, archived: true });
    expect(await patchOk(prKey, { archived: false, snoozedUntil: null })).toEqual({ itemKey: prKey, read: true, snoozedUntil: null, archived: false });
    expect(await db.select().from(schema.mergeInboxStates)).toHaveLength(1);
  });

  it("is the member's own: the same key holds separate state per member", async () => {
    const { prKey } = await seedAliceItems();
    await patchOk(prKey, { read: true, archived: true });
    await patchOk(prKey, { read: false }, BOB);
    expect((await list('', ALICE)).map((i) => i.id)).not.toContain(prKey);
    const states = await db.select().from(schema.mergeInboxStates);
    expect(states.map((x) => [x.userId, x.readAt !== null, x.archivedAt !== null]).sort()).toEqual([
      [ALICE, true, true],
      [BOB, false, false],
    ]);
  });
});

describe('what the list leaves out', () => {
  it('archived items, unless ?include=archived', async () => {
    const { prKey, issueKey } = await seedAliceItems();
    await patchOk(prKey, { archived: true });
    expect((await list()).map((i) => i.id)).toEqual([issueKey]);
    expect((await list('?include=archived')).map((i) => i.id).sort()).toEqual([issueKey, prKey].sort());
    await patchOk(prKey, { archived: false });
    expect((await list()).map((i) => i.id).sort()).toEqual([issueKey, prKey].sort());
  });

  it('still-snoozed items, unless ?include=snoozed, and wakes them when the time has passed', async () => {
    const { prKey, issueKey } = await seedAliceItems();
    const until = new Date(Date.now() + 3600_000).toISOString();
    await patchOk(prKey, { snoozedUntil: until });
    expect((await list()).map((i) => i.id)).toEqual([issueKey]);
    const shown = await list('?include=snoozed');
    expect(shown.find((i) => i.id === prKey)).toMatchObject({ snoozedUntil: until });

    await patchOk(prKey, { snoozedUntil: new Date(Date.now() - 1000).toISOString() });
    expect((await list()).find((i) => i.id === prKey)).toMatchObject({ snoozedUntil: null });
  });

  it('rejects an unknown include value', async () => {
    expect((await inbox().request(`${BASE}?include=everything`)).status).toBe(400);
  });
});

describe('POST /read-all', () => {
  it('marks every visible unread item read and counts them, skipping archived and snoozed ones', async () => {
    const { prKey, issueKey } = await seedAliceItems();
    expect(await ok<MergeInboxReadAllResult>(await inbox().request(`${BASE}/read-all`, jsonInit({})))).toEqual({ updated: 2 });
    expect((await list()).every((i) => i.read)).toBe(true);
    expect(await ok<MergeInboxReadAllResult>(await inbox().request(`${BASE}/read-all`, jsonInit({})))).toEqual({ updated: 0 });

    await patchOk(prKey, { read: false, archived: true });
    await patchOk(issueKey, { read: false });
    expect(await ok<MergeInboxReadAllResult>(await inbox().request(`${BASE}/read-all`, jsonInit({})))).toEqual({ updated: 1 });
    const states = await db.select().from(schema.mergeInboxStates);
    expect(states.find((s) => s.itemKey === prKey)!.readAt).toBeNull();
    expect(events).toEqual([]);
  });

  it('never touches another member\'s state', async () => {
    const { issueKey } = await seedAliceItems();
    await patchOk(issueKey, { read: false }, BOB);
    await inbox().request(`${BASE}/read-all`, jsonInit({}));
    const bob = (await db.select().from(schema.mergeInboxStates)).find((s) => s.userId === BOB);
    expect(bob!.readAt).toBeNull();
  });
});

describe('validation and permissions', () => {
  it('answers 400 for an empty or malformed patch and an over-long key', async () => {
    expect((await patch('checks_failed:mpr_1', {})).status).toBe(400);
    expect((await patch('checks_failed:mpr_1', { read: 'yes' })).status).toBe(400);
    expect((await patch('checks_failed:mpr_1', { snoozedUntil: 'tomorrow' })).status).toBe(400);
    expect((await patch('x'.repeat(201), { read: true })).status).toBe(400);
    expect(await db.select().from(schema.mergeInboxStates)).toEqual([]);
  });

  it('needs merge_pull_requests:read', async () => {
    expect((await patch('checks_failed:mpr_1', { read: true }, ALICE, [])).status).toBe(403);
    expect((await patch('checks_failed:mpr_1', { read: true }, ALICE, ['merge_issues:read'])).status).toBe(403);
    expect((await inbox(ALICE, []).request(`${BASE}/read-all`, jsonInit({}))).status).toBe(403);
  });
});
