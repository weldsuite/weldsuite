/**
 * GitHub App install flow: /api/merge/connections/github/install-url.
 *
 *   GET /github/install-url?returnTo=  -> { url }: the App's install page, with a signed state
 *                                          (HS256 JWT, 600 s: workspaceId, userId, returnTo, nonce)
 *
 * Permission: merge_connections:manage. `returnTo` must be a same-app relative
 * path (`/…`), else it is ignored. The state's nonce is kept in KV
 * (`WORKSPACE_CACHE`, `merge_install_nonce:<nonce>`, 600 s), so the state is
 * good for one setup redirect. GitHub sends the browser back to the public
 * setup route (routes/public/github-setup.ts), which records the installation.
 * A worker without the App's slug or the KV namespace answers 503.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { installStateNonce, rememberInstallNonce, signInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';
import { mergeGithubInstallUrlQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { githubInstallPage, sameAppPath } from '../../services/github-install';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/github/install-url', requirePermission('merge_connections:manage'), zValidator('query', mergeGithubInstallUrlQuerySchema), async (c) => {
  const slug = c.env.GITHUB_APP_SLUG;
  const kv = c.env.WORKSPACE_CACHE;
  if (!slug || !kv) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'GitHub is not configured for WeldMerge' } }, 503);
  const nonce = installStateNonce();
  const state = await signInstallStateJwt(
    {
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
      returnTo: sameAppPath(c.req.valid('query').returnTo),
      nonce,
    },
    c.env.CLERK_SECRET_KEY,
  );
  await rememberInstallNonce(kv, nonce, c.get('workspaceId'));
  return success(c, { url: githubInstallPage(slug, state) });
});

export default app;
