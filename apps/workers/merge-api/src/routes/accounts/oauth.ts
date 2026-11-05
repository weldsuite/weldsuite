/**
 * Member account linking: /api/merge/accounts/:provider/*.
 *
 *   GET    /:provider/authorize-url?returnTo=   -> { url }: the provider's consent page (all four providers; GitHub uses the App's user authorization)
 *   POST   /gitlab-token {host, token}          -> link a personal access token (self-managed GitLab); answers the member's accounts
 *   DELETE /:provider?host=                     -> unlink the member's account
 *
 * All need merge_pull_requests:read and act on the caller's own accounts only.
 * An account link is per-member UI state: no entity event. The token is
 * stored sealed and never returned.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { MERGE_PROVIDERS } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeAuthorizeUrlQuerySchema,
  mergeGitlabTokenSchema,
  mergeUnlinkAccountQuerySchema,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env, Variables } from '../../types';
import { providerFailure, unprocessable } from '../shared';
import { listAccounts } from '../../services/accounts';
import { unlinkProviderAccount } from '../../services/oauth/accounts';
import { buildAuthorizeUrl, normalizeGitlabHost } from '../../services/oauth/authorize';
import { linkGitlabWithToken } from '../../services/oauth/gitlab-token';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const isProvider = (value: string): value is (typeof MERGE_PROVIDERS)[number] => (MERGE_PROVIDERS as readonly string[]).includes(value);

app.get('/:provider/authorize-url', requirePermission('merge_pull_requests:read'), zValidator('query', mergeAuthorizeUrlQuerySchema), async (c) => {
  const provider = c.req.param('provider');
  if (!isProvider(provider)) return error.notFound(c, 'Provider', provider);
  const query = c.req.valid('query');
  try {
    const result = await buildAuthorizeUrl(c.env, {
      provider,
      purpose: 'account',
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
      returnTo: query.returnTo,
      host: query.host,
    });
    if (!result.ok) return unprocessable(c, 'Self-managed GitLab links with a personal access token');
    return success(c, { url: result.url });
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.post('/gitlab-token', requirePermission('merge_pull_requests:read'), zValidator('json', mergeGitlabTokenSchema), async (c) => {
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const result = await linkGitlabWithToken(db, c.env, userId, input.host, input.token);
    if (!result.ok) {
      if (result.reason === 'login_taken') return error.conflict(c, 'This GitLab account is already linked to another member');
      return unprocessable(c, result.message);
    }
    return success(c, await listAccounts(db, userId), 201);
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.delete('/:provider', requirePermission('merge_pull_requests:read'), zValidator('query', mergeUnlinkAccountQuerySchema), async (c) => {
  const provider = c.req.param('provider');
  if (!isProvider(provider)) return error.notFound(c, 'Provider', provider);
  let host: string | null = null;
  try {
    if (provider === 'gitlab') host = normalizeGitlabHost(c.req.valid('query').host);
  } catch {
    return error.badRequest(c, 'host must be a URL');
  }
  const removed = await unlinkProviderAccount(c.get('tenantDb'), c.get('userId'), provider, host);
  if (!removed) return error.notFound(c, 'Account', provider);
  return noContent(c);
});

export default app;
