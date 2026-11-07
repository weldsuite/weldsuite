/**
 * The WeldChat daily digest sweep against a real tenant schema (pglite) and the
 * D1 due index (SQLite). What must not regress:
 *   1. Only workspaces the index lists are opened; a due workspace posts the
 *      digests whose hour it is and is re-armed for the next hour any of its
 *      digests is due, or dropped when it has none.
 *   2. The digest says what waits for review, what fails its checks and what
 *      was done in the last day, scoped to the subscription; a quiet day posts
 *      nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Env } from '../types';

let db: Database;
const tenantDbFor = vi.fn(async (_env: unknown, _ref: string) => db);

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: (env: unknown, ref: string) => tenantDbFor(env, ref),
    getWorkspaceForOrg: async (_env: unknown, ref: string) => ({ id: 'ws_alpha', clerkOrgId: ref }),
  };
});

import { DIGEST_SWEEP_CRONS, isDigestSweepCron, runDigestSweep } from './digest-sweep';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../test/seed';

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const NINE = new Date(Date.UTC(2026, 10, 5, 9, 0, 0));
const DAY = 24 * 3_600_000;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  tenantDbFor.mockClear();
  const s = schema;
  await db.delete(s.chatMessages);
  await db.delete(s.chatChannelMembers);
  await db.delete(s.chatChannels);
  await db.delete(s.mergeChatSubscriptions);
  await db.delete(s.mergePullRequests);
  await db.delete(s.mergeIssues);
  await db.delete(s.mergeRepositories);
  await db.delete(s.mergeConnections);
  await db.delete(s.mergeTeams);
});

function makeEnv() {
  const d1 = createSqliteD1(MIGRATION);
  return { d1, env: { SCHEDULE_INDEX: d1, WORKSPACE_CACHE: createMemoryKv() } as unknown as Env };
}

const dueAt = (d1: D1Database, org = 'org_alpha') =>
  d1.prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?').bind('merge_digest', org).first<number>('next_due_at');

async function seedChannel(name = 'dev') {
  const [row] = await db.insert(schema.chatChannels).values({ id: generateId('chan'), name, slug: name, type: 'public' }).returning();
  return row!;
}

async function seedSubscription(channelId: string, overrides: Partial<typeof schema.mergeChatSubscriptions.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.mergeChatSubscriptions)
    .values({ id: generateId('mcs'), channelId, events: ['daily_digest'], digestHour: 9, createdByUserId: 'user_alice', ...overrides })
    .returning();
  return row!;
}

const messagesIn = (channelId: string) =>
  db.select().from(schema.chatMessages).where(eq(schema.chatMessages.channelId, channelId)).orderBy(asc(schema.chatMessages.createdAt));

describe('isDigestSweepCron', () => {
  it('runs hourly', () => {
    expect(DIGEST_SWEEP_CRONS).toEqual(['0 * * * *']);
    expect(isDigestSweepCron('0 * * * *')).toBe(true);
    expect(isDigestSweepCron('*/5 * * * *')).toBe(false);
  });
});

