/**
 * WeldMerge issues pushed to GitHub, and the explicit link routes
 * (PATCH /api/merge/issues/:id, POST .../comments, POST|DELETE .../external) on a
 * real tenant schema (pglite) with GitHub's REST API stubbed by URL and method.
 * What must not regress:
 *   1. A member's edit of a linked issue in a `two_way` repository is pushed in
 *      the request: title, description, labels by name, open/closed with the
 *      reason (done -> completed, canceled -> not_planned), the assignee by
 *      linked account (only when it changed). The new checksum, taken from
 *      GitHub's answer, is stored with `last_writer = weldmerge`, so the webhook
 *      echo is ignored.
 *   2. Nothing is pushed for an unlinked issue, a one-way repository, a revoked
 *      connection or an edit that touched no synced field; a failing push never
 *      fails the member's own edit.
 *   3. A member's comment is pushed and its GitHub id stored (the echo is ignored).
 *   4. POST /issues/:id/external creates the issue on GitHub (closing it when the
 *      issue is done or canceled) and links it; GitHub refusing is 502
 *      `provider_error`; an already linked issue is 409; DELETE unlinks without
 *      calling GitHub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MergeExternalIssueResult } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { MergeIssueDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import internalRoutes from '../internal/index';
import issuesRoutes from './index';
import issuesExternalRoutes from './external';
import type { Env, Variables } from '../../types';
import {
  ADMIN,
  ALICE,
  BOB,
  MEMBER,
  VIEWER,
  clearEvents,
  data,
  errorCode,
  eventTypes,
  events,
  jsonInit,
  makeApp,
  ok,
  openDb,
  perRun,
  resetTables,
  stubGithub,
} from '../../test/helpers';
import {
  githubComment,
  githubIssue,
  recordGithubBodies,
  seedAccount,
  seedExternalLink,
  seedIssue,
  seedSyncRepository,
  type SyncSetup,
} from '../../test/github-issues';
import { seedConnection, seedRepository } from '../../test/seed';
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

const combined = new Hono<{ Bindings: Env; Variables: Variables }>();
combined.route('/', issuesRoutes);
combined.route('/', issuesExternalRoutes);

const BASE = '/api/merge/issues';
const issues = (grants = ADMIN, env = {}) => makeApp(db, BASE, combined, { grants, env });
const patch = (id: string, body: unknown, grants = ADMIN) => issues(grants).request(`${BASE}/${id}`, jsonInit(body, 'PATCH'));
const internalEvent = (event: string, payload: Record<string, unknown>) =>
  makeApp(db, '/internal', internalRoutes, { grants: ADMIN }).request(
    '/internal/github-event',
    jsonInit({ workspaceId: 'org_alpha', event, payload: { installation: { id: 4242 }, repository: { id: 900 }, ...payload } }),
  );

const T3 = '2026-11-02T11:00:00Z';
const ISSUE_7 = '/repos/acme/web/issues/7';
const linkOf = async (issueId: string) => (await db.select().from(schema.mergeExternalIssues).where(eq(schema.mergeExternalIssues.issueId, issueId)))[0]!;

let setup: SyncSetup;
let issueId: string;

/** A linked issue "Old" in a two_way repository, GitHub answering with `answer`. */
async function linkedIssue(overrides: Partial<typeof schema.mergeIssues.$inferInsert> = {}) {
  const issue = await seedIssue(db, setup.team.id, 1, { title: 'Old', description: null, ...overrides });
  await seedExternalLink(db, issue.id, setup.repo.id, 7);
  issueId = issue.id;
  clearEvents();
  return issue;
}

