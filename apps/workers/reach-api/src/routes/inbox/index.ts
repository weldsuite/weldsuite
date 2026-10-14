/**
 * /api/reach/inbox: the unified reply inbox.
 *
 *   reach_inbox:read    GET /                          threads (latest reply per thread), filters + cursor
 *                       GET /unread-count              threads with an unread latest reply
 *                       GET /threads/:threadKey        every message of a thread, reply text from R2
 *   reach_inbox:reply   POST /threads/:threadKey/reply answer from the mailbox that got the reply
 *   reach_inbox:update  PATCH /messages/:id            label, read, handled
 *                       POST /threads/:threadKey/add-to-crm   person + company (+ opportunity)
 *
 * Replies arrive through the `email()` handler (src/email/handler.ts); this
 * file only reads and acts on what it stored. The reads and the reply are in
 * `@weldsuite/reach-domain/inbox`, shared with the public API. Handing a thread
 * to the CRM goes through the inbox permission on purpose: the request carries
 * a WeldReach app context, in which WeldCRM permission keys are not evaluated.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import {
  reachAddToCrmSchema,
  reachInboxFilterSchema,
  reachReplySchema,
  updateReachMessageSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  countUnreadThreads,
  getThread,
  listThreads,
  loadThread,
  sendReply,
  toMessageDto,
} from '@weldsuite/reach-domain/inbox';
import type { Env, Variables } from '../../types';
import { CrmHandoffError, addThreadToCrm } from '../../services/crm-handoff';
import { updateMessage } from '../../services/inbox';
import { reachErrorHandler } from '../../services/reach-errors';
import { replyEventData, type EntitySink } from '../../services/realtime';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

type InboxContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Entity events from a request: `publishEntityEvent` with the request's workspace and user. */
function requestSink(c: InboxContext): EntitySink {
  return (event) => {
    publishEntityEvent({
      c,
      entityType: event.entityType,
      action: event.action,
      entityId: event.entityId,
      data: event.data,
      changes: event.changes ?? undefined,
    });
  };
}

app.get('/', requirePermission('reach_inbox:read'), zValidator('query', reachInboxFilterSchema), async (c) => {
  const page = await listThreads(c.get('tenantDb'), c.req.valid('query'));
  return list(c, page.threads, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/unread-count', requirePermission('reach_inbox:read'), async (c) => {
  return success(c, { count: await countUnreadThreads(c.get('tenantDb')) });
});

app.get('/threads/:threadKey', requirePermission('reach_inbox:read'), async (c) => {
  const threadKey = c.req.param('threadKey');
  const thread = await getThread(c.get('tenantDb'), c.env, threadKey);
  if (!thread) return error.notFound(c, 'Thread', threadKey);
  return success(c, { threadKey, summary: thread.summary, messages: thread.messages });
});

app.post('/threads/:threadKey/reply', requirePermission('reach_inbox:reply'), zValidator('json', reachReplySchema), async (c) => {
  const message = await sendReply(
    {
      env: c.env,
      db: c.get('tenantDb'),
      access: c.get('appAccess'),
      // Global kill switch (Flagship `weldreach-sending`, default on): off means no SMTP anywhere.
      sendingEnabled: async () => (await c.get('flags')?.isOn('weldreach-sending')) ?? true,
    },
    { threadKey: c.req.param('threadKey'), body: c.req.valid('json').body, userId: c.get('userId') },
  );
  return success(c, message, 201);
});

app.patch('/messages/:id', requirePermission('reach_inbox:update'), zValidator('json', updateReachMessageSchema), async (c) => {
  const id = c.req.param('id');
  const update = await updateMessage(c.get('tenantDb'), id, c.req.valid('json'), c.get('userId'));
  if (!update) return error.notFound(c, 'Message', id);

  // A person's label is a classification like the model's, so the same event announces it.
  if (update.labelChange) {
    publishEntityEvent({
      c,
      entityType: 'reach_reply',
      action: 'classified',
      entityId: update.message.id,
      data: replyEventData(update.message, { label: update.labelChange.next, labelSource: 'user' }),
      changes: update.labelChange.previous ? { label: { old: update.labelChange.previous, new: update.labelChange.next } } : undefined,
    });
  }
  return success(c, toMessageDto(update.message, update.message.snippet));
});

app.post('/threads/:threadKey/add-to-crm', requirePermission('reach_inbox:update'), zValidator('json', reachAddToCrmSchema), async (c) => {
  const db = c.get('tenantDb');
  const threadKey = c.req.param('threadKey');
  const thread = await loadThread(db, threadKey);
  if (!thread) return error.notFound(c, 'Thread', threadKey);

  try {
    const result = await addThreadToCrm(
      { db, sink: requestSink(c), actingUserId: c.get('userId') },
      {
        prospect: thread.prospect,
        senderEmail: thread.latestInbound.fromEmail,
        campaign: thread.campaign,
        opportunity: c.req.valid('json').opportunity,
      },
    );
    return success(c, { personId: result.personId, opportunityId: result.opportunityId });
  } catch (err) {
    if (err instanceof CrmHandoffError) return error.badRequest(c, err.message, { reason: err.code });
    throw err;
  }
});

export default app;
