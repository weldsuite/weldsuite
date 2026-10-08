/**
 * Payment settings of a bank account: /api/payment-runs/settings/:bankAccountId.
 *
 *   GET  returns the next check number, check, ACH and Positive Pay settings
 *        (defaults filled in), what a NACHA file would say today and whether
 *        each of checks, ACH and Positive Pay is ready to use
 *   PUT  {nextCheckNumber?, checkSettings?, achSettings?, positivePayFormat?, positivePayConfig?}
 *        changes the sections it names; inside a section only the keys sent
 *        change, and `null` clears one. `achSettings.ein` is write-only: it
 *        becomes the company identification ("1" + EIN).
 *
 * The bank-accounts route owns the rest of the bank account; these columns
 * live here. Permissions: banking:read | banking:manage.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { getBankSettings, updateBankSettings } from '../../services/payment-runs/bank-settings';
import { updateSettingsSchema } from '../../services/payment-runs/settings';
import { requireEntity, respondError } from './shared';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.get('/:bankAccountId', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    return success(c, await getBankSettings(db, entityId, c.req.param('bankAccountId')));
  } catch (err) {
    return respondError(c, err, 'fetch payment settings');
  }
});

settingsRoutes.put('/:bankAccountId', requirePermission('banking:manage'), zValidator('json', updateSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const bankAccountId = c.req.param('bankAccountId');
  try {
    const entityId = await requireEntity(c, db);
    if (entityId instanceof Response) return entityId;
    const { view, changed } = await updateBankSettings(db, { entityId, bankAccountId, input: c.req.valid('json') });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bank_account',
      entityId: bankAccountId,
      action: 'settings_updated',
      // Which sections changed, never their values.
      changes: Object.fromEntries(changed.map((key) => [key, { old: null, new: 'changed' }])),
    });
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: bankAccountId,
      action: 'updated',
      data: { id: bankAccountId, name: view.bankAccountName, nextCheckNumber: view.nextCheckNumber, changed },
    });
    return success(c, view);
  } catch (err) {
    return respondError(c, err, 'update payment settings');
  }
});
