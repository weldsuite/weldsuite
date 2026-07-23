/**
 * Mail label routes — /api/mail-labels/*.
 *
 * Endpoints mirror the legacy api-worker surface, collapsing the four
 * separate route trees (`mailLabelsRoutes`, `mailAccountLabelsRoutes`,
 * `mailThreadLabelsRoutes`, `mailUnifiedLabelsRoutes`) into a flat
 * `/api/mail-labels/*` namespace consistent with the rest of app-api.
 *
 * - CRUD on the `mail_labels` table (per-account; uniqueness enforced
 *   case-insensitively per account).
 * - Bulk apply/unapply against `mail_messages.labels` (single JSONB
 *   statement instead of the legacy N+1 SELECT/UPDATE loop).
 * - Thread-scoped apply/unapply.
 * - Paginated threads-by-label, optionally restricted to one account
 *   (when `accountId` is supplied) or unified across every account the
 *   caller has access to (omit `accountId`).
 *
 * Entity events: `mail_label:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import {
  applyLabelToThread,
  bulkAddLabelToMessages,
  bulkRemoveLabelFromMessages,
  createMailLabel,
  deleteMailLabel,
  getMailLabel,
  listMailLabels,
  MailLabelError,
  updateMailLabel,
} from '../../services/mail/labels';
import { listThreadsByLabel } from '../../services/mail/threads';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * True only if the caller may access every mail account the given messages
 * belong to. Guards the bulk message-label ops so labels can't be written onto
 * a private account's messages the caller isn't assigned to.
 */
