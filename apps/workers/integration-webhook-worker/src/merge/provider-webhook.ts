/**
 * GitLab, Bitbucket Cloud and Azure DevOps webhook receiver:
 * POST /webhooks/merge/:provider/:key (public, no Clerk).
 *
 * `key` is a repository's random `webhook_key` (WeldMerge registered the hook
 * with it). It resolves to a workspace through the master `merge_provider_index`
 * (KV-cached `merge-hook:<provider>:<key>`) and the delivery is forwarded as
 * `{workspaceId, provider, key, headers (allow-listed), body (raw text)}` to
 * merge-api's `MergeInternal.providerEvent`, which verifies the signature with
 * the repository's stored secret and applies the event. Nothing is verified
 * here: the secret lives with the repository, in the tenant database.
 *
 * Answers: an unknown key or a provider that is not one of
 * `MERGE_WEBHOOK_PROVIDERS` is a 404 (a probe learns nothing); a signature
 * merge-api refuses is a 401; a repository merge-api no longer tracks is a 404
 * (so the provider drops the hook); a merge-api that cannot be reached is a
 * 502 (the provider retries); everything else, applied or ignored, is a 202.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  MERGE_PROVIDER_FORWARDED_HEADERS,
  MERGE_WEBHOOK_PROVIDERS,
  type MergeProviderEventAck,
  type MergeWebhookProvider,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { getMasterDb, masterSchema } from '../db';
import type { Env } from '../index';

const app = new Hono<{ Bindings: Env }>();

/** A webhook key is random alphanumerics (WeldMerge makes 40); anything else cannot be one. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;
/** Deliveries are small; a provider sending more is not one of ours. */
const MAX_BODY_BYTES = 1_000_000;
/** How long a resolved key stays in KV. A removed repository's key drops out of the index at once; merge-api then answers `unknown_repository`. */
const CACHE_TTL_SECONDS = 3600;

const notFound = (c: { json: (body: unknown, status: 404) => Response }) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);

const cacheKey = (provider: string, key: string) => `merge-hook:${provider}:${key}`;

/** `workspaces.id` for a webhook key: KV first, then the master index (which fills the cache). */
async function resolveWorkspace(env: Env, provider: MergeWebhookProvider, key: string): Promise<string | null> {
  const cached = await env.WORKSPACE_CACHE.get(cacheKey(provider, key));
  if (cached) return cached;
  const [row] = await getMasterDb(env)
    .select({ workspaceId: masterSchema.mergeProviderIndex.workspaceId })
    .from(masterSchema.mergeProviderIndex)
    .where(
      and(
        eq(masterSchema.mergeProviderIndex.provider, provider),
        eq(masterSchema.mergeProviderIndex.kind, 'webhook'),
        eq(masterSchema.mergeProviderIndex.externalKey, key),
      ),
    )
    .limit(1);
  if (!row) return null;
  await env.WORKSPACE_CACHE.put(cacheKey(provider, key), row.workspaceId, { expirationTtl: CACHE_TTL_SECONDS });
  return row.workspaceId;
}

/** The headers merge-api needs to verify and read the delivery, lower-case. */
function forwardedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of MERGE_PROVIDER_FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

app.post('/merge/:provider/:key', async (c) => {
  const provider = c.req.param('provider') as MergeWebhookProvider;
  const key = c.req.param('key');
  if (!(MERGE_WEBHOOK_PROVIDERS as readonly string[]).includes(provider) || !KEY_SHAPE.test(key)) return notFound(c);

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } }, 413);
  const body = await c.req.text();
  if (body.length > MAX_BODY_BYTES) return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } }, 413);

  let workspaceId: string | null;
  try {
    workspaceId = await resolveWorkspace(c.env, provider, key);
  } catch (err) {
    console.error(`[Merge Webhook] could not resolve a ${provider} webhook key:`, err);
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again' } }, 503);
  }
  if (!workspaceId) return notFound(c);

  if (!c.env.MERGE_INTERNAL?.providerEvent) {
    console.error(`[Merge Webhook] MERGE_INTERNAL binding missing; ${provider} delivery not forwarded`);
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again' } }, 503);
  }

  let ack: MergeProviderEventAck;
  try {
    ack = await c.env.MERGE_INTERNAL.providerEvent({ workspaceId, provider, key, headers: forwardedHeaders(c.req.raw.headers), body });
  } catch (err) {
    console.error(`[Merge Webhook] WeldMerge refused a ${provider} delivery:`, err);
    return c.json({ error: { code: 'BAD_GATEWAY', message: 'Try again' } }, 502);
  }

  if (ack.reason === 'bad_signature') return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  if (ack.reason === 'unknown_repository') {
    // The repository is gone: forget the key so the next delivery looks it up again, and let the provider drop the hook.
    await c.env.WORKSPACE_CACHE.delete(cacheKey(provider, key));
    return notFound(c);
  }
  return c.json({ received: true }, 202);
});

export { app as mergeProviderWebhookRoutes };
