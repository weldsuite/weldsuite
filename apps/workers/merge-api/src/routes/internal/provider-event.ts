/**
 * POST /provider-event: one forwarded GitLab, Bitbucket or Azure DevOps
 * webhook (integration-webhook-worker resolved the workspace from the master
 * provider index). What `MergeInternal.providerEvent()` calls.
 *
 * Finds the repository by `webhook_key`, verifies the signature with the
 * repository's stored secret (`ignored: bad_signature` otherwise), parses with
 * the provider's adapter and applies through the same PR sync, automation and
 * issue sync code as GitHub (services/provider-events.ts). Contract:
 * schemas/weldmerge-providers.ts. Moves made by the sync are the system's.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { error, success } from '@weldsuite/worker-kit/response';
import { getWorkspaceContextForOrg, type Database } from '@weldsuite/worker-kit/db';
import { mergeProviderEventEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env, Variables } from '../../types';
import { publishEntityEvents } from '../../services/events';
import { handleProviderEvent } from '../../services/provider-events';
import { providerFailure, hookContext } from '../shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/provider-event', zValidator('json', mergeProviderEventEnvelopeSchema), async (c) => {
  const envelope = c.req.valid('json');

  // The entrypoint has no auth middleware: resolve the workspace here, by either of its ids.
  let db = c.get('tenantDb') as Database | undefined;
  if (!db) {
    try {
      const workspace = await getWorkspaceContextForOrg(c.env, envelope.workspaceId);
      if (workspace.suspended) return success(c, { outcome: 'ignored' as const, reason: 'workspace_suspended' });
      db = workspace.db;
      c.set('tenantDb', db);
      c.set('workspaceId', workspace.id);
      c.set('clerkOrgId', workspace.clerkOrgId ?? envelope.workspaceId);
    } catch {
      return error.notFound(c, 'Workspace', envelope.workspaceId);
    }
  }
  c.set('userId', 'system');

  try {
    const result = await handleProviderEvent(db, c.env, envelope, hookContext(c));
    publishEntityEvents(c, result.events, 'system');
    return success(c, { outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
  } catch (err) {
    // The provider failing is the caller's to log (it answers the provider's webhook either way).
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
