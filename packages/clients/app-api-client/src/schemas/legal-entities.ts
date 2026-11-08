/**
 * Legal entities (core, `/api/legal-entities`): request schemas and response
 * types shared by app-api, books-api, hr-api, the platform and mobile.
 * docs/plans/legal-entities.md. Zod v3.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

/** Apps that extend a legal entity. WeldBooks needs to be enabled per entity; WeldHR works with any entity. */
export const LEGAL_ENTITY_APPS = ['weldbooks', 'weldhr'] as const;
export const legalEntityAppSchema = z.enum(LEGAL_ENTITY_APPS);
export type LegalEntityApp = z.infer<typeof legalEntityAppSchema>;

const countryCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), 'Use a two-letter country code');

const currencyCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{3}$/.test(v), 'Use a three-letter currency code');

const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const legalEntityAddressSchema = z.object({
  line1: z.string().trim().max(255).optional(),
  line2: z.string().trim().max(255).optional(),
  houseNumber: z.string().trim().max(20).optional(),
  houseNumberAddition: z.string().trim().max(20).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(2).optional(),
  county: z.string().trim().max(120).optional(),
});
export type LegalEntityAddressInput = z.infer<typeof legalEntityAddressSchema>;

export const legalEntityContactSchema = z.object({
  email: z.string().trim().email().max(255).optional().or(z.literal('')),
  phone: z.string().trim().max(50).optional(),
  website: z.string().trim().max(500).optional(),
  contactPerson: z
    .object({
      firstName: z.string().trim().max(120).optional(),
      lastName: z.string().trim().max(120).optional(),
    })
    .optional(),
});

export const legalEntityBrandingSchema = z.object({
  logoUrl: z.string().trim().max(500).optional().or(z.literal('')),
  primaryColor: z.string().trim().max(20).optional(),
  accentColor: z.string().trim().max(20).optional(),
});

export const fiscalYearConfigSchema = z.object({
  type: z.literal('fifty_two_fifty_three'),
  endMonth: z.number().int().min(1).max(12),
  weekday: z.number().int().min(0).max(6),
  rule: z.enum(['last', 'nearest']),
});

// ---------------------------------------------------------------------------
// Legal entity
// ---------------------------------------------------------------------------

