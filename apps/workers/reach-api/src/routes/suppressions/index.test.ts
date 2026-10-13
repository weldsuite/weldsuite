import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import type { ReachSuppression } from '@weldsuite/app-api-client/schemas/reach';
import { reachCampaigns, reachEnrollments, reachProspects, reachSuppressions } from '@weldsuite/db/schema';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
import suppressionRoutes from './index';
import { asJson, readJson, reachApp } from '../../test-support/routes';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedProspect } from '../../test-support/reach';
import { domainSuffixes, normalizeSuppressionValue, SuppressionIndex } from '../../services/suppressions';

const publish = publishEntityEvent as ReturnType<typeof vi.fn>;
let db: Database;

const app = (permissions = ['reach_settings:read', 'reach_settings:update']) =>
  reachApp('/api/reach/suppressions', suppressionRoutes, { permissions, db });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  publish.mockClear();
});

describe('POST /', () => {
  it('adds emails and domains, typed by what they look like, and ignores junk and repeats', async () => {
    const res = await app().request(
      '/api/reach/suppressions',
      asJson('POST', {
        values: ['Jane@BigCo.io', 'competitor.com', '@rival.example', 'jane@bigco.io', 'not valid', 'also@@bad', 'sub.example.org'],
      }),
    );

    expect(res.status).toBe(201);
    expect((await readJson<{ data: { added: number; skipped: number } }>(res)).data).toEqual({ added: 4, skipped: 3 });
    const rows = await db.select().from(reachSuppressions);
    expect(Object.fromEntries(rows.map((r) => [r.value, [r.type, r.reason]]))).toEqual({
      'jane@bigco.io': ['email', 'manual'],
      'competitor.com': ['domain', 'manual'],
      'rival.example': ['domain', 'manual'],
      'sub.example.org': ['domain', 'manual'],
    });

    const again = await app().request('/api/reach/suppressions', asJson('POST', { values: ['jane@bigco.io'] }));
    expect((await readJson<{ data: { added: number } }>(again)).data.added).toBe(0);
  });

  it('flags matching prospects, stops their running enrollments and completes the campaign that had nothing else', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const keeper = await seedProspect(db, { email: 'keeper@fine.io' });
    const byEmail = await seedProspect(db, { email: 'jane@bigco.io' });
    const byDomain = await seedProspect(db, { email: 'bob@corp.example' });
    const role = await seedProspect(db, { email: 'info@bigco.io', validation: 'role' });
    await seedEnrollment(db, campaign.id, keeper.id);
    const e1 = await seedEnrollment(db, campaign.id, byEmail.id, { claimedAt: new Date() });
    const e2 = await seedEnrollment(db, campaign.id, byDomain.id, { status: 'queued', nextSendAt: null });

    await app().request('/api/reach/suppressions', asJson('POST', { values: ['jane@bigco.io', 'corp.example', 'info@bigco.io'] }));

    const verdict = async (id: string) => (await db.select().from(reachProspects).where(eq(reachProspects.id, id)))[0]?.validation;
    expect(await verdict(byEmail.id)).toBe('suppressed');
    expect(await verdict(byDomain.id)).toBe('suppressed');
    expect(await verdict(keeper.id)).toBe('valid');
    expect(await verdict(role.id)).toBe('role'); // a worse verdict is not overwritten
    for (const id of [e1.id, e2.id]) {
      const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, id));
      expect(row).toMatchObject({ status: 'unsubscribed', stoppedReason: 'suppressed:manual', claimedAt: null, nextSendAt: null });
    }
    // the keeper is still running, so the campaign is too
    expect((await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id)))[0]?.status).toBe('active');
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'completed' }));

    // once the last one is suppressed the campaign completes and says so
    await app().request('/api/reach/suppressions', asJson('POST', { values: ['keeper@fine.io'] }));
    expect((await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id)))[0]?.status).toBe('completed');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'reach_campaign', action: 'completed', entityId: campaign.id }));
  });

  it('needs reach_settings:update', async () => {
    expect((await app(['reach_settings:read']).request('/api/reach/suppressions', asJson('POST', { values: ['a@b.io'] }))).status).toBe(403);
    expect((await app().request('/api/reach/suppressions', asJson('POST', { values: [] }))).status).toBe(400);
  });
});

