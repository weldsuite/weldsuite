/**
 * Vendor tax data on `parties`: the W-9 facts, the encrypted TIN and the
 * vendor's ACH details (docs/plans/weldbooks-us.md section 8).
 *
 * The full TIN and the ACH account number live only in
 * `parties.sensitive_encrypted`, a JSON blob `{ tin?, achAccountNumber? }`
 * sealed with the worker's DATABASE_ENCRYPTION_KEY. They are write-only over
 * the API: responses carry `tin_last4` / `ach_account_last4`, and a full value
 * comes back only through `revealPartySecret`, which writes the append-only
 * `tax_id_reveals` row before it returns anything. No value leaves this file
 * in an entity event, an audit change or an error message.
 *
 * A change to the routing number, the account number or the account type sets
 * `bank_details_changed_at` and clears the verification; payment runs hold a
 * vendor whose bank details are unverified (Nacha's 2026 fraud-monitoring rule).
 */

import { z } from 'zod';
import { decryptField, encryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { FORM_1099_OMIT, isAllocatableBox } from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import {
  isTinType,
  maskTin,
  tinLast4,
  validateRoutingNumber,
  validateTin,
  type TinType,
} from '@weldsuite/books-domain/jurisdictions/us/identifiers';

type PartyRow = typeof schema.parties.$inferSelect;
type PartyColumns = Partial<typeof schema.parties.$inferInsert>;

export type PartySecretField = 'tin' | 'ach_account_number';

/** What `sensitive_encrypted` holds once decrypted. */
export interface PartySensitive {
  tin?: string;
  achAccountNumber?: string;
}

/** W-9 data as stored; `isAttorney` is ours (the form has no such field) and keeps legal fees reportable for a corporation. */
export type PartyW9 = NonNullable<PartyRow['w9']> & { isAttorney?: boolean };

export const W9_FEDERAL_CLASSIFICATIONS = [
  'individual',
  'c_corporation',
  's_corporation',
  'partnership',
  'trust_estate',
  'llc',
  'other',
] as const;

/** A bad value in the vendor tax input; the message never contains the value. */
export class VendorTaxError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'VendorTaxError';
  }
}

/** The worker has no encryption key, so a TIN or account number can't be stored or read. */
export class VendorTaxKeyError extends Error {
  constructor() {
    super('Sensitive vendor data cannot be stored or read: the worker has no encryption key');
    this.name = 'VendorTaxKeyError';
  }
}

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

export function requireKeyring(env: KeyEnv): EncryptionKeyring {
  const keyring = keyringFromEnv(env);
  if (!keyring.v1 && !keyring.v2) throw new VendorTaxKeyError();
  return keyring;
}

// ---------------------------------------------------------------------------
// Request schema (merged into the contact create/update schema)
// ---------------------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().max(max);

export const w9InputSchema = z
  .object({
    legalName: optionalText(100),
    businessName: optionalText(100),
    federalTaxClassification: z.enum(W9_FEDERAL_CLASSIFICATIONS),
    llcTaxClassification: z.enum(['C', 'S', 'P']),
    exemptPayeeCode: optionalText(2),
    fatcaCode: optionalText(2),
    receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a YYYY-MM-DD date'),
    /** An accounting document (the scanned W-9). */
    documentId: optionalText(30),
    signedName: optionalText(100),
    source: z.enum(['upload', 'online']),
    isAttorney: z.boolean(),
  })
  .partial();

export type W9Input = z.infer<typeof w9InputSchema>;

/** Box codes a vendor default may take: an allocatable box, or `omit`. */
const defaultBoxSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => value === FORM_1099_OMIT || isAllocatableBox(value), 'Not a 1099 box code (for example nec_1 or misc_1)');