describe('runDigestSweep', () => {
  async function seedActivity() {
    const team = await seedTeam(db);
    const other = await seedTeam(db, 'OPS');
    const connection = await seedConnection(db);
    const web = await seedRepository(db, connection.id, { teamId: team.id });
    const api = await seedRepository(db, connection.id, { externalId: '901', fullName: 'acme/api', teamId: other.id });
    await seedPullRequest(db, web.id, 1, { title: 'Needs eyes' });
    await seedPullRequest(db, web.id, 2, { title: 'Draft work', draft: true });
    await seedPullRequest(db, web.id, 3, { title: 'Already approved', reviewDecision: 'approved' });
    await seedPullRequest(db, web.id, 4, { title: 'Red build', checksStatus: 'failure', reviewDecision: 'approved' });
    await seedPullRequest(db, web.id, 5, { title: 'Merged', state: 'merged', checksStatus: 'failure' });
    await seedPullRequest(db, api.id, 6, { title: 'Other team' });
    await seedIssue(db, team.id, 1, { status: 'done', title: 'Shipped yesterday', completedAt: new Date(NINE.getTime() - 3_600_000) });
    await seedIssue(db, team.id, 2, { status: 'done', title: 'Done last week', completedAt: new Date(NINE.getTime() - 3 * DAY) });
    await seedIssue(db, team.id, 3, { status: 'todo', title: 'Not done' });
    return { team, other, web, api };
  }

  it('posts the digest whose hour it is and re-arms the workspace for the next day', async () => {
    const { team } = await seedActivity();
    const channel = await seedChannel();
    await seedSubscription(channel.id, { teamId: team.id });
    const { d1, env } = makeEnv();
    await markWorkspaceDue(d1, 'merge_digest', 'org_alpha', NINE.getTime());

    const result = await runDigestSweep(env, NINE);
    expect(result).toMatchObject({ due: 1, processed: 1, failed: 0 });
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(tenantDbFor.mock.calls[0]![1]).toBe('org_alpha');

    const [message, ...rest] = await messagesIn(channel.id);
    expect(rest).toEqual([]);
    expect(message).toMatchObject({ authorId: 'app:weldmerge', authorType: 'system', metadata: { weldmerge: { kind: 'daily_digest' } } });
    expect(message!.content).toBe(
      [
        'WeldMerge daily digest',
        '',
        'Waiting for review (1)',
        '- acme/web#1 Needs eyes',
        '',
        'Checks failing (1)',
        '- acme/web#4 Red build',
        '',
        'Done in the last day (1)',
        '- PLAT-1 Shipped yesterday',
      ].join('\n'),
    );
    expect(await dueAt(d1)).toBe(NINE.getTime() + DAY);
  });

  it('scopes the digest to the subscribed repository, which hears about no issues', async () => {
    const { api } = await seedActivity();
    const channel = await seedChannel();
    await seedSubscription(channel.id, { repositoryId: api.id });
    const { d1, env } = makeEnv();
    await markWorkspaceDue(d1, 'merge_digest', 'org_alpha', NINE.getTime());

    await runDigestSweep(env, NINE);
    const [message] = await messagesIn(channel.id);
    expect(message!.content).toBe('WeldMerge daily digest\n\nWaiting for review (1)\n- acme/api#6 Other team');
  });

  it('posts nothing on a quiet day, or when it is not the digest hour, and re-arms for the earliest next hour', async () => {
    const team = await seedTeam(db);
    const quiet = await seedChannel('quiet');
    const later = await seedChannel('later');
    await seedSubscription(quiet.id, { teamId: team.id, digestHour: 9 });
    await seedSubscription(later.id, { teamId: team.id, digestHour: 15 });
    await seedIssue(db, team.id, 1, { status: 'done', title: 'Shipped', completedAt: new Date(NINE.getTime() - 3_600_000) });
    const { d1, env } = makeEnv();
    await markWorkspaceDue(d1, 'merge_digest', 'org_alpha', NINE.getTime());

    await runDigestSweep(env, NINE);
    // 09:00: the 15:00 digest is not due; the 09:00 one has news, so it posts.
    expect(await messagesIn(later.id)).toHaveLength(0);
    expect(await messagesIn(quiet.id)).toHaveLength(1);
    expect(await dueAt(d1)).toBe(NINE.getTime() + 6 * 3_600_000);

    // The next day at 09:00 there is no news any more: nothing is posted.
    await markWorkspaceDue(d1, 'merge_digest', 'org_alpha', NINE.getTime() + DAY);
    await runDigestSweep(env, new Date(NINE.getTime() + DAY));
    expect(await messagesIn(quiet.id)).toHaveLength(1);
  });

  it('drops the workspace from the index when it has no digest subscription left', async () => {
    const channel = await seedChannel();
    await seedSubscription(channel.id, { events: ['issue_done'] });
    await seedSubscription(channel.id, { events: ['daily_digest'], deletedAt: new Date() });
    const { d1, env } = makeEnv();
    await markWorkspaceDue(d1, 'merge_digest', 'org_alpha', NINE.getTime());

    await runDigestSweep(env, NINE);
    expect(await dueAt(d1)).toBeNull();
    expect(await messagesIn(channel.id)).toHaveLength(0);
  });

  it('opens only the workspaces that are due, and nothing without the index', async () => {
    const { d1, env } = makeEnv();
    await markWorkspaceDue(d1, 'merge_digest', 'org_later', NINE.getTime() + 3_600_000);
    expect(await runDigestSweep(env, NINE)).toMatchObject({ due: 0, processed: 0 });
    expect(tenantDbFor).not.toHaveBeenCalled();

    const none = await runDigestSweep({ WORKSPACE_CACHE: createMemoryKv() } as unknown as Env, NINE);
    expect(none).toMatchObject({ due: 0, processed: 0 });
  });

  it('keeps going when one digest fails to post, without retrying the others', async () => {
    const { team } = await seedActivity();
    const broken = await seedChannel('broken');
    const fine = await seedChannel('fine');
    await seedSubscription(broken.id, { teamId: team.id });
    await seedSubscription(fine.id, { teamId: team.id });
    // A channel that is gone: the insert of its message fails on the foreign key.
    await db.delete(schema.chatChannels).where(eq(schema.chatChannels.id, broken.id));
    const { d1, env } = makeEnv();
    await markWorkspaceDue(d1, 'merge_digest', 'org_alpha', NINE.getTime());
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runDigestSweep(env, NINE);
    log.mockRestore();
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(await messagesIn(fine.id)).toHaveLength(1);
    expect(await dueAt(d1)).toBe(NINE.getTime() + DAY);
  });
});
