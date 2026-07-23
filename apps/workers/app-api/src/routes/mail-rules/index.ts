/**
 * Mail rule routes — /api/mail-rules/*.
 *
 * CRUD plus three extras kept from the legacy api-worker surface:
 *   - POST /:id/toggle — flip isActive without supplying the whole body.
 *   - POST /:id/duplicate — clone (always created disabled to avoid
 *     accidental double-fires).
 *   - POST /reorder — single-statement priority bulk-update from a list.
 *
 * Entity events: `email_rule:created | updated | deleted | enabled | disabled`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import * as rules from '../../services/mail/rules';
import { MailRuleError } from '../../services/mail/rules';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const conditionFieldEnum = z.enum([
  'from', 'to', 'cc', 'subject', 'body',
  'has_attachment', 'size', 'date', 'is_spam', 'priority',
]);

const conditionOperatorEnum = z.enum([
  'contains', 'not_contains', 'equals', 'not_equals',
  'starts_with', 'ends_with', 'greater_than', 'less_than',
  'is_true', 'is_false',
]);

const conditionSchema = z.object({
  field: conditionFieldEnum,
  operator: conditionOperatorEnum,
  value: z.union([z.string(), z.array(z.string())]),
});

const actionTypeEnum = z.enum([
  'move_to_folder', 'copy_to_folder', 'delete', 'mark_as_read', 'mark_as_unread',
  'star', 'add_label', 'remove_label', 'forward_to', 'auto_reply', 'flag', 'archive',
]);

const actionSchema = z.object({
  type: actionTypeEnum,
  value: z.string().optional(),
  folderId: z.string().optional(),
  labelId: z.string().optional(),
  email: z.string().email().optional(),
  templateId: z.string().optional(),
});

const listQuery = z.object({
  accountId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
});

const baseBody = {
  accountId: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  conditions: z.array(conditionSchema).min(1),
  matchType: z.enum(['all', 'any']).optional(),
  actions: z.array(actionSchema).min(1),
  isActive: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
  priority: z.number().int().optional(),
  applyToExisting: z.boolean().optional(),
  scope: z.enum(['incoming', 'outgoing', 'all']).optional(),
  folders: z.array(z.string()).optional(),
} as const;

const createBody = z.object(baseBody);
const updateBody = z.object(baseBody).omit({ accountId: true }).partial();

const reorderBody = z.object({
  rules: z.array(z.object({ id: z.string(), priority: z.number().int() })).min(1).max(500),
});

function mapRuleError(c: Parameters<typeof error.badRequest>[0], err: MailRuleError) {
  if (err.code === 'NOT_FOUND') return error.notFound(c, 'Rule');
  return error.internal(c, err.message);
}

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const filters = c.req.valid('query');
    if (filters.accountId) {
      const allowed = await checkAccountAccess(db, filters.accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    }
    const rows = await rules.listRules(db, filters);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-rules] list failed:', err);
    return error.internal(c, 'Failed to list rules');
  }
});

// Static path declared before /:id so it can't be shadowed.
app.post('/reorder', requirePermission('accounts:update'), zValidator('json', reorderBody), async (c) => {
  try {
    const result = await rules.reorderRules(c.get('tenantDb'), c.req.valid('json').rules);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/mail-rules] reorder failed:', err);
    return error.internal(c, 'Failed to reorder rules');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const row = await rules.getRule(db, id);
    if (!row) return error.notFound(c, 'Rule', id);
    const allowed = await checkAccountAccess(db, row.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-rules] get failed:', err);
    return error.internal(c, 'Failed to fetch rule');
  }
});

app.post('/', requirePermission('accounts:create'), zValidator('json', createBody), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    const allowed = await checkAccountAccess(db, data.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await rules.createRule(db, data);
    publishEntityEvent({
      c,
      entityType: 'email_rule',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, accountId: row.accountId, name: row.name, isActive: row.isActive },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-rules] create failed:', err);
    return error.internal(c, 'Failed to create rule');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const existing = await rules.getRule(db, id);
  if (!existing) return error.notFound(c, 'Rule', id);
  const allowed = await checkAccountAccess(db, existing.accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    const result = await rules.updateRule(db, id, data);
    publishEntityEvent({
      c,
      entityType: 'email_rule',
      entityId: id,
      action: 'updated',
      data: {
        id,
        accountId: result.after.accountId,
        name: result.after.name,
        isActive: result.after.isActive,
      },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailRuleError) return mapRuleError(c, err);
    console.error('[app-api/mail-rules] update failed:', err);
    return error.internal(c, 'Failed to update rule');
  }
};

app.put('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const existing = await rules.getRule(db, id);
    if (!existing) return error.notFound(c, 'Rule', id);
    const allowed = await checkAccountAccess(db, existing.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const deleted = await rules.softDeleteRule(db, id);
    if (!deleted) return error.notFound(c, 'Rule', id);
    publishEntityEvent({
      c,
      entityType: 'email_rule',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        accountId: deleted.accountId,
        name: deleted.name,
        isActive: deleted.isActive,
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-rules] delete failed:', err);
    return error.internal(c, 'Failed to delete rule');
  }
});

app.post('/:id/toggle', requirePermission('accounts:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const existing = await rules.getRule(db, id);
    if (!existing) return error.notFound(c, 'Rule', id);
    const allowed = await checkAccountAccess(db, existing.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const after = await rules.toggleRule(db, id);
    publishEntityEvent({
      c,
      entityType: 'email_rule',
      entityId: id,
      action: after.isActive ? 'enabled' : 'disabled',
      data: {
        id,
        accountId: after.accountId,
        name: after.name,
        isActive: after.isActive,
      },
    });
    return success(c, after);
  } catch (err) {
    if (err instanceof MailRuleError) return mapRuleError(c, err);
    console.error('[app-api/mail-rules] toggle failed:', err);
    return error.internal(c, 'Failed to toggle rule');
  }
});

app.post('/:id/duplicate', requirePermission('accounts:create'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const existing = await rules.getRule(db, id);
    if (!existing) return error.notFound(c, 'Rule', id);
    const allowed = await checkAccountAccess(db, existing.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await rules.duplicateRule(db, id);
    publishEntityEvent({
      c,
      entityType: 'email_rule',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, accountId: row.accountId, name: row.name, isActive: row.isActive },
    });
    return success(c, row, 201);
  } catch (err) {
    if (err instanceof MailRuleError) return mapRuleError(c, err);
    console.error('[app-api/mail-rules] duplicate failed:', err);
    return error.internal(c, 'Failed to duplicate rule');
  }
});

export const mailRulesRoutes = app;
