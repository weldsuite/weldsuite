/**
 * Reading and writing a bank account's payment settings (check printing,
 * ACH origination, Positive Pay). The bank-accounts route owns the rest of
 * the bank account; these columns are kept here.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { CHECK_LAYOUTS } from '@weldsuite/books-domain/us-compliance/checks';
import { POSITIVE_PAY_FORMATS } from '@weldsuite/books-domain/us-compliance/positive-pay';
import { badRequest, notFound, PaymentRunError } from './errors';
import { loadBankAccount } from './runs';
import {
  achPatchToStored,
  achReadiness,
  checkReadiness,
  effectiveOriginator,
  mergeSection,
  positivePayFormatOf,
  readAchSettings,
  readCheckSettings,
  readPositivePayConfig,
  type UpdateSettingsInput,
} from './settings';

type BankAccountRow = typeof schema.bankAccounts.$inferSelect;

/** The highest all-digit check number written on the account, voided checks included. */
export async function highestCheckNumber(db: Database, bankAccountId: string): Promise<number | null> {
  const [row] = await db
    .select({ highest: sql<string | null>`max(${schema.payments.checkNumber}::bigint)` })
    .from(schema.payments)
    .where(and(eq(schema.payments.bankAccountId, bankAccountId), sql`${schema.payments.checkNumber} ~ '^[0-9]{1,15}$'`));
  return row?.highest === null || row?.highest === undefined ? null : Number(row.highest);
}

export async function getBankSettings(db: Database, entityId: string, bankAccountId: string) {
  const bank = await loadBankAccount(db, entityId, bankAccountId);
  return settingsView(db, bank);
}

async function settingsView(db: Database, bank: BankAccountRow) {
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, bank.entityId)).limit(1);
  if (!entity) throw notFound('Accounting entity', bank.entityId);
  const check = readCheckSettings(bank.checkSettings);
  const ach = readAchSettings(bank.achSettings);
  const effective = effectiveOriginator(bank, entity, ach);
  const offsetBank =
    ach.balanced && ach.offsetBankAccountId && ach.offsetBankAccountId !== bank.id
      ? (
          await db
            .select()
            .from(schema.bankAccounts)
            .where(and(eq(schema.bankAccounts.id, ach.offsetBankAccountId), isNull(schema.bankAccounts.deletedAt)))
            .limit(1)
        )[0]
      : bank;
  const highest = await highestCheckNumber(db, bank.id);

  return {
    bankAccountId: bank.id,
    bankAccountName: bank.name,
    bankName: bank.bankName,
    routingNumber: bank.routingNumber,
    accountNumberLast4: bank.accountNumberLast4,
    hasAccountNumber: Boolean(bank.accountNumberEncrypted),
    nextCheckNumber: bank.nextCheckNumber,
    highestCheckNumberUsed: highest,
    checkSettings: check,
    achSettings: ach,
    /** What a NACHA file would say today: the settings with the bank account's and entity's values filling the gaps. */
    effectiveAch: effective,
    positivePayFormat: positivePayFormatOf(bank),
    positivePayConfig: readPositivePayConfig(bank.checkSettings),
    readiness: {
      checks: checkReadiness(bank, check),
      ach: achReadiness(effective, ach, Boolean(offsetBank?.routingNumber && offsetBank.accountNumberEncrypted)),
      positivePay: {
        ready: Boolean(bank.accountNumberEncrypted),
        missing: bank.accountNumberEncrypted ? [] : ['accountNumber'],
      },
    },
    layouts: CHECK_LAYOUTS,
    positivePayFormats: POSITIVE_PAY_FORMATS,
  };
}

export async function updateBankSettings(
  db: Database,
  args: { entityId: string; bankAccountId: string; input: UpdateSettingsInput },
) {
  const bank = await loadBankAccount(db, args.entityId, args.bankAccountId);
  const { input } = args;
  const set: Partial<typeof schema.bankAccounts.$inferInsert> = { updatedAt: new Date() };
  const changed: string[] = [];

  if (input.nextCheckNumber !== undefined) {
    if (input.nextCheckNumber !== null) {
      const highest = await highestCheckNumber(db, bank.id);
      if (highest !== null && input.nextCheckNumber <= highest) {
        throw new PaymentRunError(
          'CHECK_NUMBER_IN_USE',
          `Check numbers only go forward: ${highest} is already used on this account, so the next one has to be ${highest + 1} or more.`,
          409,
          { highestUsed: highest },
        );
      }
    }
    set.nextCheckNumber = input.nextCheckNumber;
    changed.push('nextCheckNumber');
  }

  let checkSettings = bank.checkSettings;
  if (input.checkSettings) {
    checkSettings = mergeSection(checkSettings, input.checkSettings as Record<string, unknown>);
    changed.push('checkSettings');
  }
  if (input.positivePayConfig !== undefined) {
    checkSettings = mergeSection(checkSettings, { positivePayConfig: input.positivePayConfig });
    changed.push('positivePayConfig');
  }
  if (checkSettings !== bank.checkSettings) set.checkSettings = checkSettings;

  if (input.achSettings) {
    let patch: Record<string, unknown>;
    try {
      patch = achPatchToStored(input.achSettings);
    } catch (err) {
      throw badRequest('INVALID_EIN', (err as Error).message);
    }
    const offsetId = patch.offsetBankAccountId;
    if (typeof offsetId === 'string' && offsetId !== bank.id) {
      const offset = await loadBankAccount(db, args.entityId, offsetId);
      if (!offset.routingNumber || !offset.accountNumberEncrypted) {
        throw badRequest('OFFSET_ACCOUNT_INCOMPLETE', `${offset.name} needs a routing number and an account number to be the offset account.`);
      }
    }
    set.achSettings = mergeSection(bank.achSettings, patch);
    changed.push('achSettings');
  }

  if (input.positivePayFormat !== undefined) {
    set.positivePayFormat = input.positivePayFormat;
    changed.push('positivePayFormat');
  }

  const [updated] = await db.update(schema.bankAccounts).set(set).where(eq(schema.bankAccounts.id, bank.id)).returning();
  return { view: await settingsView(db, updated ?? bank), changed };
}
