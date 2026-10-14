/**
 * Outreach mailboxes: /v1/reach/mailboxes
 *
 * Scope: reach_mailboxes:read. Read only: every mailbox is billed, so creating,
 * changing, pausing and deleting one stays in the WeldReach app. The same domain
 * reads as reach-api's `/api/reach/mailboxes`, with the warmup numbers of the
 * master pool. A response never carries the mailbox logins (the domain leaves
 * them out) or the mail provider's ids (`withoutMailpool`).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { reachMailboxStatusSchema } from '@weldsuite/app-api-client/schemas/reach';
import { getMailboxDto, listMailboxes } from '@weldsuite/reach-domain/mailboxes';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, error, list, success } from '../../../lib/response';
import { reachMailboxReads, reachValidation, withoutMailpool } from '../../../lib/reach';

const listQuerySchema = z.object({
  domainId: z.string().min(1).max(30).optional(),
  status: reachMailboxStatusSchema.optional(),
});

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_mailboxes:read'), zValidator('query', listQuerySchema, reachValidation), async (c) => {
  const mailboxes = (await listMailboxes(reachMailboxReads(c), c.req.valid('query'))).map(withoutMailpool);
  return list(c, mailboxes, cursorPagination(mailboxes.length, false, null));
});

app.get('/:id', requireScope('reach_mailboxes:read'), async (c) => {
  const id = c.req.param('id');
  const mailbox = await getMailboxDto(reachMailboxReads(c), id);
  if (!mailbox) return error.notFound(c, 'Mailbox', id);
  return success(c, withoutMailpool(mailbox));
});

export default app;
