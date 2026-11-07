/**
 * GitHub `issues` and `issue_comment` events into WeldMerge issues
 * (POST /internal/github-event, what `MergeInternal.githubEvent` calls) on a
 * real tenant schema (pglite). What must not regress:
 *   1. `opened` creates an issue in the repository's team (labels by name, the
 *      missing ones as team labels; the assignee by linked account) and links it
 *      with the checksum of what GitHub said, `last_writer = provider`.
 *   2. Later events change the issue: title, body, labels, assignee; closed ->
 *      done (canceled for not_planned), reopened -> todo, an open status such as
 *      in_progress is kept while the issue stays open.
 *   3. An event whose checksum equals the stored one (an echo), one older than
 *      the stored copy, a pull request, an untracked or sync-off repository, one
 *      with no team, and an edit of an issue WeldMerge does not know are ignored.
 *   4. Comments are stored with `source = provider` (author login, member by
 *      linked account), an echo of a known comment is ignored, edits and deletes
 *      follow.
 *   5. A deleted GitHub issue is unlinked; WeldMerge keeps its issue.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import internalRoutes from './index';
import { ADMIN, ALICE, clearEvents, data, eventTypes, events, jsonInit, makeApp, newId, openDb, resetTables } from '../../test/helpers';
import { seedIssue } from '../../test/seed';
import {
  githubComment,
  githubIssue,
  seedAccount,
  seedExternalLink,
  seedSyncRepository,
  type GithubIssueFixture,
  type SyncSetup,
} from '../../test/github-issues';
import { checksumOf, providerFields } from '../../services/issue-sync/fields';
import { normalizeGithubIssue } from '../../services/providers/github/issues';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PATH = '/internal/github-event';
const internal = () => makeApp(db, '/internal', internalRoutes, { grants: ADMIN });

function envelope(event: string, payload: Record<string, unknown>) {
  return {
    workspaceId: 'org_alpha',
    event,
    deliveryId: 'delivery-1',
    payload: { installation: { id: 4242 }, repository: { id: 900, full_name: 'acme/web' }, ...payload },
  };
}

const issuesEvent = (action: string, issue: GithubIssueFixture) => envelope('issues', { action, issue: githubIssue(issue) });
const commentEvent = (action: string, issueNumber: number, comment: Parameters<typeof githubComment>[0] = { issueNumber }) =>
  envelope('issue_comment', { action, issue: githubIssue({ number: issueNumber }), comment: githubComment({ ...comment, issueNumber }) });

async function send(body: unknown) {
  const res = await internal().request(PATH, jsonInit(body));
  expect(res.status).toBe(200);
  return data<{ outcome: string; reason?: string }>(res);
}

const T1 = '2026-11-02T09:00:00Z';
const T2 = '2026-11-02T10:00:00Z';
const T3 = '2026-11-02T11:00:00Z';

const issues = () => db.select().from(schema.mergeIssues);
const links = () => db.select().from(schema.mergeExternalIssues);
const comments = () => db.select().from(schema.mergeComments);
const labels = () => db.select().from(schema.mergeLabels);
const issueOf = async (id: string) => (await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, id)))[0]!;

let setup: SyncSetup;

describe('issues: opened and later changes', () => {
  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'two_way');
    await seedAccount(db, ALICE, 'Octo-Alice');
    clearEvents();
  });

  it('creates an issue in the team, links it and creates the labels GitHub has and WeldMerge lacks', async () => {
    await db.insert(schema.mergeLabels).values({ id: 'mlb_bug', teamId: null, name: 'Bug' });
    const result = await send(
      issuesEvent('opened', { number: 7, title: '  Fix tabs ', body: 'Tabs break\r\nwhen resized', labels: ['bug', 'needs-design'], assignee: 'octo-alice', updatedAt: T1 }),
    );
    expect(result).toEqual({ outcome: 'applied' });

    const [issue] = await issues();
    expect(issue).toMatchObject({
      teamId: setup.team.id,
      number: 1,
      title: 'Fix tabs',
      description: 'Tabs break\r\nwhen resized',
      status: 'todo',
      assigneeUserId: ALICE,
      creatorUserId: 'system',
    });
    const created = (await labels()).filter((l) => l.id !== 'mlb_bug');
    expect(created).toMatchObject([{ name: 'needs-design', teamId: setup.team.id }]);
    expect(issue!.labelIds.sort()).toEqual(['mlb_bug', created[0]!.id].sort());

    const [link] = await links();
    expect(link).toMatchObject({
      issueId: issue!.id,
      repositoryId: setup.repo.id,
      provider: 'github',
      externalId: '7007',
      number: 7,
      url: 'https://github.com/acme/web/issues/7',
      state: 'open',
      lastWriter: 'provider',
    });
    expect(link!.providerUpdatedAt?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(link!.checksum).toBe(
      await checksumOf(
        providerFields(normalizeGithubIssue(githubIssue({ number: 7, title: '  Fix tabs ', body: 'Tabs break\r\nwhen resized', labels: ['bug', 'needs-design'], assignee: 'octo-alice', updatedAt: T1 }))),
      ),
    );
    expect(link!.checksum).toMatch(/^[0-9a-f]{64}$/);

    expect(eventTypes()).toEqual(['merge_label:created', 'merge_issue:created']);
    expect(events[1]!.data).toMatchObject({ id: newId(issue!.id), key: 'PLAT-1', title: 'Fix tabs', status: 'todo', assigneeUserId: ALICE });
    expect(events[1]!.metadata.source).toBe('system');
  });

  it('opens a closed issue as done, and a not_planned one as canceled', async () => {
    await send(issuesEvent('opened', { number: 1, state: 'closed', stateReason: 'completed', updatedAt: T1 }));
    await send(issuesEvent('opened', { number: 2, state: 'closed', stateReason: 'not_planned', updatedAt: T1 }));
    expect((await issues()).map((i) => i.status).sort()).toEqual(['canceled', 'done']);
  });

  it('ignores an echo: the same state again changes nothing and publishes nothing', async () => {
    await send(issuesEvent('opened', { number: 7, labels: ['bug'], updatedAt: T1 }));
    clearEvents();
    const result = await send(issuesEvent('edited', { number: 7, labels: ['BUG'], updatedAt: T2 }));
    expect(result).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(events).toEqual([]);
    expect(await issues()).toHaveLength(1);
  });

  it('applies title, body, labels and assignee edits and keeps the link current', async () => {
    await send(issuesEvent('opened', { number: 7, title: 'Old', body: 'Old body', updatedAt: T1 }));
    clearEvents();
    expect(
      await send(issuesEvent('edited', { number: 7, title: 'New', body: 'New body', labels: ['perf'], assignee: 'octo-alice', updatedAt: T2 })),
    ).toEqual({ outcome: 'applied' });

    const [issue] = await issues();
    expect(issue).toMatchObject({ title: 'New', description: 'New body', assigneeUserId: ALICE, status: 'todo' });
    expect(issue!.labelIds).toHaveLength(1);
    expect(eventTypes()).toEqual(['merge_label:created', 'merge_issue:updated']);
    expect(events[1]!.changes).toMatchObject({
      title: { old: 'Old', new: 'New' },
      description: { old: 'Old body', new: 'New body' },
      assigneeUserId: { old: null, new: ALICE },
    });
    const [link] = await links();
    expect(link!.providerUpdatedAt?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(link!.lastWriter).toBe('provider');
  });

  it('closed -> done, closed as not planned -> canceled, reopened -> todo', async () => {
    await send(issuesEvent('opened', { number: 7, updatedAt: T1 }));
    const [issue] = await issues();

    await send(issuesEvent('closed', { number: 7, state: 'closed', stateReason: 'completed', updatedAt: T2 }));
    expect(await issueOf(issue!.id)).toMatchObject({ status: 'done' });
    expect((await issueOf(issue!.id)).completedAt).not.toBeNull();

    await send(issuesEvent('reopened', { number: 7, updatedAt: T3 }));
    expect(await issueOf(issue!.id)).toMatchObject({ status: 'todo' });

    await send(issuesEvent('closed', { number: 7, state: 'closed', stateReason: 'not_planned', updatedAt: '2026-11-02T12:00:00Z' }));
    expect(await issueOf(issue!.id)).toMatchObject({ status: 'canceled' });
    expect((await links())[0]!.state).toBe('closed');
  });

  it('keeps an open status the member already set while the issue stays open', async () => {
    await send(issuesEvent('opened', { number: 7, updatedAt: T1 }));
    const [issue] = await issues();
    await db.update(schema.mergeIssues).set({ status: 'in_progress' }).where(eq(schema.mergeIssues.id, issue!.id));
    await send(issuesEvent('edited', { number: 7, title: 'Renamed', updatedAt: T2 }));
    expect(await issueOf(issue!.id)).toMatchObject({ status: 'in_progress', title: 'Renamed' });
  });

  it('leaves an assignee GitHub names but WeldMerge cannot map alone, and clears one that was linked', async () => {
    await send(issuesEvent('opened', { number: 7, updatedAt: T1 }));
    const [issue] = await issues();
    await db.update(schema.mergeIssues).set({ assigneeUserId: 'user_unlinked' }).where(eq(schema.mergeIssues.id, issue!.id));
    await send(issuesEvent('assigned', { number: 7, assignee: 'someone-else', updatedAt: T2 }));
    expect((await issueOf(issue!.id)).assigneeUserId).toBe('user_unlinked');

    await db.update(schema.mergeIssues).set({ assigneeUserId: ALICE }).where(eq(schema.mergeIssues.id, issue!.id));
    await send(issuesEvent('unassigned', { number: 7, assignee: null, updatedAt: T3 }));
    expect((await issueOf(issue!.id)).assigneeUserId).toBeNull();
  });

  it('ignores a copy older than the stored one', async () => {
    await send(issuesEvent('opened', { number: 7, title: 'Newer', updatedAt: T2 }));
    expect(await send(issuesEvent('edited', { number: 7, title: 'Older', updatedAt: T1 }))).toEqual({ outcome: 'ignored', reason: 'stale' });
    expect((await issues())[0]!.title).toBe('Newer');
  });

  it('ignores an edit of an issue WeldMerge does not know, but opens it on reopened', async () => {
    expect(await send(issuesEvent('edited', { number: 9, updatedAt: T1 }))).toEqual({ outcome: 'ignored', reason: 'unlinked_issue' });
    expect(await issues()).toEqual([]);
    expect(await send(issuesEvent('reopened', { number: 9, updatedAt: T1 }))).toEqual({ outcome: 'applied' });
    expect(await issues()).toHaveLength(1);
  });

  it('ignores actions it does not sync, pull requests and a payload without an issue', async () => {
    expect(await send(issuesEvent('locked', { number: 7 }))).toEqual({ outcome: 'ignored', reason: 'unsupported_action' });
    expect(await send(issuesEvent('opened', { number: 8, pullRequest: true }))).toEqual({ outcome: 'ignored', reason: 'pull_request' });
    expect(await send(envelope('issues', { action: 'opened' }))).toEqual({ outcome: 'ignored', reason: 'no_payload' });
    expect(await issues()).toEqual([]);
  });

  it('unlinks a deleted GitHub issue and keeps the WeldMerge issue', async () => {
    await send(issuesEvent('opened', { number: 7, updatedAt: T1 }));
    expect(await send(issuesEvent('deleted', { number: 7 }))).toEqual({ outcome: 'applied' });
    expect(await links()).toEqual([]);
    expect(await issues()).toHaveLength(1);
  });
});

describe('which repositories sync inbound', () => {
  it('syncs in import mode too', async () => {
    await seedSyncRepository(db, 'import');
    expect(await send(issuesEvent('opened', { number: 7, updatedAt: T1 }))).toEqual({ outcome: 'applied' });
  });

  it('ignores a repository with issue sync off, an untracked one and a repository without a team', async () => {
    await seedSyncRepository(db, 'off');
    expect(await send(issuesEvent('opened', { number: 7 }))).toEqual({ outcome: 'ignored', reason: 'issue_sync_off' });
    await db.update(schema.mergeRepositories).set({ issueSync: 'two_way', teamId: null });
    expect(await send(issuesEvent('opened', { number: 7 }))).toEqual({ outcome: 'ignored', reason: 'no_team' });
    const other = { ...issuesEvent('opened', { number: 7 }), payload: { ...issuesEvent('opened', { number: 7 }).payload, repository: { id: 555 } } };
    expect(await send(other)).toEqual({ outcome: 'ignored', reason: 'untracked_repository' });
    expect(await issues()).toEqual([]);
  });

  it('ignores a repository on a revoked connection', async () => {
    const { connection } = await seedSyncRepository(db, 'two_way');
    await db.update(schema.mergeConnections).set({ status: 'revoked' }).where(eq(schema.mergeConnections.id, connection.id));
    expect(await send(issuesEvent('opened', { number: 7 }))).toEqual({ outcome: 'ignored', reason: 'untracked_repository' });
  });
});

describe('issue_comment', () => {
  let issueId: string;

  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'two_way');
    await seedAccount(db, ALICE, 'Octo-Alice');
    const issue = await seedIssue(db, setup.team.id, 1, { title: 'Linked' });
    issueId = issue.id;
    await seedExternalLink(db, issue.id, setup.repo.id, 7);
    clearEvents();
  });

  it('stores a provider comment with its author and the member matching their linked account', async () => {
    expect(await send(commentEvent('created', 7, { issueNumber: 7, id: 801, body: 'Looks wrong', author: 'Octo-Alice' }))).toEqual({ outcome: 'applied' });
    const [comment] = await comments();
    expect(comment).toMatchObject({
      issueId,
      body: 'Looks wrong',
      source: 'provider',
      externalId: '801',
      externalAuthorLogin: 'Octo-Alice',
      externalAuthorAvatarUrl: 'https://avatars.githubusercontent.com/u/10',
      authorUserId: ALICE,
    });
    expect(eventTypes()).toEqual(['merge_comment:created']);
  });

  it('stores one from someone who is not a member with no author', async () => {
    await send(commentEvent('created', 7, { issueNumber: 7, id: 802, author: 'stranger' }));
    expect((await comments())[0]).toMatchObject({ authorUserId: null, externalAuthorLogin: 'stranger', source: 'provider' });
  });

  it('ignores a comment it already has (the echo of a push), edits the body of a known one and deletes it', async () => {
    await send(commentEvent('created', 7, { issueNumber: 7, id: 803, body: 'First' }));
    clearEvents();
    expect(await send(commentEvent('created', 7, { issueNumber: 7, id: 803, body: 'First' }))).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(events).toEqual([]);

    expect(await send(commentEvent('edited', 7, { issueNumber: 7, id: 803, body: 'Second' }))).toEqual({ outcome: 'applied' });
    expect((await comments())[0]!.body).toBe('Second');
    expect(eventTypes()).toEqual(['merge_comment:updated']);
    expect(await send(commentEvent('edited', 7, { issueNumber: 7, id: 803, body: 'Second' }))).toEqual({ outcome: 'ignored', reason: 'echo' });

    clearEvents();
    expect(await send(commentEvent('deleted', 7, { issueNumber: 7, id: 803 }))).toEqual({ outcome: 'applied' });
    expect((await comments())[0]!.deletedAt).not.toBeNull();
    expect(eventTypes()).toEqual(['merge_comment:deleted']);
    expect(await send(commentEvent('deleted', 7, { issueNumber: 7, id: 999 }))).toEqual({ outcome: 'ignored', reason: 'unknown_comment' });
  });

  it('stores an edited comment it never saw', async () => {
    await send(commentEvent('edited', 7, { issueNumber: 7, id: 804, body: 'Late' }));
    expect(await comments()).toMatchObject([{ body: 'Late', source: 'provider', externalId: '804' }]);
  });

  it('ignores comments on pull requests, on an unlinked issue and actions it does not sync', async () => {
    const onPull = envelope('issue_comment', { action: 'created', issue: githubIssue({ number: 7, pullRequest: true }), comment: githubComment({ issueNumber: 7 }) });
    expect(await send(onPull)).toEqual({ outcome: 'ignored', reason: 'pull_request' });
    expect(await send(commentEvent('created', 99, { issueNumber: 99 }))).toEqual({ outcome: 'ignored', reason: 'unlinked_issue' });
    expect(await send(commentEvent('pinned', 7))).toEqual({ outcome: 'ignored', reason: 'unsupported_action' });
    expect(await comments()).toEqual([]);
  });
});
