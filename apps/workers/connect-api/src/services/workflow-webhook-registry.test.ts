/**
 * Tests for the master-DB webhook registry (services/workflow-webhook-registry.ts)
 * against a real pglite-backed master DB — the fix for the DoS-shaped bug
 * where an unknown webhook id used to scan every workspace's tenant DB.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { deregisterWebhookOwner, registerWebhookOwner, resolveWebhookWorkspace, type WebhookRegistryDeps } from './workflow-webhook-registry';

/** Minimal in-memory KV stand-in — get/put is all the registry uses. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
}

let masterDb: MasterDatabase;

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
}, 60_000);

let seq = 0;
const nextWebhookId = () => `wh_t${++seq}`;

describe('resolveWebhookWorkspace', () => {
  it('returns null for an id that was never registered — no tenant-DB scan, just one indexed miss', async () => {
    const deps: WebhookRegistryDeps = { masterDb, kv: fakeKv() };
    expect(await resolveWebhookWorkspace(deps, 'wh_does_not_exist')).toBeNull();
  });

  it('resolves a registered id to its workspace, then serves the hit from KV', async () => {
    const kv = fakeKv();
    const deps: WebhookRegistryDeps = { masterDb, kv };
    const id = nextWebhookId();
    await registerWebhookOwner(deps, id, 'org_abc');

    expect(await resolveWebhookWorkspace(deps, id)).toBe('org_abc');
    // Second call is a pure cache hit (put was only called by register + the
    // first resolve, not by the DB path a second time).
    const putCallsAfterFirstResolve = (kv.put as any).mock.calls.length;
    await resolveWebhookWorkspace(deps, id);
    expect((kv.put as any).mock.calls.length).toBe(putCallsAfterFirstResolve);
  });

  it('caches a miss too, so a repeated bad id does not re-query the DB', async () => {
    const kv = fakeKv();
    const deps: WebhookRegistryDeps = { masterDb, kv };
    const id = 'wh_never_registered';

    expect(await resolveWebhookWorkspace(deps, id)).toBeNull();
    const getSpy = kv.get as any;
    const callsBefore = getSpy.mock.calls.length;
    expect(await resolveWebhookWorkspace(deps, id)).toBeNull();
    // The second call still hits KV (a get), but resolves from the sentinel
    // without needing a DB round trip at all.
    expect(getSpy.mock.calls.length).toBe(callsBefore + 1);
  });

  it('returns null for a soft-deleted registration', async () => {
    const deps: WebhookRegistryDeps = { masterDb, kv: fakeKv() };
    const id = nextWebhookId();
    await registerWebhookOwner(deps, id, 'org_abc');
    await deregisterWebhookOwner(deps, id);

    expect(await resolveWebhookWorkspace(deps, id)).toBeNull();
  });

  it('re-registering a soft-deleted id makes it resolve again (upsert)', async () => {
    const deps: WebhookRegistryDeps = { masterDb, kv: fakeKv() };
    const id = nextWebhookId();
    await registerWebhookOwner(deps, id, 'org_old');
    await deregisterWebhookOwner(deps, id);
    expect(await resolveWebhookWorkspace(deps, id)).toBeNull();

    await registerWebhookOwner(deps, id, 'org_new');
    expect(await resolveWebhookWorkspace(deps, id)).toBe('org_new');
  });

  it('works with no KV binding at all (always falls through to the DB)', async () => {
    const deps: WebhookRegistryDeps = { masterDb, kv: undefined };
    const id = nextWebhookId();
    await registerWebhookOwner(deps, id, 'org_nokv');
    expect(await resolveWebhookWorkspace(deps, id)).toBe('org_nokv');
    expect(await resolveWebhookWorkspace(deps, 'wh_nokv_missing')).toBeNull();
  });
});
