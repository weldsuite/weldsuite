/**
 * The reply inbox, read side: /v1/reach/threads
 *
 * Scope: reach_inbox:read.
 *
 *   GET /v1/reach/threads             threads (the latest reply of each), filters + cursor;
 *                                     `meta.unreadCount` is the inbox-wide unread count
 *   GET /v1/reach/threads/:threadKey  every message of a thread, reply text from R2
 *
 * Replies arrive through reach-api's `email()` handler; this file only reads
 * what it stored (`@weldsuite/reach-domain/inbox`, as reach-api's
 * `/api/reach/inbox` does). Answering a thread is `thread-reply.ts`; labelling,
 * read / handled state and the CRM hand-off are app-only.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { reachInboxFilterSchema } from '@weldsuite/app-api-client/schemas/reach';
import { countUnreadThreads, getThread, listThreads } from '@weldsuite/reach-domain/inbox';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, error, success } from '../../../lib/response';
import { reachInboxStorage, reachValidation } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_inbox:read'), zValidator('query', reachInboxFilterSchema, reachValidation), async (c) => {
  const db = c.get('tenantDb');
  const [page, unreadCount] = await Promise.all([listThreads(db, c.req.valid('query')), countUnreadThreads(db)]);
  return c.json({
    data: page.threads,
    pagination: cursorPagination(page.totalCount, page.hasMore, page.cursor),
    meta: { unreadCount },
  });
});

app.get('/:threadKey', requireScope('reach_inbox:read'), async (c) => {
  const threadKey = c.req.param('threadKey');
  const thread = await getThread(c.get('tenantDb'), reachInboxStorage(c), threadKey);
  if (!thread) return error.notFound(c, 'Thread', threadKey);
  return success(c, { threadKey, summary: thread.summary, messages: thread.messages });
});

export default app;
