/**
 * Internal (service-binding) routes, mounted only on the `MergeInternal`
 * entrypoint (src/index.ts): trusted by topology, no Clerk and no secret. They
 * are not part of the public app.
 *
 *   POST /github-event    -> one forwarded GitHub webhook (integration-webhook-worker has verified its HMAC
 *                            and resolved the workspace). Also what `MergeInternal.githubEvent()` calls.
 *   POST /provider-event  -> one forwarded GitLab / Bitbucket / Azure DevOps webhook (provider-event.ts, area B)
 *   POST /workflow-action -> a WeldConnect merge.* action (workflow-action.ts, area E)
 *   POST /agent-tool      -> a WeldAgent WeldMerge tool call (agent.ts, area E)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { error, success } from '@weldsuite/worker-kit/response';
import { getWorkspaceContextForOrg, type Database } from '@weldsuite/worker-kit/db';
import { mergeGithubEventEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { githubClientFor, githubFailure, hookContext } from '../shared';
import agentRoutes from './agent';
import providerEventRoutes from './provider-event';
import workflowActionRoutes from './workflow-action';
import { publishEntityEvents } from '../../services/events';
import { handleGithubEvent } from '../../services/github-events';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/github-event', zValidator('json', mergeGithubEventEnvelopeSchema), async (c) => {
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
  // Moves made by the sync are the system's, not a member's.
  c.set('userId', 'system');

  try {
    const result = await handleGithubEvent(db, envelope, githubClientFor(c), hookContext(c));
    publishEntityEvents(c, result.events, 'system');
    return success(c, { outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
  } catch (err) {
    // GitHub failing is the caller's to log (it answers GitHub's webhook either way).
    const response = githubFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.route('/', providerEventRoutes);
app.route('/', workflowActionRoutes);
app.route('/', agentRoutes);

export default app;
