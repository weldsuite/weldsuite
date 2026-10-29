/**
 * Mail draft routes — /api/mail-drafts/*.
 *
 * Unsent compositions. The send path lives on `mail-accounts/:id/send`;
 * this surface is read/write of the holding table, plus a list filtered
 * by `accountId` for the compose-resume UI.
 *
 * Every read/write goes through `workspaceMailFromContext`'s `store`/`access`
 * (design docs/plans/weldmail-mailbox-store-design.md, task D2): the store's
 * `draft.create`/`draft.update`/`draft.delete` ops call the exact same
 * `@weldsuite/mail-domain/drafts` functions this route used to call directly
 * in `postgres` mode, and `getDraft`/`listDrafts` wrap the same reads, so
 * `postgres` mode's behaviour is unchanged. `postgres`/`shadow` keep today's
 * 403 for a draft whose account exists but is closed to the caller;
 * `object`/`object-only` collapse that to 404 too (design §5's "Locate").
 *
 * Entity events: `mail_draft:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { getDraft as getDraftRowUnscoped } from '@weldsuite/mail-domain/drafts';
import { generateId } from '@weldsuite/worker-kit/id';
import { workspaceMailFromContext } from '../../lib/mail-store-context';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailAccess, MailStoreMode, WorkspaceMailStore } from '@weldsuite/mail-domain/store';
import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = import('hono').Context<{ Bindings: Env; Variables: Variables }>;

const listQuery = z.object({
  accountId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const baseBody = {
  subject: z.string().max(998).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.array(z.string()).optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  labels: z.array(z.string()).optional(),
  attachmentIds: z.array(z.string()).optional(),
  inReplyTo: z.string().max(500).optional(),
  originalMessageId: z.string().optional(),
  isReply: z.boolean().optional(),
  isForward: z.boolean().optional(),
} as const;

const createBody = z.object({ accountId: z.string().min(1), ...baseBody });
const updateBody = z.object(baseBody).partial();

type LocateDraftResult = { ok: true; accountId: string; draft: MailDraft } | { ok: false; response: Response };

/**
 * `GET /:id`, `PUT`/`PATCH /:id`, `DELETE /:id` — 404 for a missing draft,
 * 403 for one whose account is closed to the caller (unchanged in
 * `postgres`/`shadow`; `object`/`object-only` answer 404 for both, design
 * §5's "Locate").
 */
async function locateDraftOrRespond(
  c: AppContext,
  db: Database,
  store: WorkspaceMailStore,
  access: MailAccess,
  mode: MailStoreMode,
  id: string,
): Promise<LocateDraftResult> {
  const accessibleIds = await access.accessibleAccountIds();
  const located = accessibleIds.length > 0 ? await store.locateDraft(id, accessibleIds) : null;
  if (located) return { ok: true, accountId: located.accountId, draft: located.draft };
  if (mode === 'postgres' || mode === 'shadow') {
    const existing = await getDraftRowUnscoped(db, id);
    if (!existing) return { ok: false, response: error.notFound(c, 'Draft', id) };
    return { ok: false, response: error.forbidden(c, 'Access to this mail account is not allowed') };
  }
  return { ok: false, response: error.notFound(c, 'Draft', id) };
}

app.get('/', requirePermission('messages:read'), zValidator('query', listQuery), async (c) => {
  try {
    const filters = c.req.valid('query');
    const { store, access } = await workspaceMailFromContext(c);
    const limit = filters.limit ?? 50;

    if (filters.accountId) {
      if (!(await access.canOpen(filters.accountId))) {
        return error.forbidden(c, 'Access to this mail account is not allowed');
      }
      const result = await store.mailbox(filters.accountId).listDrafts({ limit, cursor: filters.cursor });
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    }

    const accountIds = await access.accessibleAccountIds();
    const result = await store.listDrafts(accountIds, { limit, cursor: filters.cursor });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-drafts] list failed:', err);
    return error.internal(c, 'Failed to list drafts');
  }
});

app.get('/:id', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateDraftOrRespond(c, db, store, access, mode, id);
    if (!located.ok) return located.response;
    return success(c, located.draft);
  } catch (err) {
    console.error('[app-api/mail-drafts] get failed:', err);
    return error.internal(c, 'Failed to fetch draft');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createBody), async (c) => {
  try {
    const data = c.req.valid('json');
    const { store, access } = await workspaceMailFromContext(c);
    const allowed = await access.canOpen(data.accountId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const id = generateId('draft');
    await store.mailbox(data.accountId).apply({ kind: 'draft.create', draft: { id, ...data } });
    const row = await store.mailbox(data.accountId).getDraft(id);
    if (!row) return error.internal(c, 'Failed to create draft');
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, accountId: row.accountId, subject: row.subject ?? null },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-drafts] create failed:', err);
    return error.internal(c, 'Failed to create draft');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }, '/:id'>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateDraftOrRespond(c, db, store, access, mode, id);
    if (!located.ok) return located.response;
    const result = await store.mailbox(located.accountId).apply({ kind: 'draft.update', id, patch: data });
    if (!result.applied.includes(id)) return error.notFound(c, 'Draft', id);
    const after = await store.mailbox(located.accountId).getDraft(id);
    if (!after) return error.notFound(c, 'Draft', id);
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: id,
      action: 'updated',
      data: { id, accountId: after.accountId, subject: after.subject ?? null },
    });
    return success(c, after);
  } catch (err) {
    console.error('[app-api/mail-drafts] update failed:', err);
    return error.internal(c, 'Failed to update draft');
  }
};

app.put('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('messages:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateDraftOrRespond(c, db, store, access, mode, id);
    if (!located.ok) return located.response;
    const result = await store.mailbox(located.accountId).apply({ kind: 'draft.delete', id });
    if (!result.applied.includes(id)) return error.notFound(c, 'Draft', id);
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: located.accountId, subject: null },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-drafts] delete failed:', err);
    return error.internal(c, 'Failed to delete draft');
  }
});

export const mailDraftsRoutes = app;
