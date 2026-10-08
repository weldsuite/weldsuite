/**
 * Per-bank-account settings for paying vendors: check printing, NACHA origination
 * and the Positive Pay file format. They live in the `bank_accounts` columns
 * `next_check_number`, `check_settings`, `ach_settings` and `positive_pay_format`
 * (jsonb columns are loosely typed; this file is where their shape is decided).
 *
 * Nothing secret is stored here: the account number stays encrypted on the
 * bank account, and a balanced NACHA file names the account to debit by id
 * (`offsetBankAccountId`), never by number.
 */

import { z } from 'zod';
import {
  abaChecksumValid,
  companyIdFromEin,
  type NachaSecCode,
} from '@weldsuite/books-domain/us-compliance/nacha';
import {
  CHECK_LAYOUTS,
  isCheckLayoutId,
  type CheckAlignment,
  type CheckLayoutId,
} from '@weldsuite/books-domain/us-compliance/checks';
import {
  isPositivePayFormat,
  POSITIVE_PAY_FORMATS,
  type PositivePayConfig,
  type PositivePayFormatId,
} from '@weldsuite/books-domain/us-compliance/positive-pay';
import type { schema } from '@weldsuite/worker-kit/db';

type BankAccountRow = typeof schema.bankAccounts.$inferSelect;
type EntityRow = typeof schema.entities.$inferSelect;

export const DEFAULT_HOLD_WINDOW_DAYS = 10;

// ---------------------------------------------------------------------------
// Check settings

export interface CheckSettings {
  layout: CheckLayoutId;
  alignment: CheckAlignment;
  /** Blank check stock: print the MICR line (the account number is decrypted and the reveal logged). */
  printMicr: boolean;
  micrLayout: 'business' | 'personal';
  /** Digits the check number is padded to in the MICR line. */
  checkNumberWidth: number;
  bankName: string | null;
  bankAddressLines: string[];
  /** The bank's number in the fractional routing number, e.g. "90-7162". */
  fractionalNumerator: string | null;
  signatureLineText: string | null;
}

export const DEFAULT_CHECK_SETTINGS: CheckSettings = {
  layout: 'voucher_top',
  alignment: {},
  printMicr: false,
  micrLayout: 'business',
  checkNumberWidth: 6,
  bankName: null,
  bankAddressLines: [],
  fractionalNumerator: null,
  signatureLineText: null,
};

const offset = z.number().finite().min(-72).max(72);

export const checkSettingsSchema = z
  .object({
    layout: z.enum(CHECK_LAYOUTS.map((l) => l.id) as [CheckLayoutId, ...CheckLayoutId[]]),
    alignment: z.object({ dx: offset, dy: offset, micrDx: offset, micrDy: offset }).partial(),
    printMicr: z.boolean(),
    micrLayout: z.enum(['business', 'personal']),
    checkNumberWidth: z.number().int().min(4).max(12),
    bankName: z.string().trim().max(60).nullable(),
    bankAddressLines: z.array(z.string().trim().max(60)).max(3),
    fractionalNumerator: z
      .string()
      .trim()
      .regex(/^\d{1,2}-\d{1,4}$/, 'The numerator looks like 90-7162')
      .nullable(),
    signatureLineText: z.string().trim().max(60).nullable(),
  })
  .partial();

export type CheckSettingsInput = z.infer<typeof checkSettingsSchema>;