export const vendorTaxFields = {
  taxUse: z.enum(['business', 'personal']).nullable().optional(),
  is1099Vendor: z.boolean().optional(),
  default1099Form: z.enum(['nec', 'misc']).nullable().optional(),
  default1099Box: defaultBoxSchema.nullable().optional(),
  tinType: z.enum(['ein', 'ssn', 'itin']).nullable().optional(),
  /** Write-only. `null` removes the stored TIN. */
  tin: z.string().trim().max(20).nullable().optional(),
  w9: w9InputSchema.nullable().optional(),
  backupWithholding: z.boolean().optional(),
  /** When the recipient agreed to electronic delivery; `true` = now, `false`/`null` = withdrawn. */
  form1099EDeliveryConsentAt: z.union([z.string().datetime({ offset: true }), z.boolean()]).nullable().optional(),
  achRoutingNumber: z.string().trim().max(20).nullable().optional(),
  /** Write-only. `null` removes the stored account number. */
  achAccountNumber: z.string().trim().max(40).nullable().optional(),
  achAccountType: z.enum(['checking', 'savings']).nullable().optional(),
} as const;

export const vendorTaxSchema = z.object(vendorTaxFields);
export type VendorTaxInput = z.infer<typeof vendorTaxSchema>;

export const VENDOR_TAX_KEYS = Object.keys(vendorTaxFields) as Array<keyof VendorTaxInput>;

// ---------------------------------------------------------------------------
// Sealing and reading the blob
// ---------------------------------------------------------------------------

export async function readSensitive(
  party: Pick<PartyRow, 'sensitiveEncrypted'>,
  keyring: EncryptionKeyring,
): Promise<PartySensitive> {
  if (!party.sensitiveEncrypted) return {};
  return JSON.parse(await decryptField(party.sensitiveEncrypted, keyring)) as PartySensitive;
}

async function seal(blob: PartySensitive, keyring: EncryptionKeyring): Promise<string | null> {
  const compact: PartySensitive = {};
  if (blob.tin) compact.tin = blob.tin;
  if (blob.achAccountNumber) compact.achAccountNumber = blob.achAccountNumber;
  return Object.keys(compact).length === 0 ? null : encryptField(JSON.stringify(compact), keyring);
}

/** The full TIN of a party, decrypted without a reveal log (callers log or keep it server-side). */
export async function decryptPartyTin(
  party: Pick<PartyRow, 'sensitiveEncrypted'>,
  keyring: EncryptionKeyring,
): Promise<string | null> {
  return (await readSensitive(party, keyring)).tin ?? null;
}

// ---------------------------------------------------------------------------
// Applying input to a party
// ---------------------------------------------------------------------------

export interface VendorTaxChange {
  columns: PartyColumns;
  /** Audit-safe summary of what changed: names only, never values. */
  changes: Record<string, { old: unknown; new: unknown }>;
  tinChanged: boolean;
  bankDetailsChanged: boolean;
}

