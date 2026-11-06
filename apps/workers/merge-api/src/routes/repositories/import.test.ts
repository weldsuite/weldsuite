/**
 * POST /api/merge/repositories/:id/import-issues on a real tenant schema
 * (pglite), GitHub's REST API stubbed by URL and method. What must not regress:
 *   1. The repository's open GitHub issues become WeldMerge issues in its team
 *      (pull requests skipped), linked, with their labels and assignees; the
 *      answer counts imported, updated and skipped; a second run changes nothing.
 *   2. Later changes on GitHub refresh the known issues (`updated`).
 *   3. It needs merge_connections:manage, a known repository, a team, issue sync
 *      on a provider that has issues; GitHub failing is a 502 `provider_error`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { MergeImportIssuesResult } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import importRoutes from './import';
import { ADMIN, ALICE, MEMBER, clearEvents, errorCode, eventTypes, events, jsonInit, makeApp, ok, openDb, perRun, resetTables, stubGithub } from '../../test/helpers';
import { githubIssue, seedAccount, seedSyncRepository, type SyncSetup } from '../../test/github-issues';
import { seedConnection, seedRepository, seedTeam } from '../../test/seed';

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

const BASE = '/api/merge/repositories';
const run = (id: string, grants = ADMIN, env = {}) => makeApp(db, BASE, importRoutes, { grants, env }).request(`${BASE}/${id}/import-issues`, jsonInit({}));
const LIST = 'GET /repos/acme/web/issues';
const LIST_URL = '/repos/acme/web/issues?state=open&sort=updated&direction=desc&per_page=100&page=1';

let setup: SyncSetup;

describe('importing open issues', () => {
  beforeEach(async () => {
    setup = await seedSyncRepository(db, 'import');
    await seedAccount(db, ALICE, 'Octo-Alice');
  });

  it('creates issues in the team, skips pull requests, and is idempotent', async () => {
    const listed = [
      githubIssue({ number: 1, title: 'First', labels: ['bug'], assignee: 'octo-alice' }),
      githubIssue({ number: 2, title: 'A pull request', pullRequest: true }),
      githubIssue({ number: 3, title: 'Third', body: null }),
    ];
    const calls = stubGithub({ [LIST]: listed });
    clearEvents();

    expect(await ok<MergeImportIssuesResult>(await run(setup.repo.id))).toEqual({ imported: 2, updated: 0, skipped: 0 });
    expect(calls).toEqual(perRun([{ method: 'GET', url: LIST_URL }]));
    const rows = await db.select().from(schema.mergeIssues);
    expect(rows.map((r) => r.title).sort()).toEqual(['First', 'Third']);
    expect(rows.every((r) => r.teamId === setup.team.id && r.status === 'todo')).toBe(true);
    expect(rows.find((r) => r.title === 'First')).toMatchObject({ assigneeUserId: ALICE, creatorUserId: ALICE });
    expect(await db.select().from(schema.mergeExternalIssues)).toHaveLength(2);
    expect(eventTypes().sort()).toEqual(['merge_issue:created', 'merge_issue:created', 'merge_label:created']);

    clearEvents();
    expect(await ok<MergeImportIssuesResult>(await run(setup.repo.id))).toEqual({ imported: 0, updated: 0, skipped: 2 });
    expect(events).toEqual([]);
    expect(await db.select().from(schema.mergeIssues)).toHaveLength(2);
  });

  it('refreshes the issues it already knows when GitHub changed them', async () => {
    stubGithub({ [LIST]: [githubIssue({ number: 1, title: 'First', updatedAt: '2026-11-02T09:00:00Z' })] });
    await run(setup.repo.id);
    stubGithub({
      [LIST]: [
        githubIssue({ number: 1, title: 'First, renamed', updatedAt: '2026-11-02T10:00:00Z' }),
        githubIssue({ number: 4, title: 'New one' }),
      ],
    });
    clearEvents();
    expect(await ok<MergeImportIssuesResult>(await run(setup.repo.id))).toEqual({ imported: 1, updated: 1, skipped: 0 });
    expect((await db.select().from(schema.mergeIssues)).map((r) => r.title).sort()).toEqual(['First, renamed', 'New one']);
    expect(eventTypes().sort()).toEqual(['merge_issue:created', 'merge_issue:updated']);
  });

  it('works for a two_way repository too', async () => {
    await db.update(schema.mergeRepositories).set({ issueSync: 'two_way' });
    stubGithub({ [LIST]: [githubIssue({ number: 1 })] });
    expect(await ok<MergeImportIssuesResult>(await run(setup.repo.id))).toEqual({ imported: 1, updated: 0, skipped: 0 });
  });
});

describe('what it refuses', () => {
  it('needs merge_connections:manage and a known repository', async () => {
    setup = await seedSyncRepository(db, 'import');
    const calls = stubGithub({ [LIST]: [] });
    expect((await run(setup.repo.id, MEMBER)).status).toBe(403);
    expect((await run('mrp_unknown')).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 422 with issue sync off, without a team, and for a provider without issues', async () => {
    setup = await seedSyncRepository(db, 'off');
    const calls = stubGithub({ [LIST]: [] });
    expect((await run(setup.repo.id)).status).toBe(422);
    await db.update(schema.mergeRepositories).set({ issueSync: 'import', teamId: null });
    expect((await run(setup.repo.id)).status).toBe(422);

    const team = await seedTeam(db, 'API');
    const connection = await seedConnection(db, { provider: 'bitbucket', externalAccountId: 'bb-1' });
    const repo = await seedRepository(db, connection.id, { provider: 'bitbucket', externalId: 'bb-r', fullName: 'acme/bb', teamId: team.id });
    expect((await run(repo.id)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it('answers 502 provider_error when GitHub fails, 503 without the App credentials', async () => {
    setup = await seedSyncRepository(db, 'import');
    stubGithub({ [LIST]: new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }) });
    const failed = await run(setup.repo.id);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: { code: string; message: string } }).error).toEqual({ code: 'provider_error', message: 'Bad credentials' });
    expect(await db.select().from(schema.mergeIssues)).toEqual([]);

    const unconfigured = await run(setup.repo.id, ADMIN, { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined });
    expect(unconfigured.status).toBe(503);
    expect(await errorCode(unconfigured)).toBe('SERVICE_UNAVAILABLE');
  });

  it('ignores a repository on a revoked connection', async () => {
    setup = await seedSyncRepository(db, 'import');
    await db.update(schema.mergeConnections).set({ status: 'revoked' });
    stubGithub({ [LIST]: [] });
    expect((await run(setup.repo.id)).status).toBe(404);
  });
});