/** The settings as stored, with the defaults filled in (unknown or bad values fall back). */
export function readCheckSettings(raw: Record<string, unknown> | null | undefined): CheckSettings {
  const source = raw ?? {};
  const layout = isCheckLayoutId(source.layout) ? source.layout : DEFAULT_CHECK_SETTINGS.layout;
  const alignment: CheckAlignment = {};
  if (source.alignment && typeof source.alignment === 'object') {
    for (const key of ['dx', 'dy', 'micrDx', 'micrDy'] as const) {
      const value = (source.alignment as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) alignment[key] = value;
    }
  }
  const width = typeof source.checkNumberWidth === 'number' ? source.checkNumberWidth : DEFAULT_CHECK_SETTINGS.checkNumberWidth;
  return {
    layout,
    alignment,
    printMicr: source.printMicr === true,
    micrLayout: source.micrLayout === 'personal' ? 'personal' : 'business',
    checkNumberWidth: Number.isInteger(width) && width >= 4 && width <= 12 ? width : DEFAULT_CHECK_SETTINGS.checkNumberWidth,
    bankName: typeof source.bankName === 'string' && source.bankName.trim() ? source.bankName.trim() : null,
    bankAddressLines: Array.isArray(source.bankAddressLines)
      ? source.bankAddressLines.filter((l): l is string => typeof l === 'string' && l.trim() !== '').slice(0, 3)
      : [],
    fractionalNumerator:
      typeof source.fractionalNumerator === 'string' && /^\d{1,2}-\d{1,4}$/.test(source.fractionalNumerator)
        ? source.fractionalNumerator
        : null,
    signatureLineText:
      typeof source.signatureLineText === 'string' && source.signatureLineText.trim() ? source.signatureLineText.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// ACH settings

export const ACH_SEC_CODES = ['PPD', 'CCD', 'CCD+', 'CTX'] as const;

export interface AchSettings {
  /** The bank's 9-digit routing number the file goes to. Defaults to the bank account's routing number. */
  immediateDestination: string | null;
  immediateDestinationName: string | null;
  /** 10-character company id (or the bank's routing number). Defaults to the company identification. */
  immediateOrigin: string | null;
  immediateOriginName: string | null;
  /** Shown on the vendor's statement (16 characters). Defaults to the entity name. */
  companyName: string | null;
  /** "1" + EIN, or the id the bank assigned. Defaults to the entity's EIN. */
  companyIdentification: string | null;
  odfiRoutingNumber: string | null;
  /** Add an offsetting debit to the originator's account (service class 200) instead of credits only (220). */
  balanced: boolean;
  /** The company bank account the offsetting debit hits; the run's own bank account when unset. */
  offsetBankAccountId: string | null;
  /** SEC code for business vendors when the run doesn't pick one. Individuals always get PPD. */
  defaultSecCode: NachaSecCode;
  sameDayAllowed: boolean;
  /** 10 characters; "VENDOR PAY" when unset ("PAYROLL" and "PURCHASE" are reserved by Nacha). */
  entryDescription: string | null;
  /** Days a vendor's changed bank details keep the vendor on hold unless verified. */
  holdWindowDays: number;
  /** Send a $0 prenote before the first payment to a new account and hold the payment until it has aged. */
  requirePrenotes: boolean;
}

export const DEFAULT_ACH_SETTINGS: AchSettings = {
  immediateDestination: null,
  immediateDestinationName: null,
  immediateOrigin: null,
  immediateOriginName: null,
  companyName: null,
  companyIdentification: null,
  odfiRoutingNumber: null,
  balanced: false,
  offsetBankAccountId: null,
  defaultSecCode: 'CCD',
  sameDayAllowed: false,
  entryDescription: null,
  holdWindowDays: DEFAULT_HOLD_WINDOW_DAYS,
  requirePrenotes: false,
};

const routing = z
  .string()
  .trim()
  .regex(/^\d{9}$/, 'A routing number is 9 digits')
  .refine(abaChecksumValid, 'The routing number fails the ABA checksum');

const RESERVED_DESCRIPTIONS = ['PAYROLL', 'PURCHASE'];

export const achSettingsSchema = z
  .object({
    immediateDestination: routing.nullable(),
    immediateDestinationName: z.string().trim().max(23).nullable(),
    immediateOrigin: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 ]{9,10}$/, 'The immediate origin is a 10-character company id or a 9-digit routing number')
      .nullable(),
    immediateOriginName: z.string().trim().max(23).nullable(),
    companyName: z.string().trim().max(16).nullable(),
    /** "1" + EIN or the id the bank assigned (10 characters). */
    companyIdentification: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{10}$/, 'The company identification is 10 characters, e.g. 1 followed by the 9-digit EIN')
      .nullable(),
    /** Write-only convenience: the EIN becomes the company identification ("1" + EIN). */
    ein: z.string().trim().max(11),
    odfiRoutingNumber: routing.nullable(),
    balanced: z.boolean(),
    offsetBankAccountId: z.string().trim().min(1).max(30).nullable(),
    defaultSecCode: z.enum(ACH_SEC_CODES),
    sameDayAllowed: z.boolean(),
    entryDescription: z
      .string()
      .trim()
      .max(10)
      .refine((v) => !RESERVED_DESCRIPTIONS.includes(v.toUpperCase()), '"PAYROLL" and "PURCHASE" are reserved by Nacha')
      .nullable(),
    holdWindowDays: z.number().int().min(1).max(365),
    requirePrenotes: z.boolean(),
  })
  .partial();

