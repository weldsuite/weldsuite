/**
 * GitLab, Bitbucket Cloud and Azure DevOps webhook receiver:
 * POST /webhooks/merge/:provider/:key (public, no Clerk).
 *
 * `key` is a repository's random `webhook_key` (WeldMerge registered the hook
 * with it). The handler (area B) resolves it to a workspace through the master
 * `merge_provider_index` (KV-cached `merge-hook:<provider>:<key>`), and forwards
 * `{workspaceId, provider, key, headers (allow-listed), body (raw text)}` to
 * merge-api's `MergeInternal.providerEvent`, which verifies the signature with
 * the repository's stored secret. An unknown key is a 404 so a probe learns
 * nothing; a provider that is not one of `MERGE_WEBHOOK_PROVIDERS` is a 404.
 *
 * Foundation stub: answers 202 until the handler is built.
 */

import { Hono } from 'hono';
import { MERGE_WEBHOOK_PROVIDERS } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../index';

const app = new Hono<{ Bindings: Env }>();

app.post('/merge/:provider/:key', async (c) => {
  const provider = c.req.param('provider');
  if (!(MERGE_WEBHOOK_PROVIDERS as readonly string[]).includes(provider)) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  return c.json({ received: true }, 202);
});

export { app as mergeProviderWebhookRoutes };