function cleanW9(w9: PartyW9): PartyW9 | null {
  const entries = Object.entries(w9).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length === 0 ? null : (Object.fromEntries(entries) as PartyW9);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function boxMatchesForm(box: string, form: string): boolean {
  return box === FORM_1099_OMIT || box.startsWith(`${form}_`);
}

/**
 * Validate the vendor tax fields of a create or update and build the party
 * columns they change. `existing` is null on create. Needs the keyring only
 * when a TIN or account number is written (or has to be compared).
 */
export async function buildVendorTaxChange(
  existing: PartyRow | null,
  input: VendorTaxInput,
  env: KeyEnv,
): Promise<VendorTaxChange> {
  const columns: PartyColumns = {};
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  let tinChanged = false;
  let bankDetailsChanged = false;

  if (input.taxUse !== undefined) columns.taxUse = input.taxUse;
  if (input.is1099Vendor !== undefined) columns.is1099Vendor = input.is1099Vendor;
  if (input.backupWithholding !== undefined) columns.backupWithholding = input.backupWithholding;

  // 1099 defaults: the box has to belong to the form.
  const form = input.default1099Form !== undefined ? input.default1099Form : existing?.default1099Form ?? null;
  if (input.default1099Form !== undefined) columns.default1099Form = input.default1099Form;
  if (input.default1099Box !== undefined) {
    if (input.default1099Box && form && !boxMatchesForm(input.default1099Box, form)) {
      throw new VendorTaxError(`default1099Box ${input.default1099Box} does not belong to form 1099-${form.toUpperCase()}`);
    }
    columns.default1099Box = input.default1099Box;
  } else if (input.default1099Form !== undefined) {
    const box = existing?.default1099Box;
    if (box && input.default1099Form && !boxMatchesForm(box, input.default1099Form)) columns.default1099Box = null;
  }

  // e-delivery consent
  if (input.form1099EDeliveryConsentAt !== undefined) {
    const value = input.form1099EDeliveryConsentAt;
    columns.form1099EDeliveryConsentAt =
      value === null || value === false ? null : value === true ? new Date() : new Date(value);
  }

  // W-9
  if (input.w9 !== undefined) {
    if (input.w9 === null) {
      columns.w9 = null;
    } else {
      const merged = cleanW9({ ...(existing?.w9 as PartyW9 | null | undefined), ...(input.w9 as PartyW9) });
      if (merged?.federalTaxClassification === 'llc' && !merged.llcTaxClassification) {
        throw new VendorTaxError('llcTaxClassification (C, S or P) is required for an LLC');
      }
      if (merged?.llcTaxClassification && merged.federalTaxClassification !== 'llc') delete merged.llcTaxClassification;
      columns.w9 = merged;
    }
  }

  // TIN
  // A blank value means "unchanged" for the write-only fields; only null removes them.
  const tinValue = input.tin === '' ? undefined : input.tin;
  const accountValue = input.achAccountNumber === '' ? undefined : input.achAccountNumber;
  const wantsTin = tinValue !== undefined;
  const typeGiven = input.tinType !== undefined;
  const touchesSecrets = wantsTin || accountValue !== undefined;
  const keyring = touchesSecrets ? requireKeyring(env) : null;
  const stored: PartySensitive = existing?.sensitiveEncrypted && keyring ? await readSensitive(existing, keyring) : {};
  const next: PartySensitive = { ...stored };

  if (typeGiven && !wantsTin) {
    if (input.tinType !== null && existing?.tinLast4 && input.tinType !== existing.tinType) {
      throw new VendorTaxError('Send the TIN together with tinType: the stored TIN was validated for another type');
    }
    if (input.tinType === null && existing?.tinLast4) {
      throw new VendorTaxError('Remove the TIN (tin: null) together with its type');
    }
    columns.tinType = input.tinType;
  }

  if (wantsTin) {
    if (tinValue === null) {
      if (stored.tin || existing?.tinLast4) {
        tinChanged = true;
        changes.tin = { old: 'on file', new: null };
      }
      delete next.tin;
      columns.tinLast4 = null;
      columns.tinType = input.tinType === undefined ? null : input.tinType;
    } else {
      const type = input.tinType ?? (isTinType(existing?.tinType) ? (existing!.tinType as TinType) : null);
      if (!type) throw new VendorTaxError('tinType (ein, ssn or itin) is required with a TIN');
      const check = validateTin(type, tinValue);
      if (!check.valid) throw new VendorTaxError(check.error ?? 'The TIN is not valid');
      const digits = digitsOnly(check.formatted ?? tinValue);
      if (digits !== stored.tin || type !== existing?.tinType) {
        tinChanged = true;
        changes.tin = { old: existing?.tinLast4 ? 'on file' : null, new: 'changed' };
      }
      next.tin = digits;
      columns.tinType = type;
      columns.tinLast4 = tinLast4(digits);
    }
    if (tinChanged) {
      // A new TIN has to be matched again.
      columns.tinMatchStatus = null;
      columns.tinMatchedAt = null;
    }
  }

  // ACH details
  const routingBefore = existing?.achRoutingNumber ?? null;
  let routingAfter = routingBefore;
  if (input.achRoutingNumber !== undefined) {
    if (input.achRoutingNumber === null || input.achRoutingNumber === '') {
      routingAfter = null;
    } else {
      const check = validateRoutingNumber(input.achRoutingNumber);
      if (!check.valid) throw new VendorTaxError(check.error ?? 'The routing number is not valid');
      routingAfter = check.formatted ?? digitsOnly(input.achRoutingNumber);
    }
    columns.achRoutingNumber = routingAfter;
    if (routingAfter !== routingBefore) bankDetailsChanged = true;
  }

  if (accountValue !== undefined) {
    if (accountValue === null) {
      if (stored.achAccountNumber || existing?.achAccountLast4) bankDetailsChanged = true;
      delete next.achAccountNumber;
      columns.achAccountLast4 = null;
    } else {
      const digits = digitsOnly(accountValue);
      if (!/^\d{4,17}$/.test(digits) || /[^\d\s-]/.test(accountValue)) {
        throw new VendorTaxError('The account number must have 4 to 17 digits');
      }
      if (digits !== stored.achAccountNumber) bankDetailsChanged = true;
      next.achAccountNumber = digits;
      columns.achAccountLast4 = digits.slice(-4);
    }
  }

  if (input.achAccountType !== undefined) {
    columns.achAccountType = input.achAccountType;
    if (input.achAccountType !== (existing?.achAccountType ?? null)) bankDetailsChanged = true;
  }

  if (bankDetailsChanged) {
    changes.bankDetails = { old: existing?.achAccountLast4 || routingBefore ? 'on file' : null, new: 'changed' };
    const routingNow = columns.achRoutingNumber !== undefined ? columns.achRoutingNumber : existing?.achRoutingNumber;
    const accountNow = columns.achAccountLast4 !== undefined ? columns.achAccountLast4 : existing?.achAccountLast4;
    const hasDetails = Boolean(routingNow) || Boolean(accountNow);
    // Removing every detail leaves nothing to verify.
    columns.bankDetailsChangedAt = hasDetails ? new Date() : null;
    columns.bankDetailsVerifiedAt = null;
    columns.bankDetailsVerifiedBy = null;
  }

  if (keyring && JSON.stringify(stored) !== JSON.stringify(next)) {
    columns.sensitiveEncrypted = await seal(next, keyring);
  }

  return { columns, changes, tinChanged, bankDetailsChanged };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Derived, display-safe tax fields to add to a contact view. */
export function vendorTaxDerived(party: PartyRow) {
  const tinType = isTinType(party.tinType) ? party.tinType : undefined;
  return {
    hasTin: Boolean(party.tinLast4),
    tinMasked: party.tinLast4 ? maskTin(party.tinLast4, tinType) : null,
    hasAchAccount: Boolean(party.achAccountLast4),
    /** Payment runs hold this vendor until someone verifies the bank details. */
    bankDetailsNeedVerification: Boolean(party.achRoutingNumber && party.achAccountLast4 && !party.bankDetailsVerifiedAt),
  };
}

/** Fields that must not reach entity events (webhooks, workflows, AI agents). */
export const TAX_EVENT_STRIP: readonly string[] = [
  'sensitiveEncrypted',
  'tinLast4',
  'tinMasked',
  'achRoutingNumber',
  'achAccountLast4',
  'w9',
];

export function stripTaxFieldsForEvent<T extends Record<string, unknown>>(view: T): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...view };
  for (const key of TAX_EVENT_STRIP) delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

export class SecretNotFoundError extends Error {
  constructor(readonly field: PartySecretField) {
    super(field === 'tin' ? 'This vendor has no TIN on file' : 'This vendor has no ACH account number on file');
    this.name = 'SecretNotFoundError';
  }
}

/**
 * Decrypt one stored secret for an authorized reveal. The reveal is logged
 * first, and a failed log write refuses it: no log row, no reveal.
 */
export async function revealPartySecret(
  db: Database,
  env: KeyEnv,
  args: { party: PartyRow; field: PartySecretField; userId: string; reason?: string | null; entityId?: string | null },
): Promise<string> {
  const keyring = requireKeyring(env);
  const blob = await readSensitive(args.party, keyring);
  const value = args.field === 'tin' ? blob.tin : blob.achAccountNumber;
  if (!value) throw new SecretNotFoundError(args.field);

  await db.insert(schema.taxIdReveals).values({
    id: generateId('tir'),
    entityId: args.entityId ?? null,
    subjectType: 'party',
    subjectId: args.party.id,
    field: args.field,
    revealedBy: args.userId,
    reason: args.reason ?? null,
  });
  return value;
}
