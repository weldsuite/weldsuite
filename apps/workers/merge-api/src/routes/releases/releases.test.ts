/**
 * DB-backed tests for /api/merge/releases on a real tenant schema (pglite).
 * Outbound HTTP (GitHub's compare API, the AI gateway, DNS-over-HTTPS) is
 * stubbed by URL and method, never by call order, so the Rust backend can
 * answer the same tests in conformance mode. What must not regress:
 *   1. CRUD with its events, and the permission, validation and 404 gates.
 *   2. Refresh: GitHub compare matches merged mirrors by head commit and by
 *      the pull request number in a merge or squash commit message; without
 *      refs, for another provider, or when GitHub does not know the compare it
 *      falls back to the pull requests merged since the previous shipped release.
 *   3. Generate notes asks the AI gateway once and saves the Markdown.
 *   4. Ship moves the release to shipped once and carries pull request, issue
 *      and desk ticket ids on the event.
 *   5. Publish writes a WeldKnow page (teamspace role applies) and sends the
 *      email through the outbound guard, publishing those modules' events.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  MergePublishReleaseResult,
  MergeGenerateNotesResult,
  MergeReleaseDetailDto,
  MergeReleaseDto,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import releasesRoutes from './index';
import { pullRequestNumberOf } from '../../services/releases';
import { markdownToBlocks } from '../../services/release-publish';
import {
  ADMIN,
  ALICE,
  MEMBER,
  clearEvents,
  errorCode,
  eventTypes,
  events,
  jsonInit,
  makeApp,
  newId,
  ok,
  openDb,
  perRun,
  resetTables,
  stubGithub,
} from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await db.delete(schema.mailMessages);
  await db.delete(schema.mailAccounts);
  await db.delete(schema.knowledgePages);
  await db.delete(schema.knowledgeSpaceMembers);
  await db.delete(schema.knowledgeSpaces);
  vi.unstubAllGlobals();
});

const BASE = '/api/merge/releases';
const AI_ENV = { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_token' };
const PUBLISH_GRANTS = [...ADMIN, 'knowledge:create', 'messages:create'];

const app = (grants = ADMIN, env: Record<string, unknown> = AI_ENV, userId = ALICE) =>
  makeApp(db, BASE, releasesRoutes, { grants, userId, env });

const AI_CALL = { method: 'POST', url: '/v1/acct_test/default/compat/chat/completions' };
const NOTES = '## Fixes\n- Tabs no longer flicker (#1)\n- Faster search (#2)';
const completion = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1_790_000_000,
  model: 'anthropic/claude-sonnet-4-5',
  choices: [{ index: 0, message: { role: 'assistant', content: NOTES }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
};
const MX = { Status: 0, Answer: [{ name: 'example.com', type: 15, TTL: 60, data: '10 mx.example.com' }] };

const t = (day: string) => new Date(`2026-${day}T10:00:00Z`);

async function seedWorld() {
  const team = await seedTeam(db);
  const connection = await seedConnection(db);
  const repository = await seedRepository(db, connection.id, { teamId: team.id });
  return { team, connection, repository };
}

async function createRelease(extra: Record<string, unknown> = {}, existing?: Awaited<ReturnType<typeof seedWorld>>) {
  const world = existing ?? (await seedWorld());
  const res = await app().request(
    BASE,
    jsonInit({ teamId: world.team.id, repositoryId: world.repository.id, name: 'Autumn', version: 'v1.1', baseRef: 'v1.0', headRef: 'v1.1', ...extra }),
  );
  const release = await ok<MergeReleaseDetailDto>(res, 201);
  return { ...world, release };
}

describe('create, read, update, delete', () => {
  it('creates a draft release with an event, lists it and reads its detail', async () => {
    const { release, team, repository } = await createRelease();
    expect(release).toMatchObject({
      teamId: team.id,
      repositoryId: repository.id,
      repositoryFullName: 'acme/web',
      name: 'Autumn',
      version: 'v1.1',
      status: 'draft',
      pullRequestCount: 0,
      pullRequests: [],
      issues: [],
      tickets: [],
    });
    expect(events.map((e) => [e.eventType, e.entityId])).toEqual([['merge_release:created', newId(release.id)]]);

    const listed = await ok<MergeReleaseDto[]>(await app().request(`${BASE}?status=draft&teamId=${team.id}`));
    expect(listed.map((r) => r.id)).toEqual([release.id]);
    expect(await ok<MergeReleaseDto[]>(await app().request(`${BASE}?status=shipped`))).toEqual([]);
    expect((await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${release.id}`))).name).toBe('Autumn');
  });

  it('edits the name, refs and notes with a changes map, and soft-deletes', async () => {
    const { release } = await createRelease();
    clearEvents();
    const edited = await ok<MergeReleaseDetailDto>(
      await app().request(`${BASE}/${release.id}`, jsonInit({ name: 'Autumn 2', notes: 'Hello', headRef: null }, 'PATCH')),
    );
    expect(edited).toMatchObject({ name: 'Autumn 2', notes: 'Hello', headRef: null });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('merge_release:updated');
    expect(events[0]!.changes).toMatchObject({ name: { old: 'Autumn', new: 'Autumn 2' }, headRef: { old: 'v1.1', new: null } });

    clearEvents();
    expect((await app().request(`${BASE}/${release.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(eventTypes()).toEqual(['merge_release:deleted']);
    expect((await app().request(`${BASE}/${release.id}`)).status).toBe(404);
    expect(await ok<MergeReleaseDto[]>(await app().request(BASE))).toEqual([]);
  });

  it('answers 400 for a bad body, 404 for unknown ids and 403 without the permission', async () => {
    const { team, repository, release } = await createRelease();
    expect((await app().request(BASE, jsonInit({ teamId: team.id, repositoryId: repository.id, name: ' ' }))).status).toBe(400);
    expect((await app().request(`${BASE}/${release.id}`, jsonInit({}, 'PATCH'))).status).toBe(400);
    expect((await app().request(BASE, jsonInit({ teamId: 'mtm_nope', repositoryId: repository.id, name: 'x' }))).status).toBe(404);
    expect((await app().request(BASE, jsonInit({ teamId: team.id, repositoryId: 'mrp_nope', name: 'x' }))).status).toBe(404);
    expect((await app().request(`${BASE}/mrl_nope`)).status).toBe(404);
    expect((await app().request(`${BASE}/mrl_nope/ship`, jsonInit({}))).status).toBe(404);

    // MEMBER reads but cannot manage.
    expect((await app(MEMBER).request(BASE)).status).toBe(200);
    for (const [path, init] of [
      [BASE, jsonInit({ teamId: team.id, repositoryId: repository.id, name: 'x' })],
      [`${BASE}/${release.id}`, jsonInit({ name: 'x' }, 'PATCH')],
      [`${BASE}/${release.id}`, { method: 'DELETE' }],
      [`${BASE}/${release.id}/refresh`, jsonInit({})],
      [`${BASE}/${release.id}/generate-notes`, jsonInit({})],
      [`${BASE}/${release.id}/ship`, jsonInit({})],
      [`${BASE}/${release.id}/publish`, jsonInit({ knowledgeSpaceId: 'ks_1' })],
    ] as Array<[string, RequestInit]>) {
      expect((await app(MEMBER).request(path, init)).status, path).toBe(403);
    }
    expect((await app([]).request(BASE)).status).toBe(403);
  });
});

describe('refresh', () => {
  async function seedMerged(repositoryId: string) {
    const one = await seedPullRequest(db, repositoryId, 1, { state: 'merged', mergedAt: t('11-01'), headSha: 'sha-one' });
    const two = await seedPullRequest(db, repositoryId, 2, { state: 'merged', mergedAt: t('11-02'), headSha: 'sha-two-branch' });
    const three = await seedPullRequest(db, repositoryId, 3, { state: 'merged', mergedAt: t('11-03'), headSha: 'sha-three' });
    const open = await seedPullRequest(db, repositoryId, 4, { state: 'open', headSha: 'sha-open' });
    return { one, two, three, open };
  }

  it('matches merged pull requests by head commit and by the number in a merge or squash commit message', async () => {
    const { release, repository } = await createRelease();
    const prs = await seedMerged(repository.id);
    const calls = stubGithub({
      'GET /repos/acme/web/compare/v1.0...v1.1': {
        commits: [
          { sha: 'sha-one', commit: { message: 'Fix tabs' } },
          { sha: 'squash-two', commit: { message: 'Faster search (#2)\n\nbody' } },
          { sha: 'sha-open', commit: { message: 'Work in progress' } },
        ],
      },
    });
    clearEvents();

    const refreshed = await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${release.id}/refresh`, jsonInit({})));
    expect(refreshed.pullRequests.map((p) => p.number)).toEqual([2, 1]);
    expect(refreshed.pullRequestCount).toBe(2);
    expect(refreshed.pullRequests.map((p) => p.id)).toEqual([prs.two.id, prs.one.id]);
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/repos/acme/web/compare/v1.0...v1.1?per_page=100&page=1' }]));
    expect(events.map((e) => e.eventType)).toEqual(['merge_release:updated']);
    expect((events[0]!.data as { pullRequestIds: string[] }).pullRequestIds).toEqual([prs.two.id, prs.one.id]);

    // A second refresh replaces the list rather than adding to it.
    stubGithub({ 'GET /repos/acme/web/compare/v1.0...v1.1': { commits: [{ sha: 'sha-three', commit: { message: 'Merge pull request #3 from acme/x' } }] } });
    const again = await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${release.id}/refresh`, jsonInit({})));
    expect(again.pullRequests.map((p) => p.number)).toEqual([3]);
  });

  it('falls back to the pull requests merged since the previous shipped release when GitHub does not know the compare', async () => {
    const { release, repository, team } = await createRelease();
    await seedMerged(repository.id);
    await db.insert(schema.mergeReleases).values({
      id: generateId('mrl'),
      teamId: team.id,
      repositoryId: repository.id,
      name: 'Summer',
      status: 'shipped',
      shippedAt: t('11-01'),
      createdByUserId: ALICE,
    });
    const calls = stubGithub({});
    const refreshed = await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${release.id}/refresh`, jsonInit({})));
    expect(refreshed.pullRequests.map((p) => p.number)).toEqual([3, 2]);
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/repos/acme/web/compare/v1.0...v1.1?per_page=100&page=1' }]));
  });

  it('uses every merged pull request when nothing shipped before, and makes no call without refs', async () => {
    const { release, repository } = await createRelease({ baseRef: null, headRef: null });
    await seedMerged(repository.id);
    const calls = stubGithub({});
    const refreshed = await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${release.id}/refresh`, jsonInit({})));
    expect(refreshed.pullRequests.map((p) => p.number)).toEqual([3, 2, 1]);
    expect(calls).toEqual([]);
  });

  it('does not call GitHub for another provider', async () => {
    const team = await seedTeam(db);
    const connection = await seedConnection(db, { provider: 'gitlab', externalAccountId: 'acme' });
    const repository = await seedRepository(db, connection.id, { provider: 'gitlab', externalId: '77', fullName: 'acme/api', teamId: team.id });
    await seedPullRequest(db, repository.id, 5, { provider: 'gitlab', state: 'merged', mergedAt: t('11-02') });
    const created = await ok<MergeReleaseDetailDto>(
      await app().request(BASE, jsonInit({ teamId: team.id, repositoryId: repository.id, name: 'API 1', baseRef: 'a', headRef: 'b' }), ),
      201,
    );
    const calls = stubGithub({});
    const refreshed = await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${created.id}/refresh`, jsonInit({})));
    expect(refreshed.pullRequests.map((p) => p.number)).toEqual([5]);
    expect(calls).toEqual([]);
  });

  it('maps a GitHub failure to 502 and refuses to refresh a shipped release', async () => {
    const { release } = await createRelease();
    stubGithub({ 'GET /repos/acme/web/compare/v1.0...v1.1': new Response('boom', { status: 500 }) });
    expect((await app().request(`${BASE}/${release.id}/refresh`, jsonInit({}))).status).toBe(502);

    await app().request(`${BASE}/${release.id}/ship`, jsonInit({}));
    const res = await app().request(`${BASE}/${release.id}/refresh`, jsonInit({}));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('CONFLICT');
  });
});

describe('pullRequestNumberOf', () => {
  it('reads merge and squash commit messages, and nothing else', () => {
    expect(pullRequestNumberOf('Merge pull request #12 from acme/fix\n\nTitle')).toBe(12);
    expect(pullRequestNumberOf('Add search (#34)')).toBe(34);
    expect(pullRequestNumberOf('Add search (#34)\n\nSee #99')).toBe(34);
    expect(pullRequestNumberOf('Fix #5 in the parser')).toBeNull();
    expect(pullRequestNumberOf(null)).toBeNull();
  });
});

describe('generate notes', () => {
  async function fillRelease(world: Awaited<ReturnType<typeof createRelease>>) {
    const pr = await seedPullRequest(db, world.repository.id, 1, { state: 'merged', mergedAt: t('11-01'), headSha: 'sha-one', title: 'Fix tabs' });
    stubGithub({ 'GET /repos/acme/web/compare/v1.0...v1.1': { commits: [{ sha: 'sha-one', commit: { message: 'Fix tabs' } }] } });
    await app().request(`${BASE}/${world.release.id}/refresh`, jsonInit({}));
    clearEvents();
    return { ...world, pr };
  }

  const releaseWithPullRequests = async () => fillRelease(await createRelease());

  it('asks the AI gateway once and saves the Markdown on the release', async () => {
    const { release } = await releaseWithPullRequests();
    const calls = stubGithub({ [`${AI_CALL.method} ${AI_CALL.url}`]: completion });

    const result = await ok<MergeGenerateNotesResult>(await app().request(`${BASE}/${release.id}/generate-notes`, jsonInit({})));
    expect(result.release.notes).toBe(NOTES);
    expect(result.release.notesGeneratedAt).toEqual(expect.any(String));
    expect(calls).toEqual(perRun([AI_CALL]));
    expect(events.map((e) => e.eventType)).toEqual(['merge_release:updated']);

    const [row] = await db.select().from(schema.mergeReleases).where(eq(schema.mergeReleases.id, release.id));
    expect(row!.notes).toBe(NOTES);
  });

  it('is 422 for a release with nothing in it, 503 without the gateway, 502 when the gateway fails', async () => {
    const empty = await createRelease();
    stubGithub({});
    expect((await app().request(`${BASE}/${empty.release.id}/generate-notes`, jsonInit({}))).status).toBe(422);

    const filled = await fillRelease(empty);
    expect((await app(ADMIN, {}).request(`${BASE}/${filled.release.id}/generate-notes`, jsonInit({}))).status).toBe(503);
    stubGithub({ [`${AI_CALL.method} ${AI_CALL.url}`]: new Response('{"error":{"message":"bad"}}', { status: 400 }) });
    expect((await app().request(`${BASE}/${filled.release.id}/generate-notes`, jsonInit({}))).status).toBe(502);
  });
});

describe('ship', () => {
  it('ships once, with the pull request, issue and desk ticket ids on the event', async () => {
    const { release, repository, team } = await createRelease();
    const pr = await seedPullRequest(db, repository.id, 1, { state: 'merged', mergedAt: t('11-01'), headSha: 'sha-one' });
    const issue = await seedIssue(db, team.id, 7);
    await db.insert(schema.mergeIssuePullRequests).values({ id: generateId('mip'), issueId: issue.id, pullRequestId: pr.id, source: 'auto', closes: true });
    await db.insert(schema.mergeRecordLinks).values([
      { id: generateId('mrk'), issueId: issue.id, recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Login broken' },
      { id: generateId('mrk'), issueId: issue.id, recordType: 'crm_company', recordId: 'cmp_1' },
    ]);
    stubGithub({ 'GET /repos/acme/web/compare/v1.0...v1.1': { commits: [{ sha: 'sha-one', commit: { message: 'x' } }] } });
    await app().request(`${BASE}/${release.id}/refresh`, jsonInit({}));
    clearEvents();

    const shipped = await ok<MergeReleaseDetailDto>(await app().request(`${BASE}/${release.id}/ship`, jsonInit({})));
    expect(shipped.status).toBe('shipped');
    expect(shipped.shippedAt).toEqual(expect.any(String));
    expect(shipped.issues.map((i) => i.key)).toEqual(['PLAT-7']);
    expect(shipped.tickets).toEqual([{ ticketId: 'tkt_1', title: 'Login broken', issueId: issue.id, issueKey: 'PLAT-7' }]);

    expect(events.map((e) => e.eventType)).toEqual(['merge_release:shipped']);
    expect(events[0]!.data).toMatchObject({
      id: release.id,
      status: 'shipped',
      pullRequestIds: [pr.id],
      issueIds: [issue.id],
      deskTicketIds: ['tkt_1'],
    });

    const again = await app().request(`${BASE}/${release.id}/ship`, jsonInit({}));
    expect(again.status).toBe(409);
    expect(events).toHaveLength(1);
  });
});

describe('publish', () => {
  async function releaseWithNotes() {
    const world = await createRelease({ notes: NOTES });
    clearEvents();
    return world;
  }

  async function seedSpace(role: 'editor' | 'viewer' | null) {
    const id = generateId('ks');
    await db.insert(schema.knowledgeSpaces).values({ id, name: 'Releases', kind: 'team', visibility: 'open' });
    if (role) await db.insert(schema.knowledgeSpaceMembers).values({ id: generateId('ksm'), spaceId: id, userId: ALICE, role });
    return id;
  }

  it('writes a WeldKnow page with the notes and keeps its id on the release', async () => {
    const { release } = await releaseWithNotes();
    const spaceId = await seedSpace('editor');
    const result = await ok<MergePublishReleaseResult>(
      await app(PUBLISH_GRANTS).request(`${BASE}/${release.id}/publish`, jsonInit({ knowledgeSpaceId: spaceId })),
    );
    expect(result.emailSent).toBe(false);
    expect(result.knowledgePageId).toEqual(expect.any(String));
    expect(result.release.knowledgePageId).toBe(result.knowledgePageId);

    const [page] = await db.select().from(schema.knowledgePages).where(eq(schema.knowledgePages.id, result.knowledgePageId!));
    expect(page).toMatchObject({ spaceId, title: 'Release notes: Autumn v1.1', createdBy: ALICE });
    expect(page!.contentText).toContain('Faster search');
    expect(events.map((e) => e.eventType)).toEqual(['knowledge_page:created', 'merge_release:updated']);
  });

  it('answers 404 for an unknown teamspace, 403 for a viewer, 403 without knowledge:create, 422 without notes', async () => {
    const world = await releaseWithNotes();
    const { release } = world;
    const publish = (grants: string[], body: unknown, id = release.id) =>
      app(grants).request(`${BASE}/${id}/publish`, jsonInit(body));
    expect((await publish(PUBLISH_GRANTS, { knowledgeSpaceId: 'ks_nope' })).status).toBe(404);
    expect((await publish(PUBLISH_GRANTS, { knowledgeSpaceId: await seedSpace('viewer') })).status).toBe(403);
    expect((await publish(ADMIN, { knowledgeSpaceId: await seedSpace('editor') })).status).toBe(403);
    expect((await publish(PUBLISH_GRANTS, {})).status).toBe(400);

    const empty = await createRelease({ name: 'Empty', notes: null }, world);
    expect((await publish(PUBLISH_GRANTS, { knowledgeSpaceId: await seedSpace('editor') }, empty.release.id)).status).toBe(422);
  });

  it('sends the notes by email from a workspace mail account through the outbound guard', async () => {
    const { release } = await releaseWithNotes();
    const accountId = generateId('mail');
    await db.insert(schema.mailAccounts).values({ id: accountId, name: 'Releases', email: 'releases@acme.dev', isShared: true });
    const sent: Array<{ from: string; to: string; raw: string }> = [];
    const SEND_EMAIL = {
      send: async (message: { from: string; to: string; raw: unknown }) => {
        sent.push({ from: message.from, to: message.to, raw: String(message.raw) });
        return { messageId: '<release-1@acme.dev>' };
      },
    };
    const calls = stubGithub({ 'GET /dns-query': MX });

    const result = await ok<MergePublishReleaseResult>(
      await app(PUBLISH_GRANTS, { ...AI_ENV, SEND_EMAIL }).request(
        `${BASE}/${release.id}/publish`,
        jsonInit({ email: { mailAccountId: accountId, to: ['customer@example.com'], subject: 'What is new' } }),
      ),
    );
    expect(result).toMatchObject({ emailSent: true, knowledgePageId: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'releases@acme.dev', to: 'customer@example.com' });
    expect(sent[0]!.raw).toContain(Buffer.from('What is new').toString('base64'));
    expect(sent[0]!.raw).toContain('Faster search');
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/dns-query?name=example.com&type=MX' }]));
    expect(events.map((e) => e.eventType)).toEqual(['email:email_sent']);
    // The recipients and subject stay out of the event.
    expect(events[0]!.data).toMatchObject({ subject: null, to: null });
  });

  it('answers 404 for an unknown mail account, 400 for an unreachable recipient, 403 without messages:create', async () => {
    const { release } = await releaseWithNotes();
    const SEND_EMAIL = { send: async () => ({ messageId: '<x@y>' }) };
    const publish = (grants: string[], email: unknown) =>
      app(grants, { ...AI_ENV, SEND_EMAIL }).request(`${BASE}/${release.id}/publish`, jsonInit({ email }));
    stubGithub({ 'GET /dns-query': MX });
    expect((await publish(PUBLISH_GRANTS, { mailAccountId: 'mail_nope', to: ['customer@example.com'] })).status).toBe(404);

    const accountId = generateId('mail');
    await db.insert(schema.mailAccounts).values({ id: accountId, name: 'Releases', email: 'releases@acme.dev', isShared: true });
    expect((await publish(ADMIN, { mailAccountId: accountId, to: ['customer@example.com'] })).status).toBe(403);
    stubGithub({ 'GET /dns-query': { Status: 3 } });
    expect((await publish(PUBLISH_GRANTS, { mailAccountId: accountId, to: ['customer@nowhere.invalid'] })).status).toBe(400);
  });
});

describe('markdownToBlocks', () => {
  it('turns headings, lists and paragraphs into blocks', () => {
    const blocks = markdownToBlocks('# Title\n\nIntro **bold**\n- one\n- two [link](http://x)\n1. first');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'bulletListItem', 'bulletListItem', 'numberedListItem']);
    expect(blocks[0]).toMatchObject({ props: { level: 1 }, content: [{ text: 'Title' }] });
    expect(blocks[1]).toMatchObject({ content: [{ text: 'Intro bold' }] });
    expect(blocks[3]).toMatchObject({ content: [{ text: 'two link' }] });
  });
});
