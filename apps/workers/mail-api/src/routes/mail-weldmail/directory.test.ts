/**
 * Route-level tests for the directory bump + mailbox teardown wiring added
 * to `/api/mail-weldmail` (design doc §6, §9 task D3): a reserved address is
 * a `mail_accounts` row like any other, so creating or releasing one must
 * bump the directory exactly like `mail-accounts` does, and releasing must
 * tear the mailbox object down in object modes.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, permissions, createMockDb } from '@weldsuite/worker-kit/testing';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { Env, Variables } from '../../types';

/** See `routes/mail-accounts/directory.test.ts` for why this is a local structural type rather than an `@weldsuite/feature-flags/server` import. */
interface FakeFlagshipBinding {
  getStringValue(key: string, defaultValue: string, context?: Record<string, unknown>): Promise<string>;
  getBooleanValue(key: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean>;
  getNumberValue(key: string, defaultValue: number, context?: Record<string, unknown>): Promise<number>;
  getObjectValue<T>(key: string, defaultValue: T, context?: Record<string, unknown>): Promise<T>;
}

vi.mock('../../services/mail/weldmail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mail/weldmail')>();
  return {
    ...actual,
    reserveAddress: vi.fn(),
    releaseAddress: vi.fn(),
  };
});

import { mailWeldMailRoutes } from './index';
import * as weldmailService from '../../services/mail/weldmail';

function fakeKv() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'put'; key: string }> = [];
  const kv = {
    get: async (key: string, type?: string) => {
      calls.push({ op: 'get', key });
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      calls.push({ op: 'put', key });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, calls };
}

function fakeFlagship(mode: string): FakeFlagshipBinding {
  return {
    getStringValue: async () => mode,
    getBooleanValue: async (_key, defaultValue) => defaultValue,
    getNumberValue: async (_key, defaultValue) => defaultValue,
    getObjectValue: async (_key, defaultValue) => defaultValue,
  };
}

function fakeMailboxNamespace(destroy: Mock) {
  const stub = { destroy };
  return { jurisdiction: () => ({ idFromName: (n: string) => n, get: () => stub }) } as unknown as Env['MAILBOX_STORE'];
}

function fakeMailIndexNamespace(dropMailbox: Mock) {
  const stub = { dropMailbox };
  return { jurisdiction: () => ({ idFromName: (n: string) => n, get: () => stub }) } as unknown as Env['MAIL_INDEX'];
}

function makeApp(workspaceId: string, envOverrides: Partial<Env> = {}) {
  return createTestApp<Env, Variables>('/api/mail-weldmail', mailWeldMailRoutes, {
    context: { userId: 'user_admin', tenantDb: createMockDb(), workspaceId, permissions: permissions('*') },
    env: envOverrides,
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetMailStoreModeCacheForTests();
});

describe('POST /api/mail-weldmail/reserve', () => {
  it('bumps the directory after reserving an address', async () => {
    (weldmailService.reserveAddress as Mock).mockResolvedValue({
      id: 'mail_1',
      email: 'hello@acme.weldmail.com',
      name: 'hello',
      displayName: 'hello',
      isDefault: true,
    });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_weldmail_reserve', { WORKSPACE_CACHE: kv });

    const res = await request('/api/mail-weldmail/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'hello' }),
    });
    expect(res.status).toBe(201);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_weldmail_reserve')).toBe(true);
  });
});

describe('DELETE /api/mail-weldmail/:id (release)', () => {
  it('bumps the directory after releasing an address', async () => {
    (weldmailService.releaseAddress as Mock).mockResolvedValue({ id: 'mail_1', email: 'hello@acme.weldmail.com' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_weldmail_release', { WORKSPACE_CACHE: kv });

    const res = await request('/api/mail-weldmail/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_weldmail_release')).toBe(true);
  });

  it('destroys the mailbox object and drops it from the MailIndex in object modes', async () => {
    (weldmailService.releaseAddress as Mock).mockResolvedValue({ id: 'mail_1', email: 'hello@acme.weldmail.com' });
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const { kv } = fakeKv();
    const { request } = makeApp('ws_weldmail_destroy', {
      FLAGSHIP: fakeFlagship('object'),
      WORKSPACE_CACHE: kv,
      MAILBOX_STORE: fakeMailboxNamespace(destroy),
      MAIL_INDEX: fakeMailIndexNamespace(dropMailbox),
    });

    const res = await request('/api/mail-weldmail/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    await flush();

    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_weldmail_destroy', accountId: 'mail_1' }));
    expect(dropMailbox).toHaveBeenCalledWith('ws_weldmail_destroy', 'mail_1');
  });

  it('does not touch the mailbox object or the MailIndex in postgres mode', async () => {
    (weldmailService.releaseAddress as Mock).mockResolvedValue({ id: 'mail_1', email: 'hello@acme.weldmail.com' });
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const { kv } = fakeKv();
    const { request } = makeApp('ws_weldmail_no_destroy', {
      WORKSPACE_CACHE: kv,
      MAILBOX_STORE: fakeMailboxNamespace(destroy),
      MAIL_INDEX: fakeMailIndexNamespace(dropMailbox),
    });

    const res = await request('/api/mail-weldmail/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    await flush();

    expect(destroy).not.toHaveBeenCalled();
    expect(dropMailbox).not.toHaveBeenCalled();
  });
});