export type AchSettingsInput = z.infer<typeof achSettingsSchema>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readAchSettings(raw: Record<string, unknown> | null | undefined): AchSettings {
  const source = raw ?? {};
  const days = typeof source.holdWindowDays === 'number' ? source.holdWindowDays : DEFAULT_HOLD_WINDOW_DAYS;
  return {
    immediateDestination: text(source.immediateDestination),
    immediateDestinationName: text(source.immediateDestinationName),
    immediateOrigin: text(source.immediateOrigin),
    immediateOriginName: text(source.immediateOriginName),
    companyName: text(source.companyName),
    companyIdentification: text(source.companyIdentification),
    odfiRoutingNumber: text(source.odfiRoutingNumber),
    balanced: source.balanced === true,
    offsetBankAccountId: text(source.offsetBankAccountId),
    defaultSecCode: (ACH_SEC_CODES as readonly unknown[]).includes(source.defaultSecCode)
      ? (source.defaultSecCode as NachaSecCode)
      : 'CCD',
    sameDayAllowed: source.sameDayAllowed === true,
    entryDescription: text(source.entryDescription),
    holdWindowDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_HOLD_WINDOW_DAYS,
    requirePrenotes: source.requirePrenotes === true,
  };
}

// ---------------------------------------------------------------------------
// Positive Pay

export const POSITIVE_PAY_FIELDS = [
  'account_number',
  'check_number',
  'issue_date',
  'amount',
  'payee',
  'void_flag',
  'void_date',
  'action_code',
  'blank',
] as const;

export const positivePayConfigSchema = z
  .object({
    kind: z.enum(['csv', 'fixed']),
    columns: z
      .array(
        z.object({
          field: z.enum(POSITIVE_PAY_FIELDS),
          header: z.string().max(60).optional(),
          width: z.number().int().min(1).max(200).optional(),
          align: z.enum(['left', 'right']).optional(),
          pad: z.enum([' ', '0']).optional(),
          literal: z.string().max(60).optional(),
        }),
      )
      .min(1)
      .max(30),
    dateFormat: z.enum(['MMDDYYYY', 'MM/DD/YYYY', 'YYYYMMDD', 'YYYY-MM-DD', 'MMDDYY', 'MM/DD/YY']),
    amountFormat: z.enum(['decimal', 'implied_decimal']),
    delimiter: z.string().length(1),
    header: z.boolean(),
    quoteAll: z.boolean(),
    issueFlag: z.string().max(5),
    voidFlag: z.string().max(5),
    actionIssue: z.string().max(5),
    actionVoid: z.string().max(5),
    payeeMaxLength: z.number().int().min(1).max(200),
    uppercasePayee: z.boolean(),
    lineEnding: z.enum(['\r\n', '\n']),
  })
  .partial();

export type PositivePayConfigInput = z.infer<typeof positivePayConfigSchema>;

export function readPositivePayConfig(raw: Record<string, unknown> | null | undefined): Partial<PositivePayConfig> {
  const parsed = positivePayConfigSchema.safeParse(raw?.positivePayConfig);
  return parsed.success ? (parsed.data as Partial<PositivePayConfig>) : {};
}

export function positivePayFormatOf(account: Pick<BankAccountRow, 'positivePayFormat'>, override?: string | null): PositivePayFormatId {
  const wanted = override ?? account.positivePayFormat;
  return isPositivePayFormat(wanted) ? wanted : 'generic_csv';
}

