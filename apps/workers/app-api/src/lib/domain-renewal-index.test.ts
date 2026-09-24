/**
 * Domain renewal index (@weldsuite/db/lib/domain-renewal-index): the per-domain
 * due rule, and the tenant query against a real schema (pglite).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  DOMAIN_AUTO_RENEW_GRACE_DAYS,
  DOMAIN_AUTO_RENEW_WINDOW_DAYS,
  computeDomainRenewalDueAt,
  domainRenewalDueAt,
} from '@weldsuite/db/lib/domain-renewal-index';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from './id';
import { isDueForStripeAutoRenew } from '../services/domain-renewal-billing';

const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 8, 24, 4, 0, 0));
const daysFromNow = (n: number) => new Date(now.getTime() + n * DAY);

describe('domainRenewalDueAt', () => {
  it('is due when the renewal window opens', () => {
    const expiresAt = daysFromNow(100);
    expect(domainRenewalDueAt({ registrationStatus: 'active', expiresAt }, now)?.getTime()).toBe(
      expiresAt.getTime() - DOMAIN_AUTO_RENEW_WINDOW_DAYS * DAY,
    );
  });

  it('is due now while a renewal is pending', () => {
    expect(domainRenewalDueAt({ registrationStatus: 'pending_renewal', expiresAt: null }, now)).toBe(now);
  });

  it('is never due without an expiry or past the grace period', () => {
    expect(domainRenewalDueAt({ registrationStatus: 'active', expiresAt: null }, now)).toBeNull();
    expect(
      domainRenewalDueAt(
        { registrationStatus: 'active', expiresAt: daysFromNow(-DOMAIN_AUTO_RENEW_GRACE_DAYS - 1) },
        now,
      ),
    ).toBeNull();
  });

  it('agrees with the sweep: due now exactly when the sweep would pick the domain', () => {
    for (const offset of [-8, -7, -1, 0, 1, 13, 14, 15, 60, 400]) {
      const domain = {
        status: 'active',
        autoRenew: true,
        registrar: 'realtimeregister',
        expiresAt: daysFromNow(offset),
        deletedAt: null,
        registrationStatus: 'active',
      };
      const dueAt = domainRenewalDueAt(domain, now);
      const dueNow = dueAt !== null && dueAt <= now;
      expect({ offset, dueNow }).toEqual({ offset, dueNow: isDueForStripeAutoRenew(domain, now) });
    }
  });
});

describe('computeDomainRenewalDueAt', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);

  beforeEach(async () => {
    await db.delete(schema.hostDomains);
  });

  async function seedDomain(values: Partial<typeof schema.hostDomains.$inferInsert>) {
    await db.insert(schema.hostDomains).values({
      id: generateId('dom'),
      name: 'example',
      tld: 'com',
      fullDomain: `example-${Math.random().toString(36).slice(2)}.com`,
      status: 'active',
      registrar: 'realtimeregister',
      autoRenew: true,
      ...values,
    });
  }

  it('is null for a workspace without auto-renewing domains', async () => {
    expect(await computeDomainRenewalDueAt(db, now)).toBeNull();
  });

  it('returns the earliest window opening among candidates', async () => {
    await seedDomain({ expiresAt: daysFromNow(200) });
    await seedDomain({ expiresAt: daysFromNow(90) });
    expect((await computeDomainRenewalDueAt(db, now))?.getTime()).toBe(
      daysFromNow(90 - DOMAIN_AUTO_RENEW_WINDOW_DAYS).getTime(),
    );
  });

  it('ignores domains the sweep would never renew', async () => {
    await seedDomain({ expiresAt: daysFromNow(30), autoRenew: false });
    await seedDomain({ expiresAt: daysFromNow(30), registrar: 'cloudflare' });
    await seedDomain({ expiresAt: daysFromNow(30), status: 'pending' });
    await seedDomain({ expiresAt: daysFromNow(30), deletedAt: new Date() });
    expect(await computeDomainRenewalDueAt(db, now)).toBeNull();
  });
});