describe('pushing an edit', () => {
  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'two_way');
  });

  it('pushes the synced fields, stores the checksum of GitHub\'s answer and ignores the echo', async () => {
    await linkedIssue();
    const answer = githubIssue({ number: 7, title: 'New', body: '', updatedAt: T3 });
    stubGithub({ [`PATCH ${ISSUE_7}`]: answer });
    const calls = recordGithubBodies();

    expect((await patch(issueId, { title: 'New' })).status).toBe(200);
    expect(calls).toEqual(perRun([{ method: 'PATCH', path: ISSUE_7, body: { title: 'New', body: '', labels: [], state: 'open' } }]));

    const link = await linkOf(issueId);
    expect(link).toMatchObject({ lastWriter: 'weldmerge', state: 'open' });
    expect(link.checksum).toBe(await checksumOf(providerFields(normalizeGithubIssue(answer))));
    expect(link.providerUpdatedAt?.toISOString()).toBe('2026-11-02T11:00:00.000Z');
    expect(eventTypes()).toEqual(['merge_issue:updated']);

    clearEvents();
    const echo = await internalEvent('issues', { action: 'edited', issue: answer });
    expect(await data(echo)).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(events).toEqual([]);
  });

  it('closes the GitHub issue as completed for done and as not planned for canceled, and reopens it', async () => {
    await linkedIssue();
    stubGithub({ [`PATCH ${ISSUE_7}`]: githubIssue({ number: 7, title: 'Old', body: '', state: 'closed', stateReason: 'completed', updatedAt: T3 }) });
    const calls = recordGithubBodies();

    for (const [status, state] of [
      ['done', { state: 'closed', state_reason: 'completed' }],
      ['canceled', { state: 'closed', state_reason: 'not_planned' }],
      ['todo', { state: 'open' }],
    ] as const) {
      calls.length = 0;
      await patch(issueId, { status });
      expect(calls, status).toEqual(perRun([{ method: 'PATCH', path: ISSUE_7, body: { title: 'Old', body: '', labels: [], ...state } }]));
    }
    expect((await linkOf(issueId)).lastWriter).toBe('weldmerge');
  });

  it('sends labels by name and the description as the body', async () => {
    await linkedIssue();
    await db.insert(schema.mergeLabels).values([
      { id: 'mlb_bug', teamId: null, name: 'Bug' },
      { id: 'mlb_ui', teamId: setup.team.id, name: 'UI' },
    ]);
    stubGithub({ [`PATCH ${ISSUE_7}`]: githubIssue({ number: 7, title: 'Old', body: 'Why', labels: ['Bug', 'UI'], updatedAt: T3 }) });
    const calls = recordGithubBodies();

    await patch(issueId, { labelIds: ['mlb_bug', 'mlb_ui'], description: 'Why' });
    expect(calls).toEqual(perRun([{ method: 'PATCH', path: ISSUE_7, body: { title: 'Old', body: 'Why', labels: ['Bug', 'UI'], state: 'open' } }]));
  });

  it('names the assignee by linked account, clears it, and leaves GitHub alone for one without an account', async () => {
    await linkedIssue();
    await seedAccount(db, ALICE, 'Octo-Alice');
    stubGithub({ [`PATCH ${ISSUE_7}`]: githubIssue({ number: 7, title: 'Old', body: '', updatedAt: T3 }) });
    const calls = recordGithubBodies();

    for (const [assigneeUserId, assignees] of [
      [ALICE, ['octo-alice']],
      [null, []],
      [BOB, undefined],
    ] as const) {
      calls.length = 0;
      await patch(issueId, { assigneeUserId });
      expect(calls.map((c) => (c.body as { assignees?: string[] }).assignees), String(assigneeUserId)).toEqual(perRun([assignees]));
    }
  });

  it('sends no assignee when the edit did not touch it', async () => {
    await linkedIssue({ assigneeUserId: ALICE });
    await seedAccount(db, ALICE, 'octo-alice');
    stubGithub({ [`PATCH ${ISSUE_7}`]: githubIssue({ number: 7, title: 'Edited', body: '', assignee: 'octo-alice', updatedAt: T3 }) });
    const calls = recordGithubBodies();
    await patch(issueId, { title: 'Edited' });
    expect(calls.every((c) => !('assignees' in (c.body as object)))).toBe(true);
    expect(calls).toHaveLength(perRun([1]).length);
  });

  it('pushes nothing for a change outside the synced fields, an unlinked issue, a one-way repository or a revoked connection', async () => {
    await linkedIssue();
    const unlinked = await seedIssue(db, setup.team.id, 2, { title: 'Alone' });
    stubGithub({ [`PATCH ${ISSUE_7}`]: githubIssue({ number: 7 }) });
    const calls = recordGithubBodies();

    await patch(issueId, { priority: 2 });
    await patch(unlinked.id, { title: 'Still alone' });
    await db.update(schema.mergeRepositories).set({ issueSync: 'import' });
    await patch(issueId, { title: 'One way' });
    await db.update(schema.mergeRepositories).set({ issueSync: 'two_way' });
    await db.update(schema.mergeConnections).set({ status: 'revoked' });
    await patch(issueId, { title: 'Revoked' });
    expect(calls).toEqual([]);
    expect((await linkOf(issueId)).checksum).toBe('stale-checksum');
  });

  it('keeps the member\'s edit when GitHub refuses the push, leaving the link as it was', async () => {
    await linkedIssue();
    stubGithub({ [`PATCH ${ISSUE_7}`]: new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 }) });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await patch(issueId, { title: 'Kept' });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect((await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, issueId)))[0]!.title).toBe('Kept');
    expect((await linkOf(issueId)).checksum).toBe('stale-checksum');
  });
});

