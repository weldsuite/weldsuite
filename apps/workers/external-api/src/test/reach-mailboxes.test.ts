/**
 * WeldReach on the public API: mailboxes and domains are read only, and the
 * mail provider behind them stays out of sight.
 *
 * Each inbox is billed, so there is no write route here at all (405/404). A
 * response carries neither the mailbox logins nor any `mailpool*` field of the
 * rows the domain reads.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reachDomains } from '@weldsuite/db/schema';
import { resetReach, seedMailbox } from '@weldsuite/reach-domain/testing/reach';
import { seedHostDomain, seedReachDomain, resetReachTenant } from '@weldsuite/reach-domain/testing/account';
import { createPgliteDb } from './pglite';
import { withoutMailpool } from '../lib/reach';
import type { Database } from '../db';
import type { Env } from '../types';
import { reachTestApp } from './reach-support';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  await resetReachTenant(db);
});

// The suite shares one module cache across files: put the console back.
afterEach(() => {
  vi.restoreAllMocks();
});

interface Data<T> {
  data: T;
}
interface Paged<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}
interface ErrorBody {
  error: { code: string; message: string };
}

/** A master DB nobody listens on: the warmup numbers are best effort, so a mailbox list must still answer. */
const NO_MASTER: Partial<Env> = { HYPERDRIVE_MASTER: { connectionString: 'postgres://nobody:nothing@127.0.0.1:1/master' } as Hyperdrive };

async function domainWithMailbox() {
  await seedHostDomain(db, { id: 'dom_getacme', fullDomain: 'getacme.com' });
  const domain = await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_getacme', name: 'getacme.com', mailpoolDomainId: 'mp_dom_secret_77' });
  const mailbox = await seedMailbox(db, { domainId: domain.id, mailpoolMailboxId: 'mp_mbx_secret_88' });
  return { domain, mailbox };
}

describe('domains', () => {
  it('lists and reads a domain without the mail provider ids', async () => {
    const { domain, mailbox } = await domainWithMailbox();
    const app = reachTestApp({ db });

    const list = await app.get<Paged<Record<string, unknown>>>('/v1/reach/domains');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: domain.id, name: 'getacme.com', status: 'active', hostDomainId: 'dom_getacme', mailboxCount: 1 });
    expect(list.body.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });
    expect(JSON.stringify(list.body)).not.toMatch(/mailpool/i);
    expect(JSON.stringify(list.body)).not.toContain('mp_dom_secret_77');

    const one = await app.get<Data<Record<string, unknown>>>(`/v1/reach/domains/${domain.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: domain.id, mailboxCount: 1 });
    expect(Object.keys(one.body.data).filter((key) => /mailpool/i.test(key))).toEqual([]);
    expect(JSON.stringify(one.body)).not.toContain('mp_dom_secret_77');
    expect(mailbox.id).toBeTruthy();
  });

  it('answers 404 for an unknown domain', async () => {
    const res = await reachTestApp({ db }).get<ErrorBody>('/v1/reach/domains/rdom_nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('has no write routes: connecting, refreshing and disconnecting stay in the app', async () => {
    const { domain } = await domainWithMailbox();
    const app = reachTestApp({ db });
    for (const [method, path] of [
      ['POST', '/v1/reach/domains'],
      ['DELETE', `/v1/reach/domains/${domain.id}`],
      ['PATCH', `/v1/reach/domains/${domain.id}`],
      ['POST', `/v1/reach/domains/${domain.id}/refresh-dns`],
      ['GET', '/v1/reach/domains/candidates/x/y'],
    ] as const) {
      const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(404);
      expect(res.status, `${method} ${path}`).toBeLessThanOrEqual(405);
    }
    expect(await db.select().from(reachDomains)).toHaveLength(1);
  });
});

describe('mailboxes', () => {
  it('lists and reads a mailbox without its logins, its inbound token or the mail provider ids', async () => {
    const { domain, mailbox } = await domainWithMailbox();
    const app = reachTestApp({ db, env: NO_MASTER });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const list = await app.get<Paged<Record<string, unknown>>>('/v1/reach/mailboxes');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: mailbox.id,
      domainId: domain.id,
      domainName: 'getacme.com',
      email: mailbox.email,
      status: 'active',
      dailyCap: 30,
      sentToday: 0,
      warmupSent7d: 0,
      warmupBlocker: null,
    });
    expect(list.body.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });

    const one = await app.get<Data<Record<string, unknown>>>(`/v1/reach/mailboxes/${mailbox.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.email).toBe(mailbox.email);

    for (const body of [list.body, one.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/mailpool/i);
      expect(text).not.toMatch(/credential|password|inboundToken|smtp|imap/i);
      expect(text).not.toContain('mp_mbx_secret_88');
      expect(text).not.toContain(mailbox.inboundToken);
    }
  });

  it('filters by domain and status, and hides deleted mailboxes', async () => {
    const { domain, mailbox } = await domainWithMailbox();
    const paused = await seedMailbox(db, { domainId: domain.id, status: 'paused' });
    await seedMailbox(db, { domainId: 'rdom_other', status: 'deleted' });
    const app = reachTestApp({ db, env: NO_MASTER });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const ids = async (query: string) => (await app.get<Paged<{ id: string }>>(`/v1/reach/mailboxes${query}`)).body.data.map((m) => m.id).sort();
    expect(await ids('')).toEqual([mailbox.id, paused.id].sort());
    expect(await ids('?status=paused')).toEqual([paused.id]);
    expect(await ids(`?domainId=${domain.id}&status=active`)).toEqual([mailbox.id]);
    expect(await ids('?domainId=rdom_nope')).toEqual([]);
  });

  it('answers 404 for an unknown or deleted mailbox, and 400 for a bad status filter', async () => {
    const deleted = await seedMailbox(db, { status: 'deleted' });
    const app = reachTestApp({ db });

    for (const id of ['rmbx_nope', deleted.id]) {
      const res = await app.get<ErrorBody>(`/v1/reach/mailboxes/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const bad = await app.get<ErrorBody>('/v1/reach/mailboxes?status=bogus');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('has no write routes: creating, changing, pausing and deleting a billed inbox stay in the app', async () => {
    const mailbox = await seedMailbox(db);
    const app = reachTestApp({ db });
    for (const [method, path] of [
      ['POST', '/v1/reach/mailboxes'],
      ['PATCH', `/v1/reach/mailboxes/${mailbox.id}`],
      ['DELETE', `/v1/reach/mailboxes/${mailbox.id}`],
      ['POST', `/v1/reach/mailboxes/${mailbox.id}/pause`],
      ['POST', `/v1/reach/mailboxes/${mailbox.id}/resume`],
    ] as const) {
      const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(404);
      expect(res.status, `${method} ${path}`).toBeLessThanOrEqual(405);
    }
    expect((await app.get<Paged<unknown>>('/v1/reach/mailboxes', )).body.pagination.totalCount).toBe(1);
  });
});

describe('withoutMailpool', () => {
  it('drops every mailpool* key, whatever its case, and keeps the rest', () => {
    const row = { id: 'rdom_1', name: 'getacme.com', mailpoolDomainId: 'mp_1', mailpoolMailboxId: 'mp_2', MailpoolStatus: 'x', status: 'active', mailboxCount: 2, notes: null };
    expect(withoutMailpool(row)).toEqual({ id: 'rdom_1', name: 'getacme.com', status: 'active', mailboxCount: 2, notes: null });
    expect(row.mailpoolDomainId).toBe('mp_1');
  });
});
