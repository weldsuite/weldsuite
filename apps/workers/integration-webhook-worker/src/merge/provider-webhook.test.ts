/**
 * `POST /webhooks/merge/:provider/:key` resolves a repository's webhook key to
 * a workspace through the master provider index (KV-cached) and forwards the
 * raw delivery to WeldMerge (`MERGE_INTERNAL.providerEvent`). TypeScript only:
 * the Rust server's own receiver calls WeldMerge in process (rust/modules/
 * integrations), so this file is not in a conformance suite. What must not
 * regress:
 *   1. The body is forwarded byte for byte (the signature covers it) with only
 *      the allow-listed headers, for the workspace the index names.
 *   2. An unknown key, a provider that is not GitLab/Bitbucket/Azure DevOps and
 *      a key that cannot be one are 404 and forward nothing.
 *   3. merge-api's verdict shows: a refused signature is 401, a repository it no
 *      longer tracks 404 (and the cached key is dropped), an unreachable merge-api
 *      502, a missing binding 503; applied and ignored are 202.
 *   4. A resolved key is cached in KV.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { createWebhookTestApp } from '../test/harness';

const holder = vi.hoisted(() => ({ masterDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
}));

let masterDb: Awaited<ReturnType<typeof createMasterPgliteDb>>['db'];

const KEY = 'k'.repeat(40);
const WORKSPACE = 'ws_alpha';

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
  holder.masterDb = masterDb;
}, 60_000);

beforeEach(async () => {
  await masterDb.delete(masterSchema.mergeProviderIndex);
  await masterDb.insert(masterSchema.mergeProviderIndex).values([
    { id: 'mpi_1', provider: 'gitlab', kind: 'webhook', externalKey: KEY, workspaceId: WORKSPACE },
    { id: 'mpi_2', provider: 'bitbucket', kind: 'webhook', externalKey: KEY, workspaceId: 'ws_beta' },
    { id: 'mpi_3', provider: 'gitlab', kind: 'installation', externalKey: 'inst-key-1', workspaceId: 'ws_gamma' },
  ]);
});

function kvStore() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

type Ack = { outcome: 'applied' | 'ignored'; reason?: string };
const binding = (ack: Ack = { outcome: 'applied' }) => ({ githubEvent: vi.fn(), providerEvent: vi.fn(async () => ack) });

function deliver(
  path: string,
  options: { body?: string; headers?: Record<string, string>; merge?: unknown; kv?: ReturnType<typeof kvStore> } = {},
) {
  const kv = options.kv ?? kvStore();
  const target = createWebhookTestApp({
    masterDb,
    env: { WORKSPACE_CACHE: kv, ...('merge' in options ? { MERGE_INTERNAL: options.merge } : {}) },
  });
  return target.request(path, { method: 'POST', body: options.body ?? '{"object_kind":"merge_request"}', headers: options.headers ?? {} });
}

describe('forwarding', () => {
  it('forwards the raw body and only the allow-listed headers, for the workspace the index names', async () => {
    const merge = binding();
    const body = '{ "object_kind" : "merge_request",\n  "note": "café ✓" }';
    const res = await deliver(`/webhooks/merge/gitlab/${KEY}`, {
      body,
      merge,
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 's3cret',
        'X-Gitlab-Event': 'Merge Request Hook',
        Cookie: 'session=abc',
        'X-Forwarded-For': '10.0.0.1',
        Authorization: 'Basic eDp5',
      },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(merge.providerEvent).toHaveBeenCalledTimes(1);
    expect(merge.providerEvent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      provider: 'gitlab',
      key: KEY,
      headers: {
        'x-gitlab-token': 's3cret',
        'x-gitlab-event': 'Merge Request Hook',
        authorization: 'Basic eDp5',
        'content-type': 'application/json',
      },
      body,
    });
  });

  it('looks the key up per provider: the same key on Bitbucket is another workspace', async () => {
    const merge = binding();
    await deliver(`/webhooks/merge/bitbucket/${KEY}`, { merge, headers: { 'X-Hub-Signature': 'sha256=abc', 'X-Event-Key': 'pullrequest:created' } });
    expect(merge.providerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_beta',
        provider: 'bitbucket',
        headers: expect.objectContaining({ 'x-hub-signature': 'sha256=abc', 'x-event-key': 'pullrequest:created' }),
      }),
    );
  });

  it('caches the resolved key in KV and uses the cache next time', async () => {
    const kv = kvStore();
    const merge = binding();
    await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge, kv });
    expect(kv.entries.get(`merge-hook:gitlab:${KEY}`)).toBe(WORKSPACE);

    await masterDb.delete(masterSchema.mergeProviderIndex);
    const again = await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge, kv });
    expect(again.status).toBe(202);
    expect(merge.providerEvent).toHaveBeenCalledTimes(2);
  });
});

describe('what is not a webhook of ours', () => {
  it.each([
    ['an unknown key', `/webhooks/merge/gitlab/${'z'.repeat(40)}`],
    ['GitHub, which has its own receiver', `/webhooks/merge/github/${KEY}`],
    ['an unknown provider', `/webhooks/merge/svn/${KEY}`],
    ['a key that is too short', '/webhooks/merge/gitlab/abc'],
    ['an installation index row, not a webhook key', '/webhooks/merge/gitlab/inst-key-1'],
  ])('answers 404 for %s and forwards nothing', async (_name, path) => {
    const merge = binding();
    const res = await deliver(path, { merge });
    expect(res.status).toBe(404);
    expect(merge.providerEvent).not.toHaveBeenCalled();
  });

  it('answers 413 for a body over a megabyte', async () => {
    const merge = binding();
    const res = await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge, body: 'x'.repeat(1_000_001) });
    expect(res.status).toBe(413);
    expect(merge.providerEvent).not.toHaveBeenCalled();
  });
});

describe("WeldMerge's verdict", () => {
  it('answers 401 when the signature is refused', async () => {
    const res = await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge: binding({ outcome: 'ignored', reason: 'bad_signature' }) });
    expect(res.status).toBe(401);
  });

  it('answers 404 and forgets the cached key when the repository is gone', async () => {
    const kv = kvStore();
    const res = await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge: binding({ outcome: 'ignored', reason: 'unknown_repository' }), kv });
    expect(res.status).toBe(404);
    expect(kv.entries.has(`merge-hook:gitlab:${KEY}`)).toBe(false);
  });

  it.each([{ outcome: 'applied' }, { outcome: 'ignored', reason: 'stale' }, { outcome: 'ignored', reason: 'pr_sync_off' }] as Ack[])(
    'answers 202 for %j',
    async (ack) => {
      expect((await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge: binding(ack) })).status).toBe(202);
    },
  );

  it('answers 502 when WeldMerge fails, and 503 without the binding', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { githubEvent: vi.fn(), providerEvent: vi.fn(async () => Promise.reject(new Error('merge-api down'))) };
    expect((await deliver(`/webhooks/merge/gitlab/${KEY}`, { merge: failing })).status).toBe(502);
    expect((await deliver(`/webhooks/merge/gitlab/${KEY}`)).status).toBe(503);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