describe('pushing a comment', () => {
  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'two_way');
  });

  it('posts a member\'s comment on the GitHub issue, stores its id, and ignores the echo', async () => {
    await linkedIssue();
    const answer = githubComment({ id: 901, issueNumber: 7, body: 'From WeldMerge', author: 'weldsuite[bot]' });
    stubGithub({ [`POST ${ISSUE_7}/comments`]: answer });
    const calls = recordGithubBodies();

    const res = await issues().request(`${BASE}/${issueId}/comments`, jsonInit({ body: 'From WeldMerge' }));
    expect(res.status).toBe(201);
    expect(calls).toEqual(perRun([{ method: 'POST', path: `${ISSUE_7}/comments`, body: { body: 'From WeldMerge' } }]));
    const [comment] = await db.select().from(schema.mergeComments);
    expect(comment).toMatchObject({ body: 'From WeldMerge', source: 'weldmerge', externalId: '901', authorUserId: ALICE });

    clearEvents();
    const echo = await internalEvent('issue_comment', { action: 'created', issue: githubIssue({ number: 7 }), comment: answer });
    expect(await data(echo)).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(await db.select().from(schema.mergeComments)).toHaveLength(1);
  });

  it('posts nothing for an unlinked issue or a one-way repository', async () => {
    const unlinked = await seedIssue(db, setup.team.id, 2);
    await linkedIssue();
    stubGithub({ [`POST ${ISSUE_7}/comments`]: githubComment({ issueNumber: 7 }) });
    const calls = recordGithubBodies();
    await issues().request(`${BASE}/${unlinked.id}/comments`, jsonInit({ body: 'Nobody listens' }));
    await db.update(schema.mergeRepositories).set({ issueSync: 'import' });
    await issues().request(`${BASE}/${issueId}/comments`, jsonInit({ body: 'One way' }));
    expect(calls).toEqual([]);
    expect((await db.select().from(schema.mergeComments)).every((c) => c.externalId === null)).toBe(true);
  });
});

