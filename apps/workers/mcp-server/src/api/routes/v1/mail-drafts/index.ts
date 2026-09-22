/**
 * Mail drafts — list, read, create.
 *
 * Mirrors `apps/workers/app-api/src/routes/mail-drafts`. A draft is the
 * deliberate end of the compose path over MCP: the model can write the mail,
 * but it lands in the user's Drafts folder and a human presses send. There is
 * no send endpoint here, and there should not be one.
 *
 * Editing and deleting drafts stay in the UI — an assistant rewriting a draft
 * a user has since edited by hand would lose their work silently.
 *
 * Entity events: `mail_draft:created`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  accessibleAccountIds,
  accountScopeCondition,
  checkAccountAccess,
} from '../../../lib/mail-access';
import { createMailDraftSchema } from '../../../../schemas/mail';

const table = schema.mailDrafts;

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  accountId: z.string().optional(),
});

type DraftRow = typeof table.$inferSelect;

/**
 * Drafts are listed without their body — the same reasoning as mail messages,
 * and a half-written mail reads no better truncated than omitted.
 */
function summariseDraft(row: DraftRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    subject: row.subject ?? '(no subject)',
    to: row.to?.length ? row.to.join(', ') : undefined,
    updatedAt: row.updatedAt,
    isReply: row.isReply ? true : undefined,
    isForward: row.isForward ? true : undefined,
    attachments: row.hasAttachments ? (row.attachmentCount || 1) : undefined,
  };
}

const app = new Hono<HonoEnv>();

app.get('/', requireScope('messages:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const userId = c.get('userId');

  if (q.accountId && !(await checkAccountAccess(db, q.accountId, userId))) {
    return error.notFound(c, 'MailAccount', q.accountId);
  }

  const where: (SQL | undefined)[] = [];
  const scope = accountScopeCondition(table.accountId, await accessibleAccountIds(db, userId));
  if (scope) where.push(scope);
  if (q.accountId) where.push(eq(table.accountId, q.accountId));

  const result = await listWithCursor<typeof table, DraftRow>({
    db,
    table,
    where,
    cursor: q.cursor,
    limit: q.limit,
    mapRow: summariseDraft,
  });
  return list(
    c,
    result.data as Record<string, unknown>[],
    cursorPagination(result.totalCount, result.hasMore, result.cursor),
  );
});

app.get('/:id', requireScope('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'MailDraft', id);
  if (!(await checkAccountAccess(db, row.accountId, c.get('userId')))) {
    return error.forbidden(c, 'Access to this mail account is not allowed');
  }
  return success(c, row);
});

app.post('/', requireScope('messages:write'), zValidator('json', createMailDraftSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');

  if (!(await checkAccountAccess(db, body.accountId, c.get('userId')))) {
    return error.forbidden(c, 'Access to this mail account is not allowed');
  }

  const now = new Date();
  const id = generateId('draft');
  const attachmentIds = body.attachmentIds ?? null;

  const [row] = await db
    .insert(table)
    .values({
      id,
      accountId: body.accountId,
      subject: body.subject ?? null,
      to: body.to ?? null,
      cc: body.cc ?? null,
      bcc: body.bcc ?? null,
      replyTo: body.replyTo ?? null,
      body: body.body ?? null,
      htmlBody: body.htmlBody ?? null,
      importance: body.importance ?? 'normal',
      labels: body.labels ?? null,
      attachmentIds,
      hasAttachments: (attachmentIds?.length ?? 0) > 0,
      attachmentCount: attachmentIds?.length ?? 0,
      inReplyTo: body.inReplyTo ?? null,
      originalMessageId: body.originalMessageId ?? null,
      isReply: body.isReply ?? false,
      isForward: body.isForward ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create draft');

  publishEntityEvent({
    c,
    entityType: 'mail_draft',
    entityId: row.id,
    action: 'created',
    data: { id: row.id, accountId: row.accountId, subject: row.subject ?? null },
  });

  return success(c, row, 201);
});

export default app;
