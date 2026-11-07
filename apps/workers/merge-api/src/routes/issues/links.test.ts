/**
 * DB-backed tests for /api/merge/issues/:id/links and /api/merge/record-links on
 * a real tenant schema (pglite). What must not regress:
 *   1. Linking an issue to a ticket, company or chat channel stores it once,
 *      publishes `merge_record_link` created, and removing it publishes deleted.
 *   2. The lookup a ticket or company shows: the linked issues with status,
 *      team key and the latest shipped release carrying one of their pull
 *      requests; deleted issues and other records stay out.
 *   3. Reading needs merge_issues:read, changing needs merge_issues:update.
 *   4. A link's stored title (a ticket subject, a company or channel name) is
 *      shown only to a member who may read the record itself.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MergeRecordLinkDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeRecordLinkedIssue } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import issuesRoutes from './index';
import linksRoutes from './links';
import recordLinksRoutes from '../record-links';
import { ADMIN, ALICE, VIEWER, clearEvents, errorCode, events, jsonInit, makeApp, newId, ok, openDb, resetTables } from '../../test/helpers';
import { seedConnection, seedIssue, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await db.delete(schema.chatChannelMembers);
  await db.delete(schema.chatChannels);
});

const ISSUES = '/api/merge/issues';
const LOOKUP = '/api/merge/record-links';
const links = (grants = ADMIN) => makeApp(db, ISSUES, linksRoutes, { grants });
const lookup = (grants = ADMIN) => makeApp(db, LOOKUP, recordLinksRoutes, { grants });

async function seedLinkedWorld() {
  const team = await seedTeam(db);
  const issue = await seedIssue(db, team.id, 1);
  return { team, issue };
}

describe('POST/GET/DELETE /issues/:id/links', () => {
  it('links a record once, lists it and removes it, with events', async () => {
    const { issue } = await seedLinkedWorld();
    const created = await ok<MergeRecordLinkDto>(
      await links().request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_1', title: ' Login broken ' })),
      201,
    );
    expect(created).toMatchObject({ issueId: issue.id, recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Login broken' });
    expect(events.map((e) => [e.eventType, e.entityId])).toEqual([['merge_record_link:created', newId(created.id)]]);
    expect(events[0]!.data).toMatchObject({ issueId: issue.id, recordType: 'desk_ticket', recordId: 'tkt_1' });

    const listed = await ok<MergeRecordLinkDto[]>(await links().request(`${ISSUES}/${issue.id}/links`));
    expect(listed.map((l) => l.id)).toEqual([created.id]);

    const again = await links().request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_1' }));
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('CONFLICT');

    clearEvents();
    expect((await links().request(`${ISSUES}/${issue.id}/links/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(events.map((e) => e.eventType)).toEqual(['merge_record_link:deleted']);
    expect(await ok<MergeRecordLinkDto[]>(await links().request(`${ISSUES}/${issue.id}/links`))).toEqual([]);
  });

  it('shows the links on the issue detail, with the title only to a member who may read the record', async () => {
    const { issue } = await seedLinkedWorld();
    await links().request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'crm_company', recordId: 'cmp_1', title: 'Acme' }));
    const detailAs = async (grants: string[]) =>
      (await ok<{ recordLinks: MergeRecordLinkDto[] }>(await makeApp(db, ISSUES, issuesRoutes, { grants }).request(`${ISSUES}/${issue.id}`)))
        .recordLinks.map((l) => [l.recordType, l.recordId, l.title]);
    expect(await detailAs([...ADMIN, 'companies:read'])).toEqual([['crm_company', 'cmp_1', 'Acme']]);
    expect(await detailAs(ADMIN)).toEqual([['crm_company', 'cmp_1', null]]);
  });

  it("keeps a linked record's title from a member who may not read the record", async () => {
    const { issue } = await seedLinkedWorld();
    await db.insert(schema.chatChannels).values([
      { id: 'chc_open', name: 'General', slug: 'general', type: 'public' },
      { id: 'chc_closed', name: 'Acquisition', slug: 'acquisition', type: 'private' },
    ]);
    for (const link of [
      { recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Refund for Acme' },
      { recordType: 'crm_company', recordId: 'cmp_1', title: 'Acme' },
      { recordType: 'chat_channel', recordId: 'chc_open', title: 'General' },
      { recordType: 'chat_channel', recordId: 'chc_closed', title: 'Acquisition' },
    ]) {
      await links().request(`${ISSUES}/${issue.id}/links`, jsonInit(link));
    }
    const titles = async (grants: string[]) =>
      (await ok<MergeRecordLinkDto[]>(await links(grants).request(`${ISSUES}/${issue.id}/links`))).map((l) => [l.recordId, l.title]);

    // merge_issues:read alone: only the public channel's name (anyone may read that channel).
    expect(await titles(VIEWER)).toEqual([
      ['tkt_1', null],
      ['cmp_1', null],
      ['chc_open', 'General'],
      ['chc_closed', null],
    ]);
    // With the desk and CRM read permissions; the private channel still needs a membership.
    expect(await titles([...VIEWER, 'tickets:read', 'companies:read'])).toEqual([
      ['tkt_1', 'Refund for Acme'],
      ['cmp_1', 'Acme'],
      ['chc_open', 'General'],
      ['chc_closed', null],
    ]);
    await db.insert(schema.chatChannelMembers).values({ id: 'chm_alice', channelId: 'chc_closed', userId: ALICE, role: 'member' });
    expect((await titles(VIEWER)).find(([id]) => id === 'chc_closed')).toEqual(['chc_closed', 'Acquisition']);
  });

  it('answers 404 for an unknown issue or link, 400 for a bad body', async () => {
    const { issue } = await seedLinkedWorld();
    expect((await links().request(`${ISSUES}/mis_nope/links`)).status).toBe(404);
    expect((await links().request(`${ISSUES}/mis_nope/links`, jsonInit({ recordType: 'desk_ticket', recordId: 't' }))).status).toBe(404);
    expect((await links().request(`${ISSUES}/${issue.id}/links/mrk_nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await links().request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'person', recordId: 'p_1' }))).status).toBe(400);
    expect((await links().request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'desk_ticket' }))).status).toBe(400);

    // A link of another issue is not reachable through this one.
    const other = await seedIssue(db, issue.teamId, 2);
    const mine = await ok<MergeRecordLinkDto>(
      await links().request(`${ISSUES}/${other.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_9' })),
      201,
    );
    expect((await links().request(`${ISSUES}/${issue.id}/links/${mine.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('reads with merge_issues:read and changes only with merge_issues:update', async () => {
    const { issue } = await seedLinkedWorld();
    const link = await ok<MergeRecordLinkDto>(
      await links().request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_1' })),
      201,
    );
    expect((await links(VIEWER).request(`${ISSUES}/${issue.id}/links`)).status).toBe(200);
    expect((await links(VIEWER).request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_2' }))).status).toBe(403);
    expect((await links(VIEWER).request(`${ISSUES}/${issue.id}/links/${link.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await links([]).request(`${ISSUES}/${issue.id}/links`)).status).toBe(403);
  });
});

describe('GET /record-links', () => {
  let prNumber = 100;
  async function seedShipped(issueId: string, repositoryId: string, teamId: string, name: string, shippedAt: string) {
    const pr = await seedPullRequest(db, repositoryId, prNumber++, { state: 'merged', mergedAt: new Date(shippedAt) });
    await db.insert(schema.mergeIssuePullRequests).values({ id: generateId('mip'), issueId, pullRequestId: pr.id, source: 'auto', closes: true });
    const [release] = await db
      .insert(schema.mergeReleases)
      .values({ id: generateId('mrl'), teamId, repositoryId, name, version: 'v1', status: 'shipped', shippedAt: new Date(shippedAt), createdByUserId: 'user_alice' })
      .returning();
    await db.insert(schema.mergeReleasePullRequests).values({ id: generateId('mrr'), releaseId: release!.id, pullRequestId: pr.id });
    return release!;
  }

  it('lists the issues linked to a ticket with their status, team key and shipped release', async () => {
    const team = await seedTeam(db);
    const connection = await seedConnection(db);
    const repository = await seedRepository(db, connection.id, { teamId: team.id });
    const shippedIssue = await seedIssue(db, team.id, 1, { status: 'done', title: 'Fix login' });
    const openIssue = await seedIssue(db, team.id, 2, { status: 'in_progress', title: 'Slow search' });
    const goneIssue = await seedIssue(db, team.id, 3, { deletedAt: new Date() });
    const unrelated = await seedIssue(db, team.id, 4);
    const api = links();
    for (const issue of [shippedIssue, openIssue, goneIssue]) {
      await api.request(`${ISSUES}/${issue.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Customer: login' }));
    }
    await api.request(`${ISSUES}/${unrelated.id}/links`, jsonInit({ recordType: 'desk_ticket', recordId: 'tkt_2' }));
    await api.request(`${ISSUES}/${shippedIssue.id}/links`, jsonInit({ recordType: 'crm_company', recordId: 'tkt_1' }));
    await seedShipped(shippedIssue.id, repository.id, team.id, 'Older', '2026-10-01T10:00:00Z');
    const latest = await seedShipped(shippedIssue.id, repository.id, team.id, 'Newer', '2026-11-01T10:00:00Z');
    // A draft release carrying the pull request does not count as shipped.
    const [draft] = await db
      .insert(schema.mergeReleases)
      .values({ id: generateId('mrl'), teamId: team.id, repositoryId: repository.id, name: 'Draft', createdByUserId: 'user_alice' })
      .returning();
    const pr = await seedPullRequest(db, repository.id, 900, { state: 'merged' });
    await db.insert(schema.mergeIssuePullRequests).values({ id: generateId('mip'), issueId: openIssue.id, pullRequestId: pr.id, source: 'manual', closes: false });
    await db.insert(schema.mergeReleasePullRequests).values({ id: generateId('mrr'), releaseId: draft!.id, pullRequestId: pr.id });

    const found = await ok<MergeRecordLinkedIssue[]>(
      await lookup([...ADMIN, 'tickets:read']).request(`${LOOKUP}?recordType=desk_ticket&recordId=tkt_1`),
    );
    expect(found.map((f) => f.issue.key).sort()).toEqual(['PLAT-1', 'PLAT-2']);
    const shipped = found.find((f) => f.issue.key === 'PLAT-1')!;
    expect(shipped).toMatchObject({
      issue: { id: shippedIssue.id, title: 'Fix login', status: 'done', teamId: team.id, teamKey: 'PLAT' },
      link: { recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Customer: login' },
      release: { id: latest.id, name: 'Newer', version: 'v1', shippedAt: '2026-11-01T10:00:00.000Z' },
    });
    expect(found.find((f) => f.issue.key === 'PLAT-2')!.release).toBeNull();
    // Without tickets:read the issues are listed, the ticket's subject is not.
    const unread = await ok<MergeRecordLinkedIssue[]>(await lookup().request(`${LOOKUP}?recordType=desk_ticket&recordId=tkt_1`));
    expect(unread.map((f) => f.link.title)).toEqual([null, null]);

    expect(await ok<MergeRecordLinkedIssue[]>(await lookup().request(`${LOOKUP}?recordType=crm_company&recordId=cmp_none`))).toEqual([]);
  });

  it('is 400 without a valid record, 403 without merge_issues:read, and open to a viewer', async () => {
    expect((await lookup().request(LOOKUP)).status).toBe(400);
    expect((await lookup().request(`${LOOKUP}?recordType=person&recordId=x`)).status).toBe(400);
    expect((await lookup([]).request(`${LOOKUP}?recordType=desk_ticket&recordId=x`)).status).toBe(403);
    expect((await lookup(VIEWER).request(`${LOOKUP}?recordType=desk_ticket&recordId=x`)).status).toBe(200);
  });
});
