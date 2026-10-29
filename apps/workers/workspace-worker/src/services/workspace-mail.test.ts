/**
 * ensureWorkspaceMail: the domain row stays `pending` until Cloudflare
 * accepts, no mailbox is created when it refuses, and a re-run on a
 * workspace that already has `team@` still re-asserts the provisioning.
 * The tenant/master databases are a small in-memory fake of the drizzle
 * calls the routine makes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mailAccountRegistry } from '@weldsuite/db/schema/master';
import { mailDomains } from '@weldsuite/db/schema/mail-domains';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { mailLabels } from '@weldsuite/db/schema/mail-labels';
import { mailboxDirectoryVersionKey } from '@weldsuite/db/lib/mailbox-directory-cache';

const provision = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('./mail-provisioning', () => ({
  provisionMailDomain: provision.fn,
  workspaceMailDomain: (env: { WELDMAIL_DOMAIN?: string }, slug: string) =>
    `${slug}.${env.WELDMAIL_DOMAIN ?? 'weldmail.com'}`,
}));

import type { Env } from '../index';
import { ensureWorkspaceMail, type EnsureWorkspaceMailInput } from './workspace-mail';

type Row = Record<string, unknown>;

/** Tables keyed by drizzle table object; `where` filters are not evaluated (one workspace per test). */
function fakeDb() {
  const tables = new Map<unknown, Row[]>();
  const rows = (table: unknown) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: async () => rows(table).slice(0, 1) }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        rows(table).push(...list);
        const done = Promise.resolve();
        return Object.assign(done, { onConflictDoNothing: async () => undefined });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async () => {
          for (const row of rows(table)) Object.assign(row, values);
        },
      }),
    }),
  };
  return { db, rows };
}

/** Map-backed stand-in for the WORKSPACE_CACHE KV namespace (mirrors workflows/refill-pool.test.ts's fake). */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function envWithKv(kv: ReturnType<typeof fakeKv> = fakeKv()) {
  return { WELDMAIL_DOMAIN: 'weldmail.org', WORKSPACE_CACHE: kv } as unknown as Env;
}

const env = envWithKv();

function input(tenant: ReturnType<typeof fakeDb>, master: ReturnType<typeof fakeDb>): EnsureWorkspaceMailInput {
  return {
    tenantDb: tenant.db as unknown as EnsureWorkspaceMailInput['tenantDb'],
    masterDb: master.db as unknown as EnsureWorkspaceMailInput['masterDb'],
    workspaceId: 'ws_1',
    slug: 'acme',
    displayName: 'Acme',
  };
}

beforeEach(() => {
  provision.fn.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('ensureWorkspaceMail', () => {
  it('creates a verified domain, the team@ mailbox, its labels and the registry row', async () => {
    provision.fn.mockResolvedValue(true);
    const tenant = fakeDb();
    const master = fakeDb();

    const result = await ensureWorkspaceMail(env, input(tenant, master));

    expect(result).toMatchObject({ domain: 'acme.weldmail.org', email: 'team@acme.weldmail.org', accountCreated: true, provisioned: true });
    expect(tenant.rows(mailDomains)).toEqual([
      expect.objectContaining({ domainName: 'acme.weldmail.org', dnsStatus: 'verified', currentEmailAccounts: 1 }),
    ]);
    expect(tenant.rows(mailAccounts)).toEqual([expect.objectContaining({ email: 'team@acme.weldmail.org', displayName: 'Acme' })]);
    expect(tenant.rows(mailLabels)).toHaveLength(10);
    expect(master.rows(mailAccountRegistry)).toEqual([
      expect.objectContaining({ email: 'team@acme.weldmail.org', workspaceId: 'ws_1', accountId: result.accountId }),
    ]);
  });

  it('leaves the domain pending and creates no mailbox when Cloudflare refuses', async () => {
    provision.fn.mockRejectedValue(new Error('zone limit reached'));
    const tenant = fakeDb();
    const master = fakeDb();

    await expect(ensureWorkspaceMail(env, input(tenant, master))).rejects.toThrow('zone limit reached');

    expect(tenant.rows(mailDomains)).toEqual([expect.objectContaining({ dnsStatus: 'pending' })]);
    expect(tenant.rows(mailAccounts)).toEqual([]);
    expect(master.rows(mailAccountRegistry)).toEqual([]);
  });

  it('keeps the domain pending when Cloudflare is not configured', async () => {
    provision.fn.mockResolvedValue(false);
    const tenant = fakeDb();

    const result = await ensureWorkspaceMail(env, input(tenant, fakeDb()));

    expect(result.provisioned).toBe(false);
    expect(tenant.rows(mailDomains)).toEqual([expect.objectContaining({ dnsStatus: 'pending' })]);
  });

  it('re-provisions and verifies a pending domain whose team@ mailbox already exists', async () => {
    provision.fn.mockResolvedValue(true);
    const tenant = fakeDb();
    tenant.rows(mailDomains).push({ id: 'mdom_1', domainName: 'acme.weldmail.org', dnsStatus: 'pending' });
    tenant.rows(mailAccounts).push({ id: 'mail_1', email: 'team@acme.weldmail.org' });

    const result = await ensureWorkspaceMail(env, input(tenant, fakeDb()));

    expect(provision.fn).toHaveBeenCalledWith(env, expect.anything(), 'ws_1', 'acme');
    expect(result).toMatchObject({ accountCreated: false, accountId: 'mail_1', domainId: 'mdom_1' });
    expect(tenant.rows(mailDomains)[0]).toMatchObject({ dnsStatus: 'verified' });
    expect(tenant.rows(mailAccounts)).toHaveLength(1);
  });

  it('bumps the mailbox directory version when it creates the team@ account and its labels', async () => {
    provision.fn.mockResolvedValue(true);
    const kv = fakeKv();

    await ensureWorkspaceMail(envWithKv(kv), input(fakeDb(), fakeDb()));

    expect(kv.store.get(mailboxDirectoryVersionKey('ws_1'))).toEqual(expect.any(String));
  });

  it('does not bump the mailbox directory when the team@ account already exists', async () => {
    provision.fn.mockResolvedValue(true);
    const kv = fakeKv();
    const tenant = fakeDb();
    tenant.rows(mailDomains).push({ id: 'mdom_1', domainName: 'acme.weldmail.org', dnsStatus: 'pending' });
    tenant.rows(mailAccounts).push({ id: 'mail_1', email: 'team@acme.weldmail.org' });

    await ensureWorkspaceMail(envWithKv(kv), input(tenant, fakeDb()));

    expect(kv.store.has(mailboxDirectoryVersionKey('ws_1'))).toBe(false);
  });

  it('never throws when WORKSPACE_CACHE is missing from the environment', async () => {
    provision.fn.mockResolvedValue(true);

    await expect(
      ensureWorkspaceMail({ WELDMAIL_DOMAIN: 'weldmail.org' } as unknown as Env, input(fakeDb(), fakeDb())),
    ).resolves.toMatchObject({ accountCreated: true });
  });
});
