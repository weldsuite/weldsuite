/**
 * Mail accounts — read-only.
 *
 * Every message, thread, label, folder and draft hangs off an `accountId`, so
 * this is where a caller finds the mailboxes it can use. Creating, connecting
 * and configuring mailboxes stays in the WeldMail UI.
 *
 * The shape comes from `@weldsuite/mail-domain/accounts`, which projects the
 * row explicitly: `mail_accounts` holds OAuth tokens, an API key and a password
 * hash, and none of them may ever leave the platform. `canSendViaApi` says
 * whether the public API will send from the account (its address must be on a
 * verified WeldMail domain).
 *
 * Sending (`POST /:id/send`) lives in `mail-sending`, which only the public API
 * mounts.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getPublicMailAccount, listPublicMailAccounts } from '@weldsuite/mail-domain/accounts';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { mailPrincipal } from '../../../lib/mail';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().max(200).optional(),
  status: z.string().max(50).optional(),
});

const app = new Hono<HonoEnv>();

app.get('/', requireScope('mail_accounts:read'), zValidator('query', listQuery), async (c) => {
  const result = await listPublicMailAccounts(c.get('tenantDb'), mailPrincipal(c), c.req.valid('query'));
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('mail_accounts:read'), async (c) => {
  const id = c.req.param('id');
  const account = await getPublicMailAccount(c.get('tenantDb'), mailPrincipal(c), id);
  if (!account) return error.notFound(c, 'MailAccount', id);
  return success(c, account);
});

export default app;
