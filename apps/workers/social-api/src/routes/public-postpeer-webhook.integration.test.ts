/**
 * POST /public/social/postpeer/webhook on pglite: the signature check, the
 * payloads it acknowledges without work, and reconciling a post found
 * through the master index (or the legacy KV mapping): its status, its
 * per-platform results, and the refund of platforms that just failed.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  };
});

import { postpeerWebhookRoutes } from './public-postpeer-webhook';

const SECRET = 'whsec-test';
const WORKSPACE_ID = 'ws_test_default';
const ORG_ID = 'org_test_default';
const BASE = '/public/social/postpeer';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = createMemoryKv();

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function deliver(body: string, signature: string | null = sign(body), env: Record<string, unknown> = {}) {
  const { request } = createTestApp(BASE, postpeerWebhookRoutes, {
    context: { tenantDb: db, masterDb: master, orgId: null, clerkOrgId: null },
    env: { POSTPEER_WEBHOOK_SECRET: SECRET, POSTPEER_API_KEY: 'pp-key', WORKSPACE_CACHE: kv, ...env } as never,
  });
  return request(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'x-postpeer-signature': signature }) },
    body,
  });
}

async function post(id: string) {
  const [row] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, id));
  return row!;
}

async function seedPost(id: string, values: Partial<typeof schema.socialPosts.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(schema.socialPosts).values({
    id,
    content: id,
    status: 'scheduled',
    targetAccountIds: ['sac_w_tw', 'sac_w_li'],
    platformContent: [
      { platform: 'twitter', accountId: 'sac_w_tw', status: 'pending' },
      { platform: 'linkedin', accountId: 'sac_w_li', status: 'pending' },
    ],
    createdByUserId: 'u',
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: WORKSPACE_ID, clerkOrgId: ORG_ID, name: 'Hook', slug: 'hook' } as typeof masterSchema.workspaces.$inferInsert);
  const now = new Date();
  await master.insert(masterSchema.workspaceCredits).values({
    id: 'wcr_hook',
    workspaceId: WORKSPACE_ID,
    currentBalance: 10,
    periodStart: now,
    periodEnd: now,
  });
  await master.insert(masterSchema.postpeerPostIndex).values([
    { postpeerPostId: 'pp_w_ok', clerkOrgId: ORG_ID, socialPostId: 'spo_w_ok' },
    { postpeerPostId: 'pp_w_fail', clerkOrgId: ORG_ID, socialPostId: 'spo_w_fail' },
    { postpeerPostId: 'pp_w_deleted', clerkOrgId: ORG_ID, socialPostId: 'spo_w_deleted' },
  ]);
  await kv.put('pp:post:pp_w_legacy', JSON.stringify({ orgId: ORG_ID, postId: 'spo_w_legacy' }));
}, 180_000);

describe('POST /public/social/postpeer/webhook', () => {
  it('refuses a delivery without a valid signature, or with no secret set', async () => {
    const body = JSON.stringify({ postId: 'pp_w_ok' });
    for (const res of [
      await deliver(body, null),
      await deliver(body, sign(body, 'wrong')),
      await deliver(body, 'short'),
      await deliver(body, sign(body), { POSTPEER_WEBHOOK_SECRET: undefined }),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
    }
  });

  it('acknowledges what it can’t reconcile', async () => {
    const notJson = await deliver('not json');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } });
    expect(await (await deliver('{"event":"post.published"}')).json()).toEqual({ ok: true, ignored: 'no_post_id' });
    const unknown = JSON.stringify({ data: { postId: 'pp_w_unknown' } });
    expect(await (await deliver(unknown, `sha256=${sign(unknown).toUpperCase()}`)).json()).toEqual({
      ok: true,
      ignored: 'unknown_post',
    });
  });

  it('publishes a post once every platform reports success', async () => {
    await seedPost('spo_w_ok');
    const body = JSON.stringify({
      event: 'post.published',
      data: {
        postId: 'pp_w_ok',
        platforms: [
          { platform: 'twitter', accountId: 'sac_w_tw', success: true, platformPostUrl: 'https://x.test/1' },
          { platform: 'linkedin', success: true },
        ],
      },
    });
    const res = await deliver(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reconciled: true });
    const row = await post('spo_w_ok');
    expect(row.status).toBe('published');
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.platformContent).toEqual([
      expect.objectContaining({ platform: 'twitter', status: 'published', publishedUrl: 'https://x.test/1' }),
      expect.objectContaining({ platform: 'linkedin', status: 'published' }),
    ]);
  });

  it('marks a failed delivery and refunds each platform that just failed', async () => {
    await seedPost('spo_w_fail', { creditsConsumed: 4, creditTransactionId: 'ctx_hook' });
    const body = JSON.stringify({
      postId: 'pp_w_fail',
      platforms: [
        { platform: 'twitter', accountId: 'sac_w_tw', success: false, error: 'Rate limited' },
        { platform: 'linkedin', accountId: 'sac_w_li', success: false },
      ],
    });
    expect(await (await deliver(body)).json()).toEqual({ ok: true, reconciled: true });
    expect(await post('spo_w_fail')).toMatchObject({ status: 'failed', lastPublishError: 'Rate limited', creditsConsumed: 0 });
    const [wallet] = await master
      .select()
      .from(masterSchema.workspaceCredits)
      .where(eq(masterSchema.workspaceCredits.workspaceId, WORKSPACE_ID));
    expect(wallet.currentBalance).toBe(14);
    // A replay refunds nothing more.
    expect(await (await deliver(body)).json()).toEqual({ ok: true, reconciled: true });
    expect(await post('spo_w_fail')).toMatchObject({ creditsConsumed: 0 });
  });

  it('reconciles a post only the legacy KV mapping knows', async () => {
    await seedPost('spo_w_legacy');
    const body = JSON.stringify({ event: 'post.failed', data: { postId: 'pp_w_legacy', platforms: [] } });
    expect(await (await deliver(body)).json()).toEqual({ ok: true, reconciled: true });
    expect((await post('spo_w_legacy')).status).toBe('failed');
  });

  it('reports a deleted post as not reconciled', async () => {
    await seedPost('spo_w_deleted', { deletedAt: new Date() });
    const body = JSON.stringify({ postId: 'pp_w_deleted', status: 'published' });
    expect(await (await deliver(body)).json()).toEqual({ ok: true, reconciled: false });
  });
});
