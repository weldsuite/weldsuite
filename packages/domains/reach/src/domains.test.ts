/**
 * Domain reads: the DTO with its live mailbox count, and the 404, against pglite.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { ReachDomainError } from './errors';
import { domainMailboxCounts, getDomainDto, listDomains, requireDomain } from './domains';
import { resetReachTenant, seedMailbox, seedReachDomain } from './testing/account';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReachTenant(db);
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com' });
  await seedReachDomain(db, { id: 'rdom_2', hostDomainId: 'dom_2', name: 'tryacme.com', status: 'connecting' });
});

describe('domain reads', () => {
  it('lists every connected domain with the number of mailboxes still on it', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'deleted', deletedAt: new Date() });

    const domains = await listDomains(db);

    expect(domains.map((d) => [d.name, d.status, d.mailboxCount])).toEqual([
      ['getacme.com', 'active', 2],
      ['tryacme.com', 'connecting', 0],
    ]);
    expect(domains[0]).toMatchObject({ id: 'rdom_1', hostDomainId: 'dom_1', dnsStatus: null, lastError: null });
    expect(Object.fromEntries(await domainMailboxCounts(db, ['rdom_1', 'rdom_2']))).toEqual({ rdom_1: 2 });
    expect(await domainMailboxCounts(db, [])).toEqual(new Map());
  });

  it('reads one, and answers a missing one with a 404 naming it', async () => {
    expect(await getDomainDto(db, 'rdom_2')).toMatchObject({ name: 'tryacme.com', mailboxCount: 0 });

    const err = await requireDomain(db, 'rdom_ghost').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReachDomainError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', status: 404, message: "Domain with ID 'rdom_ghost' not found" });
  });
});