// ---------------------------------------------------------------------------
// Request body for PUT /settings/:bankAccountId

export const updateSettingsSchema = z.object({
  /** The next check number to print. Can't go back to a number already used. */
  nextCheckNumber: z.number().int().min(1).max(999_999_999).nullable().optional(),
  checkSettings: checkSettingsSchema.optional(),
  achSettings: achSettingsSchema.optional(),
  positivePayFormat: z
    .enum(POSITIVE_PAY_FORMATS.map((f) => f.id) as [PositivePayFormatId, ...PositivePayFormatId[]])
    .nullable()
    .optional(),
  positivePayConfig: positivePayConfigSchema.nullable().optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/** A shallow merge where `null` deletes a key. */
export function mergeSection(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** The ACH patch as stored: the write-only `ein` becomes the company identification. */
export function achPatchToStored(input: AchSettingsInput): Record<string, unknown> {
  const { ein, ...rest } = input;
  const patch: Record<string, unknown> = { ...rest };
  if (ein !== undefined) {
    try {
      patch.companyIdentification = companyIdFromEin(ein);
    } catch {
      throw new RangeError('The EIN is 9 digits');
    }
  }
  return patch;
}

// ---------------------------------------------------------------------------
// What a NACHA file will say, with the defaults taken from the bank account and entity

export interface EffectiveOriginator {
  immediateDestination: string | null;
  immediateDestinationName: string;
  immediateOrigin: string | null;
  immediateOriginName: string;
  companyName: string;
  companyIdentification: string | null;
  odfiRoutingNumber: string | null;
}

function einOf(entity: Pick<EntityRow, 'taxIdentifiers'>): string | null {
  const raw = entity.taxIdentifiers?.einOrSsn ?? null;
  const digits = raw ? raw.replace(/\D/g, '') : '';
  return digits.length === 9 ? digits : null;
}

export function effectiveOriginator(
  bank: Pick<BankAccountRow, 'routingNumber' | 'bankName' | 'name'>,
  entity: Pick<EntityRow, 'name' | 'legalName' | 'dba' | 'taxIdentifiers'>,
  ach: AchSettings,
): EffectiveOriginator {
  const ein = einOf(entity);
  const companyIdentification = ach.companyIdentification ?? (ein ? companyIdFromEin(ein) : null);
  const entityName = entity.legalName ?? entity.name;
  return {
    immediateDestination: ach.immediateDestination ?? bank.routingNumber ?? null,
    immediateDestinationName: ach.immediateDestinationName ?? bank.bankName ?? bank.name,
    immediateOrigin: ach.immediateOrigin ?? companyIdentification,
    immediateOriginName: ach.immediateOriginName ?? entityName,
    companyName: ach.companyName ?? entity.dba ?? entityName,
    companyIdentification,
    odfiRoutingNumber: ach.odfiRoutingNumber ?? ach.immediateDestination ?? bank.routingNumber ?? null,
  };
}

export interface Readiness {
  ready: boolean;
  missing: string[];
}

export function achReadiness(effective: EffectiveOriginator, ach: AchSettings, hasOffsetAccount: boolean): Readiness {
  const missing: string[] = [];
  if (!effective.immediateDestination) missing.push('immediateDestination');
  if (!effective.companyIdentification) missing.push('companyIdentification');
  if (!effective.immediateOrigin) missing.push('immediateOrigin');
  if (ach.balanced && !hasOffsetAccount) missing.push('offsetBankAccount');
  return { ready: missing.length === 0, missing };
}

export function checkReadiness(bank: Pick<BankAccountRow, 'nextCheckNumber' | 'routingNumber' | 'accountNumberLast4'>, check: CheckSettings): Readiness {
  const missing: string[] = [];
  if (bank.nextCheckNumber === null || bank.nextCheckNumber === undefined) missing.push('nextCheckNumber');
  if (check.printMicr) {
    if (!bank.routingNumber) missing.push('routingNumber');
    if (!bank.accountNumberLast4) missing.push('accountNumber');
  }
  return { ready: missing.length === 0, missing };
}