export const createLegalEntitySchema = z.object({
  name: z.string().trim().min(1).max(255),
  legalName: optionalText(255),
  /** Trading (doing-business-as) name. */
  dba: optionalText(255),
  /** Legal form from the country's catalog (bv, nv, eenmanszaak, llc, c_corp, ...). */
  entityType: optionalText(20),
  /** Country of registration. */
  jurisdictionCode: countryCode,
  baseCurrency: currencyCode,
  locale: z.string().trim().min(2).max(10).optional(),
  timezone: z.string().trim().max(50).optional(),
  address: legalEntityAddressSchema.nullish(),
  contact: legalEntityContactSchema.nullish(),
  branding: legalEntityBrandingSchema.nullish(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  fiscalYearConfig: fiscalYearConfigSchema.nullish(),
  /** US: sole_proprietor | disregarded | partnership | s_corp | c_corp | exempt. */
  taxClassification: optionalText(20),
  /** Make it the workspace default. The first entity always becomes the default. */
  isDefault: z.boolean().optional(),
});
export type CreateLegalEntityInput = z.infer<typeof createLegalEntitySchema>;

/** Everything optional; the default and archive state have their own routes. */
export const updateLegalEntitySchema = createLegalEntitySchema.omit({ isDefault: true }).partial();
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntitySchema>;

export const listLegalEntitiesQuerySchema = z.object({
  /** Only entities this app is enabled for (WeldBooks needs its extension row). */
  app: legalEntityAppSchema.optional(),
  /** Include archived (`isActive = false`) entities. */
  includeArchived: z.enum(['true', 'false']).optional(),
});

/** Where the caller's access to an entity comes from (see "Per-entity access" in the plan). */
export type LegalEntityAccessSource = 'owner' | 'manager' | 'member' | 'open';

export interface LegalEntityMyAccess {
  source: LegalEntityAccessSource;
  /** The role the caller acts with inside the entity; null = their workspace role. */
  roleId: string | null;
  roleName: string | null;
}

export interface LegalEntity {
  id: string;
  name: string;
  legalName: string | null;
  dba: string | null;
  entityType: string | null;
  jurisdictionCode: string;
  baseCurrency: string;
  locale: string;
  timezone: string | null;
  address: LegalEntityAddressInput | null;
  contact: z.infer<typeof legalEntityContactSchema> | null;
  branding: z.infer<typeof legalEntityBrandingSchema> | null;
  fiscalYearStart: number | null;
  fiscalYearConfig: z.infer<typeof fiscalYearConfigSchema> | null;
  taxClassification: string | null;
  isDefault: boolean;
  isActive: boolean;
  accessRestricted: boolean;
  /** Apps enabled for this entity. */
  enabledApps: LegalEntityApp[];
  createdAt: string;
  updatedAt: string;
  /** Present on reads made for the signed-in member. */
  myAccess?: LegalEntityMyAccess;
}

export interface LegalEntityUsage {
  app: LegalEntityApp;
  enabled: boolean;
  /** The app holds data for this entity, so it cannot be deleted. */
  hasData: boolean;
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const LEGAL_ENTITY_REGISTRATION_TYPES = [
  'vat',
  'company_registration',
  'rsin',
  'ein',
  'gstin',
  'pan',
  'eori',
  'nl_payroll_tax',
  'us_state_withholding',
  'us_state_unemployment',
  'other',
] as const;
export const registrationTypeSchema = z.enum(LEGAL_ENTITY_REGISTRATION_TYPES);
export type LegalEntityRegistrationType = z.infer<typeof registrationTypeSchema>;

/** Number formats per type. Types without an entry accept any 1–64 characters. */
const REGISTRATION_FORMATS: Partial<Record<LegalEntityRegistrationType, { pattern: RegExp; message: string }>> = {
  vat: { pattern: /^[A-Z]{2}[0-9A-Z+*.]{2,13}$/, message: 'Use the VAT number with its country prefix, e.g. NL123456789B01' },
  rsin: { pattern: /^\d{9}$/, message: 'An RSIN has nine digits' },
  ein: { pattern: /^\d{2}-?\d{7}$/, message: 'An EIN has nine digits (12-3456789)' },
  gstin: { pattern: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, message: 'A GSTIN has 15 characters, e.g. 27AAPFU0939F1ZV' },
  pan: { pattern: /^[A-Z]{5}\d{4}[A-Z]$/, message: 'A PAN has 10 characters, e.g. AAPFU0939F' },
  eori: { pattern: /^[A-Z]{2}[0-9A-Z]{1,15}$/, message: 'Use the EORI number with its country prefix' },
  nl_payroll_tax: { pattern: /^\d{9}L\d{2}$/, message: 'A loonheffingennummer looks like 123456789L01' },
};

/** Uppercase and strip spaces and dots (dashes stay: EINs keep them). */
export function normalizeRegistrationNumber(type: LegalEntityRegistrationType, raw: string): string {
  const cleaned = raw.trim().toUpperCase().replaceAll(/\s/g, '');
  return type === 'vat' || type === 'nl_payroll_tax' || type === 'rsin' ? cleaned.replaceAll('.', '') : cleaned;
}

/** Null when the number is valid for its type, else the reason. */
export function registrationNumberError(type: LegalEntityRegistrationType, number: string): string | null {
  const format = REGISTRATION_FORMATS[type];
  if (!format) return number.length > 0 && number.length <= 64 ? null : 'Enter a number';
  return format.pattern.test(number) ? null : format.message;
}

const registrationBase = z.object({
  type: registrationTypeSchema,
  number: z.string().trim().min(1).max(64),
  country: countryCode.nullish(),
  /** US state or IN state code for state-level registrations. */
  region: z.string().trim().max(10).nullish(),
  label: optionalText(120),
  validFrom: z.string().date().nullish(),
  validTo: z.string().date().nullish(),
  isPrimary: z.boolean().optional(),
});

export const createRegistrationSchema = registrationBase.superRefine((value, ctx) => {
  const error = registrationNumberError(value.type, normalizeRegistrationNumber(value.type, value.number));
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['number'], message: error });
});
export type CreateRegistrationInput = z.infer<typeof createRegistrationSchema>;

