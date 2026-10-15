/**
 * The suppression list: the lookups, and what adding or removing an entry does
 * to prospects and campaigns, against pglite.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { reachEnrollments, reachProspects } from '@weldsuite/db/schema';
import { ReachDomainError } from './errors';
import type { ReachEvent } from './events';
import {
  addManualSuppressions,
  domainSuffixes,
  listSuppressions,
  loadSuppressionIndex,
  normalizeSuppressionValue,
  removeSuppression,
} from './suppressions';
import { resetReach, seedCampaign, seedEnrollment, seedProspect } from './testing/reach';

let db: Database;
let events: ReachEvent[];

const deps = () => ({
  db,
  emit: (event: ReachEvent) => {
    events.push(event);
  },
  userId: 'user_1',
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  events = [];
});

describe('values', () => {
  it('reads a pasted value as an address or a whole domain', () => {
    expect(normalizeSuppressionValue(' Jane@BigCo.io ')).toEqual({ value: 'jane@bigco.io', type: 'email' });
    expect(normalizeSuppressionValue('@bigco.io')).toEqual({ value: 'bigco.io', type: 'domain' });
    expect(normalizeSuppressionValue('bigco.io')).toEqual({ value: 'bigco.io', type: 'domain' });
    expect(normalizeSuppressionValue('nonsense')).toBeNull();
    expect(normalizeSuppressionValue('')).toBeNull();
  });

  it('lists a domain and its parents, never the bare TLD', () => {
    expect(domainSuffixes('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
  });
});

describe('addManualSuppressions', () => {
  it('stores entries, flags matching prospects, stops their enrollments and completes a campaign that ran out', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const blocked = await seedProspect(db, { email: 'jane@corp.example' });
    const enrollment = await seedEnrollment(db, campaign.id, blocked.id);

    const result = await addManualSuppressions(deps(), ['corp.example', 'JANE@other.io', 'not valid', 'corp.example']);

    expect(result).toEqual({ added: 2, skipped: 2 });
    const [prospect] = await db.select().from(reachProspects).where(eq(reachProspects.id, blocked.id));
    expect(prospect?.validation).toBe('suppressed');
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: 'unsubscribed', stoppedReason: 'suppressed:manual' });
    expect(events).toMatchObject([{ entityType: 'reach_campaign', action: 'completed', entityId: campaign.id }]);

    const index = await loadSuppressionIndex(db, ['x@mail.corp.example', 'jane@other.io', 'fine@bigco.io']);
    expect(index.check('x@mail.corp.example')).toMatchObject({ type: 'domain', reason: 'manual' });
    expect(index.check('jane@other.io')).toMatchObject({ type: 'email' });
    expect(index.check('fine@bigco.io')).toBeNull();
  });
});

describe('removeSuppression', () => {
  it('lets prospects that nothing suppresses any more become valid, and 404s an unknown entry', async () => {
    const p = await seedProspect(db, { email: 'jane@corp.example' });
    await addManualSuppressions(deps(), ['corp.example']);
    const [entry] = (await listSuppressions(db)).data;

    await removeSuppression(db, entry?.id as string);

    const [prospect] = await db.select().from(reachProspects).where(eq(reachProspects.id, p.id));
    expect(prospect?.validation).toBe('valid');
    expect((await listSuppressions(db)).totalCount).toBe(0);

    const err = await removeSuppression(db, entry?.id as string).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReachDomainError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', status: 404, message: `Suppression with ID '${entry?.id}' not found` });
  });
});

describe('listSuppressions', () => {
  it('lists newest first, searches by value and pages with a cursor', async () => {
    await addManualSuppressions(deps(), ['alpha.example']);
    await addManualSuppressions(deps(), ['beta.example']);

    expect((await listSuppressions(db, { search: 'alp' })).data.map((e) => e.value)).toEqual(['alpha.example']);
    const first = await listSuppressions(db, { limit: '1' });
    expect(first).toMatchObject({ totalCount: 2, hasMore: true });
    expect(first.data[0]).toMatchObject({ type: 'domain', reason: 'manual', source: 'manual', createdBy: 'user_1' });
    const next = await listSuppressions(db, { limit: 1, cursor: first.cursor ?? undefined });
    expect(next.hasMore).toBe(false);
    expect(next.data[0]?.value).not.toBe(first.data[0]?.value);
  });
});
