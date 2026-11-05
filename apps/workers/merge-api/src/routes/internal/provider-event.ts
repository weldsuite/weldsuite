/**
 * POST /provider-event: one forwarded GitLab, Bitbucket or Azure DevOps
 * webhook (integration-webhook-worker resolved the workspace from the master
 * provider index). What `MergeInternal.providerEvent()` calls.
 *
 * Foundation stub (area B): answers `ignored` until the handler is built. It
 * finds the repository by `webhook_key`, verifies the signature with the
 * repository's stored secret (`ignored: bad_signature` otherwise), parses with
 * the provider's adapter and applies through the same PR sync, automation and
 * issue sync code as GitHub. Contract: schemas/weldmerge-providers.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { success } from '@weldsuite/worker-kit/response';
import { mergeProviderEventEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/provider-event', zValidator('json', mergeProviderEventEnvelopeSchema), async (c) => {
  return success(c, { outcome: 'ignored' as const, reason: 'not_implemented' });
});

export default app;
