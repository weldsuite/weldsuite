/**
 * Bank account routes — flat /api/bank-accounts/* surface backed by `bankAccounts`.
 *
 * Entity-scoped CRUD with ledgerAccountId linkage, isDefault flag, and
 * autoReconcile config. lastImportDate / lastImportBalance are maintained
 * by the bank-transactions import route, not editable here.
 *
 * US banking: accountType (checking, savings, credit card, money market, line
 * of credit), an ABA-validated routing number and the account number, stored
 * encrypted with only the last four shown. Credit cards and lines of credit
 * sit on a liability ledger account. When none is chosen the chart's own
 * unlinked "Checking" / "Savings" / "Line of credit" account is used, else a
 * new one is created (a card gets a child of Credit Card Payable). The full number is only returned by
 * POST /:id/reveal-account-number, which needs `tax_ids:reveal` and writes an
 * append-only reveal row. Responses and events never carry the encrypted blob.
 *
 * Permissions: banking:read | banking:create | banking:update | banking:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { resolveEntityBaseCurrency, resolveEntityId } from '../../lib/entity-context';
import { PostingError } from '../../services/accounting-posting';
import {
  AccountNumberKeyError,
  assertLedgerAccountFits,
  BANK_ACCOUNT_TYPES,
  planBankLedgerAccount,
  isValidAbaRouting,
  normalizeAccountNumber,
  publicBankAccount,
  revealAccountNumber,
  sealAccountNumber,
} from '../../services/accounting-bank-accounts';
import { csvFormatSchema } from '../../services/bank-parsers/csv-format-schema';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.bankAccounts;

const routingNumber = z.string().regex(/^\d{9}$/, 'A routing number has nine digits');

const baseFields = {
  name: z.string().min(1).max(255),
  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
  bankName: z.string().max(255).optional(),
  accountHolderName: z.string().max(255).optional(),
  currency: z.string().length(3).optional(),
  ledgerAccountId: z.string().max(30).optional(),
  isDefault: z.boolean().optional(),
  autoReconcile: z.boolean().optional(),
  accountType: z.enum(BANK_ACCOUNT_TYPES).optional(),
  /** The next check number to print from this account. */
  nextCheckNumber: z.number().int().min(1).max(999_999_999).optional(),
  /** Remembered import settings; `csv` is the confirmed CSV layout. */
  importSettings: z.object({ csv: csvFormatSchema.optional() }).passthrough().optional(),
};

const createBankAccountSchema = z.object({
  ...baseFields,
  routingNumber: routingNumber.optional(),
  accountNumber: z.string().min(4).max(40).optional(),
  /** Set false to link an existing ledger account later instead of creating one for a typed account. */
  createLedgerAccount: z.boolean().optional(),
});

const updateBankAccountSchema = z.object(baseFields).partial().extend({
  routingNumber: routingNumber.nullable().optional(),
  accountNumber: z.string().min(4).max(40).nullable().optional(),
});

type BankAccountRow = typeof t.$inferSelect;

/** Load a ledger account of the entity, or answer with the reason it can't be used. */
async function loadLedgerAccount(
  db: Database,
  entityId: string,
  ledgerAccountId: string,
  accountType: string | null | undefined,
) {
  const [ledger] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, ledgerAccountId), eq(schema.accounts.entityId, entityId), isNull(schema.accounts.deletedAt)))
    .limit(1);
  if (!ledger) throw new PostingError('Ledger account not found for this accounting entity');
  assertLedgerAccountFits(ledger, accountType);
  return ledger;
}

function badNumbers(data: { routingNumber?: string | null; accountNumber?: string | null }): string | null {
  if (data.routingNumber && !isValidAbaRouting(data.routingNumber)) return 'That routing number does not pass the ABA check. Check the nine digits.';
  if (data.accountNumber && !normalizeAccountNumber(data.accountNumber)) return 'An account number has 4 to 34 letters or digits.';
  return null;
}

