/**
 * GitHub App install flow: /api/merge/connections/github/install-url.
 *
 *   GET /github/install-url?returnTo=  -> { url }: the App's install page, with a signed state
 *                                          (HS256 JWT, 600 s: workspaceId, userId, returnTo, nonce)
 *
 * Permission: merge_connections:manage. `returnTo` must be a same-app relative
 * path (`/…`), else it is ignored. GitHub sends the browser back to the public
 * setup route (routes/public/github-setup.ts), which records the installation.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { installStateNonce, signInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';
import { mergeGithubInstallUrlQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { githubInstallPage, sameAppPath } from '../../services/github-install';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/github/install-url', requirePermission('merge_connections:manage'), zValidator('query', mergeGithubInstallUrlQuerySchema), async (c) => {
  const slug = c.env.GITHUB_APP_SLUG;
  if (!slug) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'GitHub is not configured for WeldMerge' } }, 503);
  const state = await signInstallStateJwt(
    {
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
      returnTo: sameAppPath(c.req.valid('query').returnTo),
      nonce: installStateNonce(),
    },
    c.env.CLERK_SECRET_KEY,
  );
  return success(c, { url: githubInstallPage(slug, state) });
});

export default app;