describe('POST /issues/:id/external', () => {
  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'two_way');
  });

  const create = (id: string, body: unknown, grants = ADMIN, env = {}) =>
    issues(grants, env).request(`${BASE}/${id}/external`, jsonInit(body));

  it('creates the issue on GitHub with its fields, links it and publishes the change', async () => {
    await db.insert(schema.mergeLabels).values({ id: 'mlb_bug', teamId: null, name: 'Bug' });
    await seedAccount(db, ALICE, 'Octo-Alice');
    const issue = await seedIssue(db, setup.team.id, 1, { title: 'Fix tabs', description: 'Tabs break', labelIds: ['mlb_bug'], assigneeUserId: ALICE, status: 'todo' });
    const answer = githubIssue({ number: 31, title: 'Fix tabs', body: 'Tabs break', labels: ['Bug'], assignee: 'octo-alice', updatedAt: T3 });
    stubGithub({ 'POST /repos/acme/web/issues': answer });
    const calls = recordGithubBodies();
    clearEvents();

    const result = await ok<MergeExternalIssueResult>(await create(issue.id, { repositoryId: setup.repo.id }), 201);
    expect(result).toEqual({
      provider: 'github',
      number: 31,
      url: 'https://github.com/acme/web/issues/31',
      state: 'open',
      repositoryId: setup.repo.id,
      repositoryFullName: 'acme/web',
    });
    expect(calls).toEqual(
      perRun([
        { method: 'POST', path: '/repos/acme/web/issues', body: { title: 'Fix tabs', body: 'Tabs break', labels: ['Bug'], assignees: ['octo-alice'] } },
      ]),
    );
    const link = await linkOf(issue.id);
    expect(link).toMatchObject({ externalId: '7031', number: 31, lastWriter: 'weldmerge', state: 'open', repositoryId: setup.repo.id });
    expect(link.checksum).toBe(await checksumOf(providerFields(normalizeGithubIssue(answer))));
    expect(eventTypes()).toEqual(['merge_issue:updated']);
    expect(events[0]!.changes).toEqual({ external: { old: null, new: { provider: 'github', number: 31 } } });

    const detail = await ok<MergeIssueDetailDto>(await issues().request(`${BASE}/${issue.id}`));
    expect(detail.external).toEqual(result);
  });

  it('closes the new GitHub issue when the WeldMerge issue is done', async () => {
    const issue = await seedIssue(db, setup.team.id, 1, { title: 'Shipped', description: null, status: 'done' });
    stubGithub({
      'POST /repos/acme/web/issues': githubIssue({ number: 32, title: 'Shipped', body: '' }),
      'PATCH /repos/acme/web/issues/32': githubIssue({ number: 32, title: 'Shipped', body: '', state: 'closed', stateReason: 'completed' }),
    });
    const calls = recordGithubBodies();
    const result = await ok<MergeExternalIssueResult>(await create(issue.id, { repositoryId: setup.repo.id }), 201);
    expect(result).toMatchObject({ number: 32, state: 'closed' });
    expect(calls).toEqual(
      perRun([
        { method: 'POST', path: '/repos/acme/web/issues', body: { title: 'Shipped', body: '', labels: [] } },
        { method: 'PATCH', path: '/repos/acme/web/issues/32', body: { state: 'closed', state_reason: 'completed' } },
      ]),
    );
  });

  it('answers 409 when the issue is already linked, and 404 for an unknown issue or repository', async () => {
    const issue = await seedIssue(db, setup.team.id, 1);
    await seedExternalLink(db, issue.id, setup.repo.id, 7);
    const calls = stubGithub({});
    expect((await create(issue.id, { repositoryId: setup.repo.id })).status).toBe(409);
    expect((await create('mis_unknown', { repositoryId: setup.repo.id })).status).toBe(404);
    const other = await seedIssue(db, setup.team.id, 2);
    expect((await create(other.id, { repositoryId: 'mrp_unknown' })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 422 for a provider without issue sync', async () => {
    const connection = await seedConnection(db, { provider: 'bitbucket', externalAccountId: 'bb-1' });
    const repo = await seedRepository(db, connection.id, { provider: 'bitbucket', externalId: 'bb-r', fullName: 'acme/bb', teamId: setup.team.id });
    const issue = await seedIssue(db, setup.team.id, 1);
    expect((await create(issue.id, { repositoryId: repo.id })).status).toBe(422);
  });

  it('answers 502 provider_error with GitHub\'s own message and links nothing', async () => {
    const issue = await seedIssue(db, setup.team.id, 1);
    stubGithub({ 'POST /repos/acme/web/issues': new Response(JSON.stringify({ message: 'Issues are disabled for this repo' }), { status: 410 }) });
    const res = await create(issue.id, { repositoryId: setup.repo.id });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'provider_error', message: 'Issues are disabled for this repo' });
    expect(await db.select().from(schema.mergeExternalIssues)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('answers 503 without the App credentials, 400 for bad input and 403 without merge_issues:update', async () => {
    const issue = await seedIssue(db, setup.team.id, 1);
    stubGithub({});
    const unconfigured = await create(issue.id, { repositoryId: setup.repo.id }, ADMIN, { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined });
    expect(unconfigured.status).toBe(503);
    expect(await errorCode(unconfigured)).toBe('SERVICE_UNAVAILABLE');
    expect((await create(issue.id, {})).status).toBe(400);
    expect((await create(issue.id, { repositoryId: setup.repo.id }, VIEWER)).status).toBe(403);
    expect((await create(issue.id, { repositoryId: setup.repo.id }, MEMBER)).status).not.toBe(403);
  });
});

describe('DELETE /issues/:id/external', () => {
  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'two_way');
  });

  it('unlinks without calling GitHub, publishes the change, and answers 404 the second time', async () => {
    await linkedIssue();
    const calls = stubGithub({});
    const res = await issues().request(`${BASE}/${issueId}/external`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(calls).toEqual([]);
    expect(await db.select().from(schema.mergeExternalIssues)).toEqual([]);
    expect(eventTypes()).toEqual(['merge_issue:updated']);
    expect(events[0]!.changes).toHaveProperty('external');
    expect((await issues().request(`${BASE}/${issueId}/external`, { method: 'DELETE' })).status).toBe(404);
    expect((await issues().request(`${BASE}/mis_unknown/external`, { method: 'DELETE' })).status).toBe(404);
    expect((await issues(VIEWER).request(`${BASE}/${issueId}/external`, { method: 'DELETE' })).status).toBe(403);
  });
});