// GET / — all bank accounts for the resolved accounting entity
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const accountingEntityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list.
    if (!accountingEntityId) return success(c, []);
    const conditions = [isNull(t.deletedAt), eq(t.entityId, accountingEntityId)];
    const accountType = c.req.query('accountType');
    if (accountType) conditions.push(eq(t.accountType, accountType));
    const isActive = c.req.query('isActive');
    if (isActive !== undefined) conditions.push(eq(t.isActive, isActive === 'true'));
    const results = await db.select().from(t).where(and(...conditions)).orderBy(t.name);
    return success(c, results.map(publicBankAccount));
  } catch (err) {
    console.error('[books-api/bank-accounts] list failed:', err);
    return error.internal(c, 'Failed to fetch bank accounts');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account) return error.notFound(c, 'Bank account', id);
    return success(c, publicBankAccount(account));
  } catch (err) {
    console.error('[books-api/bank-accounts] get failed:', err);
    return error.internal(c, 'Failed to fetch bank account');
  }
});

// POST /
app.post('/', requirePermission('banking:create'), zValidator('json', createBankAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const accountingEntityId = await resolveEntityId(c, db);
    if (!accountingEntityId) return error.badRequest(c, 'No accounting entity resolved');
    const invalid = badNumbers(data);
    if (invalid) return error.badRequest(c, invalid);

    const currency = data.currency ?? (await resolveEntityBaseCurrency(db, accountingEntityId));

    let ledgerAccountId = data.ledgerAccountId ?? null;
    let newLedger: Extract<Awaited<ReturnType<typeof planBankLedgerAccount>>, { kind: 'new' }>['row'] | null = null;
    let ledgerInfo: { id: string; code: string; name: string; created: boolean } | undefined;
    if (ledgerAccountId) {
      await loadLedgerAccount(db, accountingEntityId, ledgerAccountId, data.accountType);
    } else if (data.accountType && data.createLedgerAccount !== false) {
      // The ledger account holds base-currency amounts.
      const plan = await planBankLedgerAccount(db, {
        entityId: accountingEntityId,
        name: data.name,
        accountType: data.accountType,
        currency: await resolveEntityBaseCurrency(db, accountingEntityId),
      });
      if (plan.kind === 'existing') {
        ledgerAccountId = plan.account.id;
        ledgerInfo = { id: plan.account.id, code: plan.account.code, name: plan.account.name, created: false };
      } else {
        newLedger = plan.row;
        ledgerAccountId = plan.row.id;
        ledgerInfo = { id: plan.row.id, code: plan.row.code, name: plan.row.name, created: true };
      }
    }

    const normalized = data.accountNumber ? normalizeAccountNumber(data.accountNumber) : null;
    const sealed = normalized ? await sealAccountNumber(c.env, normalized) : null;

    const { accountNumber: _accountNumber, createLedgerAccount: _create, ...fields } = data;
    const now = new Date();
    const newAccount = {
      id: generateId('ba'),
      entityId: accountingEntityId,
      ...fields,
      currency,
      ledgerAccountId,
      ...(sealed ?? {}),
      isActive: true,
      currentBalance: '0',
      createdAt: now,
      updatedAt: now,
    };
    await atomically(db, (h) => [
      ...(newLedger ? [h.insert(schema.accounts).values(newLedger)] : []),
      h.insert(t).values(newAccount),
    ]);

    if (newLedger) {
      publishEntityEvent({ c, entityType: 'account', entityId: newLedger.id, action: 'created', data: newLedger as unknown as Record<string, unknown> });
    }
    const payload = publicBankAccount(newAccount as unknown as BankAccountRow);
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: newAccount.id,
      action: 'created',
      data: payload as unknown as Record<string, unknown>,
    });
    await writeAccountingAudit(c, db, {
      accountingEntityId,
      entityType: 'bank_account',
      entityId: newAccount.id,
      action: 'created',
      changes: {
        accountType: { old: null, new: data.accountType ?? null },
        accountNumberLast4: { old: null, new: sealed?.accountNumberLast4 ?? null },
        ledgerAccountId: { old: null, new: ledgerAccountId },
      },
    });
    return success(c, { ...payload, ledgerAccount: ledgerInfo }, 201);
  } catch (err) {
    if (err instanceof PostingError) return error.badRequest(c, err.message);
    if (err instanceof AccountNumberKeyError) return error.internal(c, err.message);
    console.error('[books-api/bank-accounts] create failed:', err);
    return error.internal(c, 'Failed to create bank account');
  }
});

