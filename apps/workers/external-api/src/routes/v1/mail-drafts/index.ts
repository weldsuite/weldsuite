/**
 * Mail drafts — compose without sending.
 *
 * A draft is an unsent message on one account. It shows up in that mailbox's
 * Drafts in WeldMail, where a person can review and send it. Through the public
 * API it can also be sent directly (`POST /:id/send`, in `mail-sending`), which
 * needs the separate `mail_messages:send` scope.
 *
 * `attachmentIds` are upload ids from `POST /v1/mail-attachments`; they are
 * resolved when the draft is sent, not when it is saved.
 *
 * The list fans out over `getWorkspaceMail`'s `store`
 * (`WorkspaceMailStore.listDrafts`/`MailboxStore.listDrafts`, design task D5)
 * instead of a direct `accessibleAccountIds` scope; single-draft CRUD stays on
 * the Postgres `drafts.ts` functions (drafts live only on Postgres in
 * `postgres`/`shadow` mode today), gated by the same `access.canOpen` every
 * other mail route now uses.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { emailEventData } from '@weldsuite/mail-domain/access';
import { createDraft, getDraft, softDeleteDraft, updateDraft } from '@weldsuite/mail-domain/drafts';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { workspaceMailFromContext } from '../../../lib/mail-store-context';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  accountId: z.string().optional(),
});

const addresses = z.array(z.string().email()).max(100);
const draftFields = {
  to: addresses.optional(),
  cc: addresses.optional(),
  bcc: addresses.optional(),
  replyTo: z.array(z.string().email()).max(5).optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(1_000_000).optional(),
  htmlBody: z.string().max(2_000_000).optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  attachmentIds: z.array(z.string()).max(20).optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  /** RFC 5322 Message-ID of the mail this draft answers, to keep it in that thread when sent. */
  inReplyTo: z.string().max(500).optional(),
  /** Record id of the email this draft replies to or forwards. */
  originalMessageId: z.string().optional(),
  isReply: z.boolean().optional(),
  isForward: z.boolean().optional(),
};
const createBody = z.object({ accountId: z.string().min(1), ...draftFields });
const updateBody = z
  .object({ accountId: z.string().min(1).optional(), ...draftFields })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update');

const app = new Hono<HonoEnv>();

/** The draft when it exists in a mailbox the caller can open. */
async function reachableDraft(c: Context<HonoEnv>, id: string) {
  const draft = await getDraft(c.get('tenantDb'), id);
  if (!draft) return null;
  const { access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(draft.accountId))) return null;
  return draft;
}

/** Draft events carry the subject only for a shared mailbox (see `emailEventData`). */
async function draftEventData(c: Context<HonoEnv>, draft: { id: string; accountId: string; subject: string | null }) {
  const { subject } = await emailEventData(c.get('tenantDb'), {
    accountId: draft.accountId,
    subject: draft.subject,
    from: null,
    to: null,
  });
  return { id: draft.id, accountId: draft.accountId, subject: subject ?? null };
}

app.get('/', requireScope('mail_drafts:read'), zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const { store, access } = await workspaceMailFromContext(c);
  if (q.accountId && !(await access.canOpen(q.accountId))) {
    return error.notFound(c, 'MailAccount', q.accountId);
  }
  // 50: the legacy `listDrafts`'s own default (`Math.min(filters.limit ?? 50, 100)`), preserved here since the store's `limit` is required, not optional.
  const result = q.accountId
    ? await store.mailbox(q.accountId).listDrafts({ limit: q.limit ?? 50, cursor: q.cursor })
    : await store.listDrafts(await access.accessibleAccountIds(), { limit: q.limit ?? 50, cursor: q.cursor });
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('mail_drafts:read'), async (c) => {
  const id = c.req.param('id');
  const draft = await reachableDraft(c, id);
  if (!draft) return error.notFound(c, 'MailDraft', id);
  return success(c, draft);
});

app.post('/', requireScope('mail_drafts:write'), zValidator('json', createBody), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const { access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(body.accountId))) {
    return error.notFound(c, 'MailAccount', body.accountId);
  }
  const row = await createDraft(db, { ...body, isReply: body.isReply ?? (body.inReplyTo ? true : undefined) });
  publishEntityEvent({ c, entityType: 'mail_draft', entityId: row.id, action: 'created', data: await draftEventData(c, row) });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('mail_drafts:write'), zValidator('json', updateBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await reachableDraft(c, id))) return error.notFound(c, 'MailDraft', id);
  const body = c.req.valid('json');
  // Moving a draft to another mailbox needs access to that one too.
  if (body.accountId) {
    const { access } = await workspaceMailFromContext(c);
    if (!(await access.canOpen(body.accountId))) return error.notFound(c, 'MailAccount', body.accountId);
  }
  const result = await updateDraft(db, id, body);
  if (!result) return error.notFound(c, 'MailDraft', id);
  publishEntityEvent({ c, entityType: 'mail_draft', entityId: id, action: 'updated', data: await draftEventData(c, result.after) });
  return success(c, result.after);
});

app.delete('/:id', requireScope('mail_drafts:write'), async (c) => {
  const id = c.req.param('id');
  const draft = await reachableDraft(c, id);
  if (!draft) return error.notFound(c, 'MailDraft', id);
  await softDeleteDraft(c.get('tenantDb'), id);
  publishEntityEvent({ c, entityType: 'mail_draft', entityId: id, action: 'deleted', data: await draftEventData(c, draft) });
  return noContent(c);
});

export default app;
