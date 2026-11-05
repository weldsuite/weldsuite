/**
 * The member's own provider logins: /api/merge/accounts/me.
 *
 *   GET /me -> { github }
 *   PUT /me -> set (or, empty, remove) the GitHub login; 409 when another member holds it
 *
 * Permission: merge_pull_requests:read. A member edits only their own logins.
 * There is no entity event: a login is not a catalogued entity.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { updateMyMergeAccountsSchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { getGithubLogin, setGithubLogin } from '../../services/accounts';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/me', requirePermission('merge_pull_requests:read'), async (c) => {
  return success(c, { github: await getGithubLogin(c.get('tenantDb'), c.get('userId')) });
});

app.put('/me', requirePermission('merge_pull_requests:read'), zValidator('json', updateMyMergeAccountsSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const input = c.req.valid('json');
  if (input.github === undefined) return success(c, { github: await getGithubLogin(db, userId) });
  const result = await setGithubLogin(db, userId, input.github);
  if (!result.ok) return error.conflict(c, 'This GitHub username is already linked to another member');
  return success(c, { github: result.login });
});

export default app;
