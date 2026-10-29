/**
 * Mail labels — the user labels of a mailbox.
 *
 * System folders (`INBOX`, `SENT`, `STARRED`, …) are not rows here; they are
 * fixed names any message filter accepts. A label belongs to one account, and
 * renaming it renames it on every message that carries it.
 *
 * Applying labels to messages is on `mail-messages` and `mail-threads`.
 *
 * Label definitions stay on Postgres in every mailbox-store mode (design
 * docs/plans/weldmail-mailbox-store-design.md, task D5: "P rows" — `mail_labels`
 * is config, not mail content); only the per-account access check goes through
 * `getWorkspaceMail`'s `access`, so a workspace key and a private mailbox
 * behave the same here as everywhere else in WeldMail.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createMailLabel,
  deleteMailLabel,
  getMailLabel,
  listMailLabels,
  MailLabelError,
  updateMailLabel,
} from '@weldsuite/mail-domain/labels';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { workspaceMailFromContext } from '../../../lib/mail-store-context';

const listQuery = z.object({
  accountId: z.string().optional(),
  /** Case-insensitive match on the label name. */
  search: z.string().max(100).optional(),
});

/** Auto-labelling: WeldMail applies the label to incoming mail that matches. */
const aiFields = {
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string().max(100)).max(50).optional(),
  aiDescription: z.string().max(1000).optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
};
/** The column holds `#RRGGBB`. */
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #4F46E5');
const createBody = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  color: color.optional(),
  ...aiFields,
});
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    color: color.optional(),
    position: z.number().int().optional(),
    ...aiFields,
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update');

const app = new Hono<HonoEnv>();

/** The label when it exists in a mailbox the caller can open. */
async function reachableLabel(c: Context<HonoEnv>, id: string) {
  const label = await getMailLabel(c.get('tenantDb'), id);
  if (!label) return null;
  const { access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(label.accountId))) return null;
  return label;
}

function labelErrorResponse(c: Context<HonoEnv>, err: unknown, id?: string) {
  if (err instanceof MailLabelError) {
    if (err.code === 'NOT_FOUND') return error.notFound(c, 'MailLabel', id);
    return error.conflict(c, err.message);
  }
  throw err;
}

app.get('/', requireScope('mail_labels:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const { accountId, search } = c.req.valid('query');
  const { access } = await workspaceMailFromContext(c);
  if (accountId && !(await access.canOpen(accountId))) {
    return error.notFound(c, 'MailAccount', accountId);
  }
  const rows = await listMailLabels(db, {
    accountId,
    accessibleAccountIds: accountId ? undefined : await access.accessibleAccountIds(),
  });
  // A mailbox has tens of labels, not thousands: filtering here is cheaper
  // than another query shape.
  const term = search?.trim().toLowerCase();
  const data = term ? rows.filter((r) => r.name.toLowerCase().includes(term)) : rows;
  return list(c, data, cursorPagination(data.length, false, null));
});

app.get('/:id', requireScope('mail_labels:read'), async (c) => {
  const id = c.req.param('id');
  const label = await reachableLabel(c, id);
  if (!label) return error.notFound(c, 'MailLabel', id);
  return success(c, label);
});

app.post('/', requireScope('mail_labels:write'), zValidator('json', createBody), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const { access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(body.accountId))) {
    return error.notFound(c, 'MailAccount', body.accountId);
  }
  try {
    const row = await createMailLabel(db, body);
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, accountId: row.accountId, name: row.name },
    });
    return success(c, row, 201);
  } catch (err) {
    return labelErrorResponse(c, err);
  }
});

app.patch('/:id', requireScope('mail_labels:write'), zValidator('json', updateBody), async (c) => {
  const id = c.req.param('id');
  if (!(await reachableLabel(c, id))) return error.notFound(c, 'MailLabel', id);
  try {
    const { after } = await updateMailLabel(c.get('tenantDb'), id, c.req.valid('json'));
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: id,
      action: 'updated',
      data: { id, accountId: after.accountId, name: after.name },
    });
    return success(c, after);
  } catch (err) {
    return labelErrorResponse(c, err, id);
  }
});

app.delete('/:id', requireScope('mail_labels:write'), async (c) => {
  const id = c.req.param('id');
  if (!(await reachableLabel(c, id))) return error.notFound(c, 'MailLabel', id);
  try {
    const deleted = await deleteMailLabel(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'MailLabel', id);
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: deleted.accountId, name: deleted.name },
    });
    return noContent(c);
  } catch (err) {
    return labelErrorResponse(c, err, id);
  }
});

export default app;