async function canAccessMessageAccounts(
  db: Parameters<typeof checkAccountAccess>[0],
  userId: string,
  messageIds: string[],
): Promise<boolean> {
  if (messageIds.length === 0) return true;
  const rows = await db
    .select({ accountId: schema.mailMessages.accountId })
    .from(schema.mailMessages)
    .where(inArray(schema.mailMessages.id, messageIds));
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  for (const accountId of accountIds) {
    if (!(await checkAccountAccess(db, accountId, userId))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuery = z.object({
  accountId: z.string().optional(),
});

const createBody = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(100),
  color: z.string().max(20).optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(20).optional(),
  position: z.number().int().optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

const applyToMessagesBody = z.object({
  labelName: z.string().min(1),
  messageIds: z.array(z.string()).min(1).max(500),
});

const threadLabelBody = z.object({
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  labelName: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

const threadsQuery = z.object({
  accountId: z.string().optional(),
  labelSlug: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapLabelError(c: Parameters<typeof error.badRequest>[0], err: MailLabelError) {
  switch (err.code) {
    case 'DUPLICATE_NAME':
      return error.conflict(c, err.message);
    case 'NOT_FOUND':
      return error.notFound(c, 'Label');
    case 'SYSTEM_LABEL_IMMUTABLE':
      return error.forbidden(c, err.message);
  }
}

// ---------------------------------------------------------------------------
// Threads-by-label — declared before /:id so the path can't shadow it.
// ---------------------------------------------------------------------------

/**
 * GET /threads — paginated threads filtered by label.
 *
 * `accountId` query param restricts to one account; omit it to get the
 * unified inbox across every account the caller can read.
 */
app.get(
  '/threads',
  requirePermission('messages:read'),
  zValidator('query', threadsQuery),
  async (c) => {
    const q = c.req.valid('query');
    try {
      const result = await listThreadsByLabel(c.get('tenantDb'), c.get('userId'), {
        accountId: q.accountId,
        labelSlug: q.labelSlug,
        page: q.page,
        pageSize: q.pageSize,
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/mail-labels] threads-by-label failed:', err);
      return error.internal(c, 'Failed to fetch threads for label');
    }
  },
);

// ---------------------------------------------------------------------------
// Bulk apply / unapply — also static paths, declared before /:id.
// ---------------------------------------------------------------------------

app.post(
  '/add-to-messages',
  requirePermission('messages:update'),
  zValidator('json', applyToMessagesBody),
  async (c) => {
    const { labelName, messageIds } = c.req.valid('json');
    if (!(await canAccessMessageAccounts(c.get('tenantDb'), c.get('userId'), messageIds))) {
      return error.forbidden(c, 'Access to one or more mail accounts is not allowed');
    }
    try {
      const result = await bulkAddLabelToMessages(c.get('tenantDb'), labelName, messageIds);
      return success(c, { count: result.affected });
    } catch (err) {
      console.error('[app-api/mail-labels] add-to-messages failed:', err);
      return error.internal(c, 'Failed to apply label');
    }
  },
);

app.post(
  '/remove-from-messages',
  requirePermission('messages:update'),
  zValidator('json', applyToMessagesBody),
  async (c) => {
    const { labelName, messageIds } = c.req.valid('json');
    if (!(await canAccessMessageAccounts(c.get('tenantDb'), c.get('userId'), messageIds))) {
      return error.forbidden(c, 'Access to one or more mail accounts is not allowed');
    }
    try {
      const result = await bulkRemoveLabelFromMessages(c.get('tenantDb'), labelName, messageIds);
      return success(c, { count: result.affected });
    } catch (err) {
      console.error('[app-api/mail-labels] remove-from-messages failed:', err);
      return error.internal(c, 'Failed to remove label');
    }
  },
);

app.post(
  '/apply-to-thread',
  requirePermission('messages:update'),
  zValidator('json', threadLabelBody),
  async (c) => {
    const { accountId, threadId, labelName, action } = c.req.valid('json');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await applyLabelToThread(
        db,
        accountId,
        threadId,
        labelName,
        action,
      );
      return success(c, { affected: result.affected, action });
    } catch (err) {
      console.error('[app-api/mail-labels] apply-to-thread failed:', err);
      return error.internal(c, 'Failed to update thread labels');
    }
  },
);

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const { accountId } = c.req.valid('query');
    if (accountId) {
      const allowed = await checkAccountAccess(db, accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    }
    const rows = await listMailLabels(db, { accountId });
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-labels] list failed:', err);
    return error.internal(c, 'Failed to list labels');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const row = await getMailLabel(db, id);
    if (!row) return error.notFound(c, 'Label', id);
    const allowed = await checkAccountAccess(db, row.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-labels] get failed:', err);
    return error.internal(c, 'Failed to fetch label');
  }
});

app.post(
  '/',
  requirePermission('accounts:create'),
  zValidator('json', createBody),
  async (c) => {
    const data = c.req.valid('json');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, data.accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const row = await createMailLabel(db, data);
      publishEntityEvent({
        c,
        entityType: 'mail_label',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, accountId: row.accountId, name: row.name },
      });
      return success(c, row, 201);
    } catch (err) {
      if (err instanceof MailLabelError) return mapLabelError(c, err);
      console.error('[app-api/mail-labels] create failed:', err);
      return error.internal(c, 'Failed to create label');
    }
  },
);

const applyUpdate = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
  id: string,
  data: z.infer<typeof updateBody>,
) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const existing = await getMailLabel(db, id);
  if (!existing) return error.notFound(c, 'Label', id);
  const allowed = await checkAccountAccess(db, existing.accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    const result = await updateMailLabel(db, id, data);
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: id,
      action: 'updated',
      data: { id, accountId: result.after.accountId, name: result.after.name },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailLabelError) return mapLabelError(c, err);
    console.error('[app-api/mail-labels] update failed:', err);
    return error.internal(c, 'Failed to update label');
  }
};

app.put(
  '/:id',
  requirePermission('accounts:update'),
  zValidator('json', updateBody),
  async (c) => applyUpdate(c, c.req.param('id'), c.req.valid('json')),
);

app.patch(
  '/:id',
  requirePermission('accounts:update'),
  zValidator('json', updateBody),
  async (c) => applyUpdate(c, c.req.param('id'), c.req.valid('json')),
);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const existing = await getMailLabel(db, id);
    if (!existing) return error.notFound(c, 'Label', id);
    const allowed = await checkAccountAccess(db, existing.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await deleteMailLabel(db, id);
    if (!row) return error.notFound(c, 'Label', id);
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: row.accountId, name: row.name },
    });
    return success(c, { id, deleted: true });
  } catch (err) {
    if (err instanceof MailLabelError) return mapLabelError(c, err);
    console.error('[app-api/mail-labels] delete failed:', err);
    return error.internal(c, 'Failed to delete label');
  }
});

export const mailLabelsRoutes = app;
