/**
 * `POST /webhooks/github` forwards the pull request, issue and installation events to WeldMerge
 * (MERGE_INTERNAL, merge-api's MergeInternal entrypoint) after the App's HMAC
 * and the workspace lookup, and never lets that change the answer. TypeScript
 * only: the Rust server's own GitHub webhook calls WeldMerge in process
 * (rust/modules/integrations), so this file is not in a conformance suite.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@weldsuite/db/schema';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { createWebhookTestApp } from '../test/harness';
import { forwardToMerge, isForwardedToMerge } from './merge-forward';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, tenantDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenantDb),
}));

type Db = Awaited<ReturnType<typeof createPgliteDb>>['db'];
let tenantDb: Db;
let masterDb: Awaited<ReturnType<typeof createMasterPgliteDb>>['db'];

const SECRET = 'gh-app-webhook-secret';
const ORG = 'org_github';
const INSTALLATION = 4242;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.tenantDb = tenantDb;
  holder.masterDb = masterDb;
}, 60_000);

beforeEach(async () => {
  await tenantDb.delete(schema.mergeConnections);
  const now = new Date('2026-10-01T09:00:00.000Z');
  await tenantDb.insert(schema.mergeConnections).values({
    id: 'mcn_1',
    provider: 'github',
    externalAccountId: String(INSTALLATION),
    appSlug: 'weldsuite',
    accountType: 'organization',
    accountLogin: 'acme',
    status: 'active',
    createdByUserId: 'user_installer',
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signature = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const kv = () => ({
  get: async (key: string) => (key === `gh-install:${INSTALLATION}` ? ORG : null),
  put: async () => {},
  delete: async () => {},
});

function deliver(event: string, payload: Record<string, unknown>, options: { merge?: unknown; secret?: string } = {}) {
  const body = JSON.stringify({ installation: { id: INSTALLATION }, ...payload });
  const target = createWebhookTestApp({
    masterDb,
    tenantDb,
    env: {
      GITHUB_WEBHOOK_SECRET: SECRET,
      DATABASE_ENCRYPTION_KEY: 'conformance-key',
      WORKSPACE_CACHE: kv(),
      ...('merge' in options ? { MERGE_INTERNAL: options.merge } : {}),
    },
  });
  return target.request('/webhooks/github', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': 'delivery-7',
      'X-Hub-Signature-256': signature(body, options.secret),
    },
  });
}

const binding = () => ({ githubEvent: vi.fn(async () => ({ outcome: 'applied' })) });

describe('forward to WeldMerge', () => {
  it.each([
    'pull_request',
    'pull_request_review',
    'check_suite',
    'installation_repositories',
    'issues',
    'issue_comment',
    'installation',
  ])(
    'forwards %s with the workspace, the delivery id and the verified body',
    async (event) => {
      const merge = binding();
      const payload = { action: 'opened', repository: { id: 900 }, pull_request: { number: 1 } };
      const res = await deliver(event, payload, { merge });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ received: true });
      expect(merge.githubEvent).toHaveBeenCalledTimes(1);
      expect(merge.githubEvent).toHaveBeenCalledWith({
        workspaceId: ORG,
        event,
        deliveryId: 'delivery-7',
        payload: { installation: { id: INSTALLATION }, ...payload },
      });
    },
  );

  it.each(['projects_v2_item', 'projects_v2', 'push', 'ping'])('does not forward %s', async (event) => {
    const merge = binding();
    const res = await deliver(event, { action: 'created' }, { merge });
    expect(res.status).toBe(202);
    expect(merge.githubEvent).not.toHaveBeenCalled();
  });

  it('does not forward a delivery with a wrong signature', async () => {
    const merge = binding();
    const res = await deliver('pull_request', { action: 'opened' }, { merge, secret: 'wrong' });
    expect(res.status).toBe(401);
    expect(merge.githubEvent).not.toHaveBeenCalled();
  });

  it('does not forward for an installation no workspace has a connection for', async () => {
    await tenantDb.delete(schema.mergeConnections);
    const merge = binding();
    const res = await deliver('pull_request', { action: 'opened' }, { merge });
    expect(res.status).toBe(202);
    expect(merge.githubEvent).not.toHaveBeenCalled();
  });

  it('still answers 202 when WeldMerge fails, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const merge = { githubEvent: vi.fn(async () => Promise.reject(new Error('merge-api down'))) };
    const res = await deliver('pull_request', { action: 'opened' }, { merge });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(merge.githubEvent).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('WeldMerge refused pull_request'), expect.any(Error));
  });

  it('logs and answers 202 when the binding is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await deliver('pull_request', { action: 'opened' });
    expect(res.status).toBe(202);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MERGE_INTERNAL binding missing'));
  });

  it('leaves the connection handling alone: an installation event still updates the connection, and WeldMerge hears of it', async () => {
    const merge = binding();
    expect((await deliver('installation', { action: 'suspend' }, { merge })).status).toBe(202);
    const [row] = await tenantDb.select().from(schema.mergeConnections);
    expect(row!.status).toBe('suspended');
    expect(merge.githubEvent).toHaveBeenCalledTimes(1);
  });
});

describe('forwardToMerge', () => {
  it('sends a null delivery id for an empty header, and never throws', async () => {
    const merge = binding();
    await forwardToMerge({ MERGE_INTERNAL: merge }, { workspaceId: ORG, event: 'check_suite', deliveryId: '', payload: {} });
    expect(merge.githubEvent).toHaveBeenCalledWith({ workspaceId: ORG, event: 'check_suite', deliveryId: null, payload: {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      forwardToMerge({ MERGE_INTERNAL: { githubEvent: async () => Promise.reject(new Error('x')) } }, { workspaceId: ORG, event: 'check_suite', deliveryId: 'd', payload: {} }),
    ).resolves.toBeUndefined();
  });

  it('knows the seven forwarded events', () => {
    const forwarded = ['pull_request', 'pull_request_review', 'check_suite', 'installation_repositories', 'issues', 'issue_comment', 'installation'];
    expect(forwarded.every(isForwardedToMerge)).toBe(true);
    expect(['projects_v2_item', 'push', 'ping'].some(isForwardedToMerge)).toBe(false);
  });
});
