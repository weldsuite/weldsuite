/**
 * The member's own provider logins: /api/merge/accounts/me.
 *
 *   GET /me -> { github, accounts }  (accounts: every linked account, with verified / host / avatar; never a token)
 *   PUT /me -> set (or, empty, remove) the typed GitHub login; 409 when another member holds it,
 *              409 `account_verified` for a different login while an OAuth-verified link exists (unlink first)
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
import { listAccounts, setGithubLogin } from '../../services/accounts';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const VERIFIED = 'Your GitHub account is linked through GitHub; unlink it before typing a different username';

app.get('/me', requirePermission('merge_pull_requests:read'), async (c) => {
  return success(c, await listAccounts(c.get('tenantDb'), c.get('userId')));
});

app.put('/me', requirePermission('merge_pull_requests:read'), zValidator('json', updateMyMergeAccountsSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const input = c.req.valid('json');
  if (input.github === undefined) return success(c, await listAccounts(db, userId));
  const result = await setGithubLogin(db, userId, input.github);
  if (!result.ok && result.reason === 'account_verified') {
    return c.json({ error: { code: 'account_verified', message: VERIFIED } }, 409);
  }
  if (!result.ok) return error.conflict(c, 'This GitHub username is already linked to another member');
  return success(c, await listAccounts(db, userId));
});

export default app;
