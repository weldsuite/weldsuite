/**
 * Answering a reply: POST /v1/reach/threads/:threadKey/reply
 *
 * Only the public API mounts this file. The MCP server shares the other reach
 * routes but not this one, so an AI agent reads the inbox and a person presses
 * send.
 *
 * Scope: reach_inbox:reply, named only (`*` and `reach_inbox:*` do not grant
 * it: the email goes out under the workspace's name to someone outside it).
 *
 * The same `sendReply` as reach-api's `POST /api/reach/inbox/threads/:key/reply`
 * (`@weldsuite/reach-domain/inbox`), so a reply is refused in the app's order:
 *   403 FORBIDDEN            the workspace may not send (subscription canceled, or past due for more than 7 days)
 *   503 SERVICE_UNAVAILABLE  the global `weldreach-sending` switch is off
 *   404 NOT_FOUND            no thread has this key
 *   409 CONFLICT             `details.reason` NO_REPLY (nothing to answer) or SUPPRESSED (the address is on the list)
 *   502 UPSTREAM_ERROR       the mailbox is not usable or the mail server did not accept the email
 * Success is 201 with the sent message, and the thread's replies are marked
 * read. A reply publishes no entity event, as in the app.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { reachReplySchema } from '@weldsuite/app-api-client/schemas/reach';
import { sendReply } from '@weldsuite/reach-domain/inbox';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { success } from '../../../lib/response';
import { reachReplyDeps, reachValidation } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.post('/:threadKey/reply', requireScope('reach_inbox:reply'), zValidator('json', reachReplySchema, reachValidation), async (c) => {
  const message = await sendReply(reachReplyDeps(c), {
    threadKey: c.req.param('threadKey'),
    body: c.req.valid('json').body,
    userId: c.get('userId'),
  });
  return success(c, message, 201);
});

export default app;
