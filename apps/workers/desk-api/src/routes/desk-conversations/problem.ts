/**
 * WeldDesk problem management on an incident, /api/desk/conversations/:id/problem:
 * which problem a conversation is linked to, and linking, replacing or
 * unlinking it. The rules are in @weldsuite/db/lib/desk-problems; each change
 * is published like the linked-ticket routes publish theirs. Mounted next to
 * the inbox routes in src/index.ts. Permissions: conversations:read |
 * conversations:update.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { setDeskConversationProblemSchema } from '@weldsuite/core-api-client/schemas/desk-problems';
import { DeskConversationNotFoundError } from '@weldsuite/db/lib/desk';
import {
  DeskProblemNotFoundError,
  DeskProblemRejectedError,
  getDeskConversationProblem,
  setDeskConversationProblem,
} from '@weldsuite/db/lib/desk-problems';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { publishDeskLinkChanges } from './links';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function refusal(c: Ctx, err: unknown, failure: string) {
  if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', err.conversationId);
  if (err instanceof DeskProblemNotFoundError) return error.notFound(c, 'Problem', err.problemId);
  if (err instanceof DeskProblemRejectedError) return error.conflict(c, err.message, { reason: err.reason });
  console.error(`[desk-api/desk-conversations] ${failure}:`, err);
  return error.internal(c, failure);
}

app.get('/:id/problem', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [conversation] = await db
      .select({ id: schema.deskConversations.id })
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, id))
      .limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', id);
    return success(c, await getDeskConversationProblem(db, id));
  } catch (err) {
    return refusal(c, err, 'Failed to load the problem');
  }
});

/** Link the conversation to a problem, replace it, or unlink it (`problemId: null`). */
app.put('/:id/problem', requirePermission('conversations:update'), zValidator('json', setDeskConversationProblemSchema), async (c) => {
  const id = c.req.param('id');
  const { problemId } = c.req.valid('json');
  try {
    const result = await setDeskConversationProblem(c.get('tenantDb'), {
      generateId,
      authorId: c.get('userId'),
      conversationId: id,
      problemId,
    });
    await publishDeskLinkChanges(c, result.changes);
    return success(c, {
      conversation: result.conversation,
      problem: result.problem,
      messages: result.changes.map((change) => change.message),
    });
  } catch (err) {
    return refusal(c, err, 'Failed to link the problem');
  }
});

export { app as deskConversationProblemRoutes };
