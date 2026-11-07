/**
 * ⌘K search over WeldMerge: issues match their title and key (`PLAT-209`), pull
 * requests match title, `#number` and branch; each is gated by its own read
 * permission, and both feed the semantic index.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { buildResultUrl, getPermittedTypes, runSearch, searchMergeIssues, searchMergePullRequests } from './search';
import { getDocumentLoader, resolveIndexedType } from './search/documents';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-11-01T10:00:00Z');
  await db.insert(schema.mergeTeams).values([
    { id: 'mtm_plat', key: 'PLAT', name: 'Platform', createdByUserId: 'u1' },
    { id: 'mtm_old', key: 'OLD', name: 'Archived', createdByUserId: 'u1', deletedAt: now },
  ]);
  await db.insert(schema.mergeIssues).values([
    { id: 'mis_1', teamId: 'mtm_plat', number: 209, title: 'Tabs flicker on resize', description: 'Seen in Safari', creatorUserId: 'u1', status: 'in_progress' },
    { id: 'mis_2', teamId: 'mtm_plat', number: 210, title: 'Export to CSV', creatorUserId: 'u1' },
    { id: 'mis_3', teamId: 'mtm_plat', number: 211, title: 'Deleted tabs bug', creatorUserId: 'u1', deletedAt: now },
    { id: 'mis_4', teamId: 'mtm_old', number: 1, title: 'Tabs in an archived team', creatorUserId: 'u1' },
  ]);
  await db.insert(schema.mergeConnections).values({
    id: 'mcn_1',
    provider: 'github',
    externalAccountId: '4242',
    accountLogin: 'acme',
    accountType: 'organization',
    createdByUserId: 'u1',
  });
  await db.insert(schema.mergeRepositories).values([
    { id: 'mrp_1', connectionId: 'mcn_1', provider: 'github', externalId: '900', fullName: 'acme/web', createdByUserId: 'u1' },
    { id: 'mrp_gone', connectionId: 'mcn_1', provider: 'github', externalId: '901', fullName: 'acme/gone', createdByUserId: 'u1', deletedAt: now },
  ]);
  const pr = { provider: 'github' as const, state: 'open' as const, providerCreatedAt: now, providerUpdatedAt: now };
  await db.insert(schema.mergePullRequests).values([
    { ...pr, id: 'mpr_1', repositoryId: 'mrp_1', externalId: '5001', number: 123, title: 'Fix tab layout', url: 'https://github.com/acme/web/pull/123', headRef: 'plat-209-fix-tabs', body: 'Closes PLAT-209' },
    { ...pr, id: 'mpr_2', repositoryId: 'mrp_1', externalId: '5002', number: 124, title: 'Bump deps', url: 'https://github.com/acme/web/pull/124', headRef: 'chore/deps' },
    { ...pr, id: 'mpr_3', repositoryId: 'mrp_gone', externalId: '5003', number: 5, title: 'Fix tab layout elsewhere', url: 'https://github.com/acme/gone/pull/5' },
  ]);
}, 60_000);

const ids = (group: { items: Array<{ id: string }> }) => group.items.map((i) => i.id);

describe('searchMergeIssues', () => {
  it('matches the title and leaves out deleted issues and deleted teams', async () => {
    const group = await searchMergeIssues(db, 'ws', 'tabs', 10);
    expect(ids(group)).toEqual(['mis_1']);
    expect(group.items[0]).toMatchObject({
      type: 'merge_issue',
      title: 'Tabs flicker on resize',
      subtitle: 'PLAT-209 · in_progress',
      url: '/weldmerge/issues/mis_1',
    });
  });

  it('matches a key, whole or in part, case-insensitively, ranking the exact key first', async () => {
    expect(ids(await searchMergeIssues(db, 'ws', 'plat-209', 10))).toEqual(['mis_1']);
    expect(ids(await searchMergeIssues(db, 'ws', 'PLAT-21', 10))).toEqual(['mis_2']);
    const all = await searchMergeIssues(db, 'ws', 'plat-', 10);
    expect(ids(all).sort()).toEqual(['mis_1', 'mis_2']);
  });

  it('reports hasMore past the limit and matches % and _ as themselves', async () => {
    expect((await searchMergeIssues(db, 'ws', 'plat-', 1)).hasMore).toBe(true);
    expect(ids(await searchMergeIssues(db, 'ws', '%', 10))).toEqual([]);
  });
});

describe('searchMergePullRequests', () => {
  it('matches title, #number, bare number and branch, and skips repositories that were removed', async () => {
    expect(ids(await searchMergePullRequests(db, 'ws', 'tab', 10))).toEqual(['mpr_1']);
    expect(ids(await searchMergePullRequests(db, 'ws', '#124', 10))).toEqual(['mpr_2']);
    expect(ids(await searchMergePullRequests(db, 'ws', '123', 10))).toEqual(['mpr_1']);
    expect(ids(await searchMergePullRequests(db, 'ws', 'chore/', 10))).toEqual(['mpr_2']);
    expect(ids(await searchMergePullRequests(db, 'ws', '#5', 10))).toEqual([]);
  });

  it('titles and links a hit', async () => {
    const group = await searchMergePullRequests(db, 'ws', 'bump', 10);
    expect(group.items[0]).toMatchObject({
      type: 'merge_pull_request',
      title: 'Bump deps',
      subtitle: 'acme/web#124 · open',
      url: '/weldmerge/pull-requests/mpr_2',
    });
  });
});

describe('runSearch · WeldMerge permissions', () => {
  const run = (grants: string[]) =>
    runSearch(db, 'ws', { q: 'tab', limit: 5, perms: { hasAny: (needed) => needed.some((p) => grants.includes(p)) } });

  it('searches each type only for a member who may read it', async () => {
    const issuesOnly = await run(['merge_issues:read']);
    expect(issuesOnly.groups.map((g) => g.type)).toEqual(['merge_issue']);
    expect(issuesOnly.permittedTypes).toEqual(['merge_issue']);

    const both = await run(['merge_issues:read', 'merge_pull_requests:read']);
    expect(both.groups.map((g) => g.type)).toEqual(['merge_issue', 'merge_pull_request']);

    expect((await run(['contacts:read'])).groups.some((g) => g.type.startsWith('merge_'))).toBe(false);
    expect(getPermittedTypes({ hasAny: (needed) => needed.includes('merge_pull_requests:read') })).toEqual(['merge_pull_request']);
  });

  it('links to the issue and pull request pages', () => {
    expect(buildResultUrl('merge_issue', 'mis_1')).toBe('/weldmerge/issues/mis_1');
    expect(buildResultUrl('merge_pull_request', 'mpr_1')).toBe('/weldmerge/pull-requests/mpr_1');
  });
});

describe('semantic index documents', () => {
  it('index merge_issue events under their own type, and leave pull requests to the lexical search', () => {
    expect(resolveIndexedType('merge_issue')).toBe('merge_issue');
    expect(resolveIndexedType('merge_pull_request')).toBeNull();
    expect(resolveIndexedType('merge_comment')).toBeNull();
  });

  it('turn an issue into a document with its key, title and description, and skip deleted ones', async () => {
    const loader = getDocumentLoader('merge_issue')!;
    const doc = await loader.load(db, 'mis_1');
    expect(doc).toMatchObject({
      entityType: 'merge_issue',
      entityId: 'mis_1',
      title: 'Tabs flicker on resize',
      subtitle: 'PLAT-209',
      url: '/weldmerge/issues/mis_1',
    });
    expect(doc!.content).toContain('PLAT-209');
    expect(doc!.content).toContain('Seen in Safari');
    expect(await loader.load(db, 'mis_3')).toBeNull();
    expect(await loader.load(db, 'mis_4')).toBeNull();

    const page = await loader.page(db, null, 50);
    expect(page.documents.map((d) => d.entityId)).toEqual(['mis_1', 'mis_2']);
  });

});