// PUT|PATCH /:id — PUT preserved from the legacy api-worker surface;
// PATCH added for app-api convention. Same partial-update semantics.
app.on(['PUT', 'PATCH'], '/:id', requirePermission('banking:update'), zValidator('json', updateBankAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account) return error.notFound(c, 'Bank account', id);
    const invalid = badNumbers(data);
    if (invalid) return error.badRequest(c, invalid);

    const { accountNumber, importSettings, ...fields } = data;
    const patch: Partial<BankAccountRow> = { ...fields };

    const accountType = data.accountType ?? account.accountType;
    const ledgerAccountId = data.ledgerAccountId ?? account.ledgerAccountId;
    if (ledgerAccountId && (data.ledgerAccountId || data.accountType)) {
      await loadLedgerAccount(db, account.entityId, ledgerAccountId, accountType);
    }

    if (accountNumber === null) {
      patch.accountNumberEncrypted = null;
      patch.accountNumberLast4 = null;
    } else if (accountNumber) {
      Object.assign(patch, await sealAccountNumber(c.env, normalizeAccountNumber(accountNumber)!));
    }
    if (importSettings) patch.importSettings = { ...(account.importSettings ?? {}), ...importSettings };

    await db.update(t).set({ ...patch, updatedAt: new Date() }).where(eq(t.id, id));
    const updated = { ...account, ...patch };
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: id,
      action: 'updated',
      data: publicBankAccount(updated) as unknown as Record<string, unknown>,
    });
    if (accountNumber !== undefined) {
      await writeAccountingAudit(c, db, {
        accountingEntityId: account.entityId,
        entityType: 'bank_account',
        entityId: id,
        action: 'updated',
        changes: { accountNumberLast4: { old: account.accountNumberLast4, new: updated.accountNumberLast4 ?? null } },
      });
    }
    return success(c, publicBankAccount(updated));
  } catch (err) {
    if (err instanceof PostingError) return error.badRequest(c, err.message);
    if (err instanceof AccountNumberKeyError) return error.internal(c, err.message);
    console.error('[books-api/bank-accounts] update failed:', err);
    return error.internal(c, 'Failed to update bank account');
  }
});

// POST /:id/reveal-account-number — the full number, logged. Needs tax_ids:reveal.
app.post('/:id/reveal-account-number', requirePermission('banking:read'), requirePermission('tax_ids:reveal'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, db);
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account || (entityId && account.entityId !== entityId)) return error.notFound(c, 'Bank account', id);

    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const revealed = await revealAccountNumber(db, c.env, { account, userId: c.get('userId'), reason });

    await writeAccountingAudit(c, db, {
      accountingEntityId: account.entityId,
      entityType: 'bank_account',
      entityId: id,
      action: 'acct_number_revealed',
    });
    c.header('Cache-Control', 'no-store');
    return success(c, { ...revealed, accountNumberLast4: account.accountNumberLast4 });
  } catch (err) {
    if (err instanceof PostingError) return error.badRequest(c, err.message);
    if (err instanceof AccountNumberKeyError) return error.internal(c, err.message);
    console.error('[books-api/bank-accounts] reveal failed:', err);
    return error.internal(c, 'Failed to reveal the account number');
  }
});

// DELETE /:id — soft delete
app.delete('/:id', requirePermission('banking:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account) return error.notFound(c, 'Bank account', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: id,
      action: 'deleted',
      data: publicBankAccount(account) as unknown as Record<string, unknown>,
    });
    return noContent(c);
  } catch (err) {
    console.error('[books-api/bank-accounts] delete failed:', err);
    return error.internal(c, 'Failed to delete bank account');
  }
});

export const bankAccountsRoutes = app;
