/**
 * DB-backed tests for /api/merge/chat-subscriptions and the posts they cause, on
 * a real tenant schema (pglite). What must not regress:
 *   1. Subscriptions: CRUD with events, merge_teams:manage to change, a channel
 *      the member cannot open or an unknown team or repository is a 404, and a
 *      daily digest marks the workspace due in the `merge_digest` index.
 *   2. Posting: an issue created or done, a review request, failed checks, a
 *      merged pull request and a shipped release each post one card to every
 *      subscribed channel whose team and repository fit (never twice to the
 *      same channel), as `app:weldmerge` with `metadata.weldmerge`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import type { MergeChatSubscriptionDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import chatSubscriptionsRoutes from './index';
import issuesRoutes from '../issues';
import releasesRoutes from '../releases';
import { afterPullRequestSynced } from '../../services/chat/hooks';
import { nextDigestAt, subscribedChannels } from '../../services/chat/subscriptions';
import { upsertPullRequest } from '../../services/pr-sync';
import type { HookContext } from '../../services/hooks';
import {
  ADMIN,
  ALICE,
  MEMBER,
  VIEWER,
  clearEvents,
  eventTypes,
  events,
  githubPull,
  jsonInit,
  makeApp,
  newId,
  ok,
  openDb,
  resetTables,
} from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await db.delete(schema.chatMessages);
  await db.delete(schema.chatChannelMembers);
  await db.delete(schema.chatChannels);
});

const BASE = '/api/merge/chat-subscriptions';
const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const subs = (grants = ADMIN, env: Record<string, unknown> = {}) => makeApp(db, BASE, chatSubscriptionsRoutes, { grants, env });

async function seedChannel(name: string, overrides: Partial<typeof schema.chatChannels.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.chatChannels)
    .values({ id: generateId('chan'), name, slug: name, type: 'public', ...overrides })
    .returning();
  return row!;
}

async function subscribe(channelId: string, body: Record<string, unknown> = {}, env: Record<string, unknown> = {}) {
  return ok<MergeChatSubscriptionDto>(
    await subs(ADMIN, env).request(BASE, jsonInit({ channelId, events: ['issue_created'], ...body })),
    201,
  );
}

const messagesIn = (channelId: string) =>
  db.select().from(schema.chatMessages).where(eq(schema.chatMessages.channelId, channelId)).orderBy(asc(schema.chatMessages.createdAt));

describe('subscriptions', () => {
  it('creates, lists, edits and deletes with events', async () => {
    const channel = await seedChannel('dev');
    const team = await seedTeam(db);
    const created = await subscribe(channel.id, { teamId: team.id, events: ['issue_created', 'issue_created', 'release_shipped'] });
    expect(created).toMatchObject({ channelId: channel.id, teamId: team.id, repositoryId: null, events: ['issue_created', 'release_shipped'], digestHour: 9, createdByUserId: ALICE });
    expect(events.map((e) => [e.eventType, e.entityId])).toEqual([['merge_chat_subscription:created', newId(created.id)]]);

    const other = await seedChannel('ops');
    await subscribe(other.id);
    expect((await ok<MergeChatSubscriptionDto[]>(await subs().request(BASE))).map((s) => s.channelId)).toEqual([channel.id, other.id]);
    expect((await ok<MergeChatSubscriptionDto[]>(await subs().request(`${BASE}?channelId=${other.id}`))).map((s) => s.channelId)).toEqual([other.id]);
    expect((await ok<MergeChatSubscriptionDto[]>(await subs().request(`${BASE}?teamId=${team.id}`))).map((s) => s.channelId)).toEqual([channel.id]);

    clearEvents();
    const edited = await ok<MergeChatSubscriptionDto>(
      await subs().request(`${BASE}/${created.id}`, jsonInit({ teamId: null, events: ['checks_failed'], digestHour: 17 }, 'PATCH')),
    );
    expect(edited).toMatchObject({ teamId: null, events: ['checks_failed'], digestHour: 17 });
    expect(events[0]!.eventType).toBe('merge_chat_subscription:updated');
    expect(events[0]!.changes).toMatchObject({ teamId: { old: team.id, new: null }, digestHour: { old: 9, new: 17 } });

    clearEvents();
    expect((await subs().request(`${BASE}/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_chat_subscription:deleted']);
    expect((await ok<MergeChatSubscriptionDto[]>(await subs().request(BASE))).map((s) => s.id)).not.toContain(created.id);
    expect((await subs().request(`${BASE}/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers 400 for a bad body, 404 for unknown references and 403 without the permission', async () => {
    const channel = await seedChannel('dev');
    const priv = await seedChannel('secret', { type: 'private' });
    const created = await subscribe(channel.id);
    const post = (body: unknown, grants = ADMIN) => subs(grants).request(BASE, jsonInit(body));

    expect((await post({ channelId: channel.id, events: [] })).status).toBe(400);
    expect((await post({ channelId: channel.id, events: ['nope'] })).status).toBe(400);
    expect((await post({ channelId: channel.id, events: ['issue_done'], digestHour: 24 })).status).toBe(400);
    expect((await subs().request(`${BASE}/${created.id}`, jsonInit({}, 'PATCH'))).status).toBe(400);
    // Unknown, and private without membership: both are 404.
    expect((await post({ channelId: 'chan_nope', events: ['issue_done'] })).status).toBe(404);
    expect((await post({ channelId: priv.id, events: ['issue_done'] })).status).toBe(404);
    expect((await post({ channelId: channel.id, events: ['issue_done'], teamId: 'mtm_nope' })).status).toBe(404);
    expect((await post({ channelId: channel.id, events: ['issue_done'], repositoryId: 'mrp_nope' })).status).toBe(404);
    expect((await subs().request(`${BASE}/mcs_nope`, jsonInit({ digestHour: 3 }, 'PATCH'))).status).toBe(404);
    expect((await subs().request(`${BASE}/${created.id}`, jsonInit({ teamId: 'mtm_nope' }, 'PATCH'))).status).toBe(404);

    // MEMBER and VIEWER list, but only merge_teams:manage changes.
    expect((await subs(MEMBER).request(BASE)).status).toBe(200);
    expect((await subs(VIEWER).request(BASE)).status).toBe(200);
    expect((await post({ channelId: channel.id, events: ['issue_done'] }, MEMBER)).status).toBe(403);
    expect((await subs(MEMBER).request(`${BASE}/${created.id}`, jsonInit({ digestHour: 3 }, 'PATCH'))).status).toBe(403);
    expect((await subs(MEMBER).request(`${BASE}/${created.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await subs([]).request(BASE)).status).toBe(403);
  });

  it('marks the workspace due at the next digest hour, only for subscriptions with a daily digest', async () => {
    const channel = await seedChannel('dev');
    const d1 = createSqliteD1(MIGRATION);
    const dueAt = () =>
      d1.prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?').bind('merge_digest', 'org_alpha').first<number>('next_due_at');

    await subscribe(channel.id, { events: ['issue_done'] }, { SCHEDULE_INDEX: d1 });
    expect(await dueAt()).toBeNull();

    // Hours relative to now, so "sooner" and "later" hold at any time of day:
    // the next (now + 2)h comes before the next (now + 10)h, which comes before the next (now + 20)h.
    const before = Date.now();
    const hourFromNow = (offset: number) => (new Date(before).getUTCHours() + offset) % 24;
    const [sooner, middle, later] = [hourFromNow(2), hourFromNow(10), hourFromNow(20)];
    const digest = await subscribe(channel.id, { events: ['daily_digest'], digestHour: middle }, { SCHEDULE_INDEX: d1 });
    const first = new Date((await dueAt())!);
    expect([first.getUTCHours(), first.getUTCMinutes(), first.getUTCSeconds()]).toEqual([middle, 0, 0]);
    expect(first.getTime()).toBeGreaterThan(before);
    expect(first.getTime() - before).toBeLessThanOrEqual(24 * 3_600_000);

    // A sooner hour pulls the due time forward; a later one never pushes it back.
    await subs(ADMIN, { SCHEDULE_INDEX: d1 }).request(`${BASE}/${digest.id}`, jsonInit({ digestHour: sooner }, 'PATCH'));
    const earlier = new Date((await dueAt())!);
    expect(earlier.getUTCHours()).toBe(sooner);
    expect(earlier.getTime()).toBeLessThan(first.getTime());
    await subs(ADMIN, { SCHEDULE_INDEX: d1 }).request(`${BASE}/${digest.id}`, jsonInit({ digestHour: later }, 'PATCH'));
    expect(new Date((await dueAt())!).getUTCHours()).toBe(sooner);
  });
});

describe('subscribedChannels and nextDigestAt', () => {
  const row = (channelId: string, teamId: string | null, repositoryId: string | null) =>
    ({ channelId, teamId, repositoryId }) as Parameters<typeof subscribedChannels>[0][number];

  it('matches team and repository filters, each channel once', () => {
    const rows = [row('a', null, null), row('b', 't1', null), row('c', 't2', null), row('d', null, 'r1'), row('a', 't1', null)];
    expect(subscribedChannels(rows, { teamId: 't1', repositoryId: 'r1' })).toEqual(['a', 'b', 'd']);
    expect(subscribedChannels(rows, { teamId: 't1', repositoryId: null })).toEqual(['a', 'b']);
    expect(subscribedChannels(rows, { teamId: null, repositoryId: null })).toEqual(['a']);
  });

  it('is the next UTC hour strictly after the given time', () => {
    expect(nextDigestAt(9, new Date('2026-11-05T08:30:00Z')).toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(nextDigestAt(9, new Date('2026-11-05T09:00:00Z')).toISOString()).toBe('2026-11-06T09:00:00.000Z');
    expect(nextDigestAt(0, new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('posting', () => {
  const issues = (grants = ADMIN) => makeApp(db, '/api/merge/issues', issuesRoutes, { grants });
  const releases = (grants = ADMIN) => makeApp(db, '/api/merge/releases', releasesRoutes, { grants });

  const hookContext = (): HookContext => ({
    db,
    env: { ENTITY_EVENTS: undefined } as never,
    userId: 'system',
    workspaceId: 'ws_alpha',
    clerkOrgId: 'org_alpha',
  });

  it('posts a created issue to the subscribed channels of its team, once per channel', async () => {
    const team = await seedTeam(db);
    const otherTeam = await seedTeam(db, 'OPS');
    const all = await seedChannel('all');
    const mine = await seedChannel('mine');
    const theirs = await seedChannel('theirs');
    const wrongEvent = await seedChannel('quiet');
    await subscribe(all.id);
    await subscribe(mine.id, { teamId: team.id });
    await subscribe(mine.id, { events: ['issue_created', 'issue_done'] });
    await subscribe(theirs.id, { teamId: otherTeam.id });
    await subscribe(wrongEvent.id, { events: ['issue_done'] });
    clearEvents();

    const res = await issues().request('/api/merge/issues', jsonInit({ teamId: team.id, title: 'Fix the tabs' }));
    const issue = await ok<{ id: string; key: string }>(res, 201);

    const [message, ...rest] = await messagesIn(all.id);
    expect(rest).toEqual([]);
    expect(message).toMatchObject({
      authorId: 'app:weldmerge',
      authorName: 'WeldMerge',
      authorType: 'system',
      content: 'Issue PLAT-1 created: Fix the tabs',
      metadata: { weldmerge: { kind: 'issue_created', issueId: issue.id } },
    });
    expect(await messagesIn(mine.id)).toHaveLength(1);
    expect(await messagesIn(theirs.id)).toHaveLength(0);
    expect(await messagesIn(wrongEvent.id)).toHaveLength(0);
    expect(eventTypes()).toEqual(['merge_issue:created', 'chat_message:created', 'chat_message:created']);
  });

  it('posts an issue that turned done, not one that was already done', async () => {
    const team = await seedTeam(db);
    const channel = await seedChannel('dev');
    await subscribe(channel.id, { events: ['issue_done'] });
    const issue = await seedIssue(db, team.id, 1, { status: 'in_progress', title: 'Slow search' });

    await ok(await issues().request(`/api/merge/issues/${issue.id}`, jsonInit({ status: 'done' }, 'PATCH')));
    await ok(await issues().request(`/api/merge/issues/${issue.id}`, jsonInit({ title: 'Slow search!' }, 'PATCH')));
    const posted = await messagesIn(channel.id);
    expect(posted.map((m) => m.content)).toEqual(['Issue PLAT-1 is done: Slow search']);
    expect(posted[0]!.metadata).toEqual({ weldmerge: { kind: 'issue_done', issueId: issue.id } });
  });

  it('posts a review request for the new reviewers, and a merge, as the webhook sync sees them', async () => {
    const team = await seedTeam(db);
    const connection = await seedConnection(db);
    const repository = await seedRepository(db, connection.id, { teamId: team.id });
    const otherRepository = await seedRepository(db, connection.id, { externalId: '901', fullName: 'acme/api', teamId: team.id });
    const reviews = await seedChannel('reviews');
    const merges = await seedChannel('merges');
    const apiOnly = await seedChannel('api-only');
    await subscribe(reviews.id, { events: ['review_requested'], teamId: team.id });
    await subscribe(merges.id, { events: ['pull_request_merged'], repositoryId: repository.id });
    await subscribe(apiOnly.id, { events: ['review_requested', 'pull_request_merged'], repositoryId: otherRepository.id });
    clearEvents();
    const hooks = hookContext();

    const opened = await upsertPullRequest(db, repository, githubPull({ id: 5001, number: 1, title: 'Fix tabs', reviewers: ['Octo-Rev'] }), { automate: true, hooks });
    const pr = opened.pullRequest!;
    const asked = await messagesIn(reviews.id);
    expect(asked.map((m) => m.content)).toEqual([`Review requested from octo-rev on acme/web#1: Fix tabs\n${pr.url}`]);
    expect(asked[0]!.metadata).toEqual({ weldmerge: { kind: 'review_requested', pullRequestId: pr.id, itemKey: `review_requested:${pr.id}` } });

    // The same reviewer again posts nothing; a second reviewer posts only the new one.
    await upsertPullRequest(db, repository, githubPull({ id: 5001, number: 1, title: 'Fix tabs', reviewers: ['Octo-Rev'], updatedAt: '2026-11-01T11:00:00Z' }), { automate: true, hooks });
    await upsertPullRequest(db, repository, githubPull({ id: 5001, number: 1, title: 'Fix tabs', reviewers: ['Octo-Rev', 'Second'], updatedAt: '2026-11-01T12:00:00Z' }), { automate: true, hooks });
    expect((await messagesIn(reviews.id)).map((m) => m.content.split('\n')[0])).toEqual([
      'Review requested from octo-rev on acme/web#1: Fix tabs',
      'Review requested from second on acme/web#1: Fix tabs',
    ]);

    await upsertPullRequest(db, repository, githubPull({ id: 5001, number: 1, title: 'Fix tabs', merged: true, updatedAt: '2026-11-01T13:00:00Z' }), { automate: true, hooks });
    const merged = await messagesIn(merges.id);
    expect(merged.map((m) => m.content.split('\n')[0])).toEqual(['Merged acme/web#1: Fix tabs']);
    expect(merged[0]!.metadata).toEqual({ weldmerge: { kind: 'pull_request_merged', pullRequestId: pr.id } });
    expect(await messagesIn(apiOnly.id)).toHaveLength(0);
  });

  it('posts failed checks once, when the status turns failure', async () => {
    const connection = await seedConnection(db);
    const repository = await seedRepository(db, connection.id);
    const channel = await seedChannel('ci');
    await subscribe(channel.id, { events: ['checks_failed'] });
    const pending = await seedPullRequest(db, repository.id, 7, { checksStatus: 'pending', title: 'Add search' });
    const failed = { ...pending, checksStatus: 'failure' as const };

    await afterPullRequestSynced(hookContext(), pending, failed, []);
    await afterPullRequestSynced(hookContext(), failed, failed, []);
    const posted = await messagesIn(channel.id);
    expect(posted.map((m) => m.content.split('\n')[0])).toEqual(['Checks failed on acme/web#7: Add search']);
    expect(posted[0]!.metadata).toEqual({ weldmerge: { kind: 'checks_failed', pullRequestId: pending.id, itemKey: `checks_failed:${pending.id}` } });
  });

  it('posts a shipped release to the channels of its team and repository', async () => {
    const team = await seedTeam(db);
    const connection = await seedConnection(db);
    const repository = await seedRepository(db, connection.id, { teamId: team.id });
    const channel = await seedChannel('releases');
    const elsewhere = await seedChannel('elsewhere');
    await subscribe(channel.id, { events: ['release_shipped'], repositoryId: repository.id });
    const otherRepository = await seedRepository(db, connection.id, { externalId: '902', fullName: 'acme/docs', teamId: team.id });
    await subscribe(elsewhere.id, { events: ['release_shipped'], repositoryId: otherRepository.id });
    const pr = await seedPullRequest(db, repository.id, 1, { state: 'merged', mergedAt: new Date('2026-11-01T10:00:00Z'), headSha: 'abc' });
    const created = await ok<{ id: string }>(
      await releases().request('/api/merge/releases', jsonInit({ teamId: team.id, repositoryId: repository.id, name: 'Autumn', version: 'v1.1' })),
      201,
    );
    await db.insert(schema.mergeReleasePullRequests).values({ id: generateId('mrr'), releaseId: created.id, pullRequestId: pr.id });

    await ok(await releases().request(`/api/merge/releases/${created.id}/ship`, jsonInit({})));
    const posted = await messagesIn(channel.id);
    expect(posted.map((m) => m.content)).toEqual(['Shipped Autumn v1.1: 1 pull request']);
    expect(posted[0]!.metadata).toEqual({ weldmerge: { kind: 'release_shipped', releaseId: created.id } });
    expect(await messagesIn(elsewhere.id)).toHaveLength(0);
  });
});
