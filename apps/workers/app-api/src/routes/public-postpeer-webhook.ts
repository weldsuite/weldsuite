/**
 * PostPeer delivery webhook — PUBLIC route.
 *
 * POST /public/social/postpeer/webhook
 *
 * Mounted BEFORE Clerk auth (PostPeer's server-to-server delivery has no Clerk
 * session). The post is matched to a workspace via the KV mapping recorded when
 * the post was created (`pp:post:<postpeerPostId>` → { orgId, postId }), then
 * the tenant DB is resolved and the post status reconciled.
 *
 * Authenticity is enforced by HMAC signature verification against
 * POSTPEER_WEBHOOK_SECRET (skipped with a warning when unset, dev only).
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { verifyPostPeerSignature } from '../lib/postpeer';
import {
  resolvePostpeerPost,
  reconcileFromWebhook,
  type PostPeerWebhookPayload,
} from '../services/social-publishing';
import { getTenantDbForWorkspace } from '../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/webhook', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header('x-postpeer-signature') ?? null;

  const valid = await verifyPostPeerSignature(c.env.POSTPEER_WEBHOOK_SECRET, raw, signature);
  if (!valid) {
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } }, 401);
  }

  let payload: PostPeerWebhookPayload;
  try {
    payload = JSON.parse(raw) as PostPeerWebhookPayload;
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const postpeerPostId = payload.data?.postId ?? payload.postId;
  if (!postpeerPostId) {
    // Nothing to reconcile — ack so PostPeer doesn't retry forever.
    return c.json({ ok: true, ignored: 'no_post_id' });
  }

  const mapping = await resolvePostpeerPost(c.env, postpeerPostId);
  if (!mapping) {
    // Unknown post (expired mapping or foreign account) — ack to stop retries.
    return c.json({ ok: true, ignored: 'unknown_post' });
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, mapping.orgId);
    const reconciled = await reconcileFromWebhook(db, c.env, mapping.orgId, mapping.postId, payload);
    return c.json({ ok: true, reconciled });
  } catch (err) {
    console.error('[postpeer-webhook] reconcile failed:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reconcile' } }, 500);
  }
});

export { app as postpeerWebhookRoutes };
