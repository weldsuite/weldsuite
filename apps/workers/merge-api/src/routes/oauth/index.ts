/**
 * OAuth callback: /api/merge/oauth/callback.
 *
 *   POST /callback {code, state} -> { purpose, provider, returnTo, connectionId, accountId, organizations? }
 *
 * The SPA page `/weldmerge/oauth/callback` posts what the provider redirected
 * back with. Clerk-authenticated; the state's user and workspace must match
 * the caller, and a workspace connection also needs merge_connections:manage
 * (a member account link needs only merge_pull_requests:read). A new or renewed
 * connection publishes merge_connection created / updated; a member account
 * link is per-member UI state and publishes nothing. Never returns a token.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { mergeOauthCallbackSchema } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env, Variables } from '../../types';
import { providerFailure, unprocessable } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { completeOAuth } from '../../services/oauth/callback';
import { connectionEventData } from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/callback', requirePermission('merge_pull_requests:read'), zValidator('json', mergeOauthCallbackSchema), async (c) => {
  const input = c.req.valid('json');
  try {
    const outcome = await completeOAuth(c.get('tenantDb'), c.env, {
      code: input.code,
      state: input.state,
      userId: c.get('userId'),
      workspaceId: c.get('workspaceId'),
      canConnect: await hasContextPermission(c, 'merge_connections:manage'),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'invalid_state':
          return c.json({ error: { code: 'invalid_state', message: 'This sign-in link expired or was already used: start again' } }, 400);
        case 'state_mismatch':
        case 'forbidden':
          return error.forbidden(c, 'This sign-in was not started by you in this workspace');
        case 'login_taken':
          return error.conflict(c, 'This provider account is already linked to another member');
        case 'no_organizations':
          return unprocessable(c, 'This Azure DevOps account does not belong to any organisation');
      }
    }
    if (outcome.connection) {
      publishEntityEvents(c, [
        {
          entityType: 'merge_connection',
          action: outcome.created ? 'created' : 'updated',
          entityId: outcome.connection.id,
          data: connectionEventData(outcome.connection),
        },
      ]);
    }
    return success(c, outcome.result);
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
