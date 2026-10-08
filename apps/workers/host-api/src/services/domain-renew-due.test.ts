/**
 * The auto-renew sweep's D1 due index: when a workspace next needs a look
 * (`nextDomainRenewCheckAt`) and the middleware that marks it due on writes.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { listDueWorkspaces } from '@weldsuite/worker-kit/due-index';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { loadNextDomainRenewCheckAt, nextDomainRenewCheckAt } from './domain-renewal-billing';
import { markDomainRenewDue } from '../lib/domain-renew-due';
import type { Env, Variables } from '../types';

const now = new Date('2026-08-14T12:00:00.000Z');
const DAY = 86_400_000;
const daysFromNow = (days: number) => new Date(now.getTime() + days * DAY);

const active = {
  autoRenew: true,
  status: 'active',
  registrar: 'realtimeregister',
  expiresAt: daysFromNow(100),
  deletedAt: null,
  registrationStatus: 'registered' as string | null,
  updatedAt: daysFromNow(-200),
};

describe('nextDomainRenewCheckAt', () => {
  it('is null without Realtime Register domains', () => {
    expect(nextDomainRenewCheckAt([], now)).toBeNull();
    expect(nextDomainRenewCheckAt([{ ...active, registrar: 'External' }], now)).toBeNull();
  });

  it('waits until the first auto-renewing domain enters the 14-day window', () => {
    const next = nextDomainRenewCheckAt([{ ...active }, { ...active, expiresAt: daysFromNow(40) }], now);
    expect(next?.getTime()).toBe(daysFromNow(40 - 14).getTime());
  });

  it('is due now for a domain inside the window or awaiting a renewal', () => {
    expect(nextDomainRenewCheckAt([{ ...active, expiresAt: daysFromNow(5) }], now)?.getTime()).toBe(now.getTime());
    expect(
      nextDomainRenewCheckAt([{ ...active, registrationStatus: 'pending_renewal' }], now)?.getTime(),
    ).toBe(now.getTime());
  });

  it('looks again tomorrow while a registration or transfer settles, for up to 30 days', () => {
    const settling = { ...active, status: 'pending', expiresAt: null, registrationStatus: 'pending_payment', updatedAt: daysFromNow(-3) };
    expect(nextDomainRenewCheckAt([settling], now)?.getTime()).toBe(daysFromNow(1).getTime());
    expect(
      nextDomainRenewCheckAt([{ ...settling, registrationStatus: 'pending_transfer', updatedAt: daysFromNow(-29) }], now)?.getTime(),
    ).toBe(daysFromNow(1).getTime());
    expect(nextDomainRenewCheckAt([{ ...settling, updatedAt: daysFromNow(-31) }], now)).toBeNull();
  });

  it('ignores deleted domains, auto-renew off and domains past the grace period', () => {
    expect(
      nextDomainRenewCheckAt(
        [
          { ...active, deletedAt: daysFromNow(-1) },
          { ...active, autoRenew: false },
          { ...active, status: 'expired', expiresAt: daysFromNow(-8) },
        ],
        now,
      ),
    ).toBeNull();
  });
});

describe('loadNextDomainRenewCheckAt', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);
  beforeEach(async () => {
    await db.delete(schema.hostDomains);
  });

  it('derives the next look from the tenant’s Realtime Register domains', async () => {
    const seed = (name: string, fields: Partial<typeof schema.hostDomains.$inferInsert>) => ({
      id: generateId('dom'),
      name,
      tld: 'com',
      fullDomain: `${name}.com`,
      status: 'active' as const,
      registrar: 'realtimeregister',
      autoRenew: true,
      registrationStatus: 'registered' as const,
      ...fields,
    });
    await db.insert(schema.hostDomains).values([
      seed('later', { expiresAt: daysFromNow(300) }),
      seed('sooner', { expiresAt: daysFromNow(60) }),
      seed('external', { registrar: 'External', expiresAt: daysFromNow(20) }),
    ]);

    expect((await loadNextDomainRenewCheckAt(db, now))?.getTime()).toBe(daysFromNow(60 - 14).getTime());
  });
});

describe('markDomainRenewDue', () => {
  const MIGRATION = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
    'utf8',
  );

  function makeApp() {
    const d1 = createSqliteD1(MIGRATION);
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('workspaceId', 'org_host');
      await next();
    });
    app.use('/api/domains/*', markDomainRenewDue);
    app.post('/api/domains/ok', (c) => c.json({ data: {} }, 201));
    app.post('/api/domains/bad', (c) => c.json({ error: {} }, 400));
    app.get('/api/domains/list', (c) => c.json({ data: [] }));
    const request = (path: string, method = 'POST') =>
      app.request(path, { method }, { SCHEDULE_INDEX: d1 } as unknown as Env);
    return { d1, request };
  }

  it('marks the workspace due after a successful write', async () => {
    const { d1, request } = makeApp();
    expect((await request('/api/domains/ok')).status).toBe(201);
    const due = await listDueWorkspaces(d1, 'domain_renew', Date.now() + 1000, 10);
    expect(due.map((r) => r.workspaceId)).toEqual(['org_host']);
  });

  it('leaves the index alone for reads and failed writes', async () => {
    const { d1, request } = makeApp();
    await request('/api/domains/list', 'GET');
    await request('/api/domains/bad');
    expect(await listDueWorkspaces(d1, 'domain_renew', Date.now() + 1000, 10)).toEqual([]);
  });
});