describe('GET /', () => {
  it('lists newest first with search and a cursor, in the contract shape', async () => {
    await db.insert(reachSuppressions).values([
      { id: 'rsup_1', value: 'one@bigco.io', type: 'email', reason: 'unsubscribed', source: 'rmsg_1', createdBy: 'user_1' },
      { id: 'rsup_2', value: 'two@other.io', type: 'email', reason: 'bounced' },
      { id: 'rsup_3', value: 'bigco.example', type: 'domain', reason: 'manual' },
    ]);

    const all = await readJson<{ data: ReachSuppression[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
      await app().request('/api/reach/suppressions?limit=2'),
    );
    expect(all.data).toHaveLength(2);
    expect(all.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    const rest = await readJson<{ data: ReachSuppression[] }>(await app().request(`/api/reach/suppressions?limit=2&cursor=${all.pagination.cursor}`));
    expect(rest.data).toHaveLength(1);

    const found = await readJson<{ data: ReachSuppression[]; pagination: { totalCount: number } }>(await app().request('/api/reach/suppressions?search=bigco'));
    expect(found.data.map((s) => s.value).sort()).toEqual(['bigco.example', 'one@bigco.io']);
    expect(found.pagination.totalCount).toBe(2);
    expect(found.data.find((s) => s.value === 'one@bigco.io')).toEqual({
      id: 'rsup_1',
      value: 'one@bigco.io',
      type: 'email',
      reason: 'unsubscribed',
      source: 'rmsg_1',
      createdBy: 'user_1',
      createdAt: expect.any(String),
    });
  });

  it('needs reach_settings:read', async () => {
    expect((await app([]).request('/api/reach/suppressions')).status).toBe(403);
  });
});

describe('DELETE /:id', () => {
  it('removes the entry and frees prospects nothing else suppresses', async () => {
    const free = await seedProspect(db, { email: 'free@bigco.io', validation: 'suppressed' });
    const still = await seedProspect(db, { email: 'still@bigco.io', validation: 'suppressed' });
    await db.insert(reachSuppressions).values([
      { id: 'rsup_1', value: 'bigco.io', type: 'domain', reason: 'manual' },
      { id: 'rsup_2', value: 'still@bigco.io', type: 'email', reason: 'unsubscribed' },
    ]);

    const res = await app().request('/api/reach/suppressions/rsup_1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(await db.select().from(reachSuppressions)).toHaveLength(1);
    const verdict = async (id: string) => (await db.select().from(reachProspects).where(eq(reachProspects.id, id)))[0]?.validation;
    expect(await verdict(free.id)).toBe('valid');
    expect(await verdict(still.id)).toBe('suppressed');
    expect((await app().request('/api/reach/suppressions/rsup_1', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('suppression matching', () => {
  it('matches a domain entry on its subdomains but never on a bare TLD or a look-alike', () => {
    const index = new SuppressionIndex(
      new Map([['jane@bigco.io', { value: 'jane@bigco.io', type: 'email', reason: 'unsubscribed' }]]),
      new Map([['corp.example', { value: 'corp.example', type: 'domain', reason: 'manual' }]]),
    );
    expect(index.check('jane@bigco.io')?.reason).toBe('unsubscribed');
    expect(index.check('x@corp.example')?.value).toBe('corp.example');
    expect(index.check('x@mail.eu.corp.example')?.value).toBe('corp.example');
    expect(index.check('x@notcorp.example')).toBeNull();
    expect(index.check('x@corp.example.org')).toBeNull();
    expect(index.check('other@bigco.io')).toBeNull();
    expect(SuppressionIndex.empty().check('a@b.io')).toBeNull();
    expect(domainSuffixes('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
  });

  it('normalises pasted values', () => {
    expect(normalizeSuppressionValue('  Jane@BigCo.io ')).toEqual({ value: 'jane@bigco.io', type: 'email' });
    expect(normalizeSuppressionValue('@Rival.Example')).toEqual({ value: 'rival.example', type: 'domain' });
    expect(normalizeSuppressionValue('rival.example')).toEqual({ value: 'rival.example', type: 'domain' });
    for (const bad of ['', '   ', 'nodot', 'a@b', '@', 'two@@x.io', '-bad.example', 'spaces in.example']) {
      expect(normalizeSuppressionValue(bad), bad).toBeNull();
    }
  });
});