/** The type cannot change; the number is checked against the stored type by the service. */
export const updateRegistrationSchema = registrationBase.omit({ type: true }).partial();
export type UpdateRegistrationInput = z.infer<typeof updateRegistrationSchema>;

export interface LegalEntityRegistration {
  id: string;
  entityId: string;
  type: LegalEntityRegistrationType;
  number: string;
  country: string | null;
  region: string | null;
  label: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export const BANK_ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'money_market', 'line_of_credit'] as const;

/** ABA routing number check: nine digits, weights 3-7-1, sum divisible by 10. */
export function isValidAbaRouting(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...value].reduce((total, digit, i) => total + Number(digit) * (weights[i] ?? 0), 0);
  return sum % 10 === 0;
}

/** IBAN mod-97 check on the compact form. */
export function isValidIban(raw: string): boolean {
  const iban = raw.replaceAll(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

const bankAccountBase = z.object({
  name: z.string().trim().min(1).max(255),
  accountHolderName: optionalText(255),
  iban: z
    .string()
    .trim()
    .transform((v) => v.replaceAll(/\s/g, '').toUpperCase())
    .refine((v) => v === '' || isValidIban(v), 'This IBAN is not valid')
    .nullish(),
  bic: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === '' || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), 'This BIC is not valid')
    .nullish(),
  bankName: optionalText(255),
  currency: currencyCode.optional(),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullish(),
  routingNumber: z
    .string()
    .trim()
    .refine((v) => v === '' || isValidAbaRouting(v), 'This routing number is not valid')
    .nullish(),
  /** Write-only. Stored encrypted; responses carry only the last four digits. */
  accountNumber: z
    .string()
    .transform((v) => v.replaceAll(/[\s-]/g, ''))
    .refine((v) => v === '' || /^[0-9A-Za-z]{4,34}$/.test(v), 'Enter 4 to 34 letters or digits')
    .nullish(),
  /** NACHA origination: immediate origin and destination, company id, balanced file. */
  achSettings: z.record(z.unknown()).nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createBankAccountSchema = bankAccountBase;
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export const updateBankAccountSchema = bankAccountBase.partial();
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;

export const revealBankAccountSchema = z.object({
  reason: z.string().trim().max(255).optional(),
});

/** A core bank account as the API returns it: never the encrypted number. */
export interface LegalEntityBankAccount {
  id: string;
  entityId: string;
  name: string;
  accountHolderName: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  currency: string | null;
  accountType: string | null;
  routingNumber: string | null;
  accountNumberLast4: string | null;
  hasAccountNumber: boolean;
  achSettings: Record<string, unknown> | null;
  isDefault: boolean;
  isActive: boolean;
  /** WeldBooks has a settings row for it (it is in the ledger). */
  inWeldbooks: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Per-entity access
// ---------------------------------------------------------------------------

export const updateEntityAccessSchema = z.object({
  /** Only listed members (plus owners and access managers) see a restricted entity. */
  restricted: z.boolean(),
});

export const setEntityMemberSchema = z.object({
  /** A `roles` row (system Admin/Member/Viewer or custom). Null = the member's workspace role. */
  roleId: z.string().trim().min(1).max(30).nullable(),
});
export type SetEntityMemberInput = z.infer<typeof setEntityMemberSchema>;

export interface LegalEntityAccessMember {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  /** Their workspace role, for context in the UI. */
  workspaceRole: string;
  workspaceRoleName: string | null;
  roleId: string | null;
  roleName: string | null;
  grantedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LegalEntityAccess {
  entityId: string;
  restricted: boolean;
  members: LegalEntityAccessMember[];
}

/** The signed-in member's effective access inside one entity (`GET /:id/my-access`). */
export interface LegalEntityEffectiveAccess {
  entityId: string;
  source: LegalEntityAccessSource;
  roleId: string | null;
  roleName: string | null;
  /** Effective permission keys inside this entity (role ∪ teams ∪ personal extras). */
  permissions: string[];
  denies: string[];
  isOwner: boolean;
}
