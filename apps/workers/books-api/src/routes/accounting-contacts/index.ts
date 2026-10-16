/**
 * Accounting contact routes — flat /api/accounting-contacts/* surface backed
 * by `parties` (the unified CRM/accounting counterparty layer — contacts and
 * customers are the same table since the Companies + People refactor).
 *
 * Ported from apps/api-worker/src/routes/accounting/contacts.ts:
 *   - CRUD with accounting roles (customer | supplier | both | none)
 *   - GET /:id/invoices, /:id/bills, /:id/balance (receivable/payable tracking)
 *   - POST /import-from-crm (no-op stub — same-table model needs no import)
 *
 * A contact wraps a real CRM identity. Identity facts (name, email, phone,
 * VAT and registration numbers, notes) live on the wrapped `companies` or
 * `people` row and are written through `@weldsuite/crm-domain`; the party
 * row keeps the accounting fields (role, addresses, payment terms, currency,
 * bank details, default ledger accounts, SEPA mandate). Reads merge both.
 *
 * Which identity a new contact gets: the `kind` the client chose ('company'
 * or 'person'), linking the existing CRM record given as `companyId` /
 * `personId` instead of creating one. Without a `kind`, a company when the
 * payload has a company name, a VAT or registration number (a person row has
 * no tax ids), or no first/last name; otherwise a person. A contact's kind
 * never changes. Parties created by the old route wrap nothing (`kind` null);
 * their first update creates the identity and links it.
 *
 * A company contact can have a contact person (`contactPerson`): a CRM person
 * stored as the company's billing contact (services/billing-contact.ts).
 *
 * Also exposes POST /:id/promote-role which updates the CRM-level `parties.role`
 * field when a counterparty gains its first invoice (→ customer) or first bill
 * (→ supplier). The promotion is idempotent and only moves the role forward:
 *   none + customer → customer
 *   none + supplier → supplier
 *   customer/supplier + other → both
 *   both + * → both (no-op)
 *
 * US vendor tax data (docs/plans/weldbooks-us.md section 8) rides on the same
 * payloads: 1099 flags and defaults, the W-9, a write-only TIN and ACH account
 * number (encrypted into `parties.sensitive_encrypted`, see
 * services/vendor-tax-data.ts), `taxUse` and backup withholding. Responses
 * carry the last four digits only. Full values come back through
 * POST /:id/reveal-tin and /:id/reveal-ach-account (`tax_ids:reveal`, logged
 * in `tax_id_reveals`); POST /:id/verify-bank-details (`banking:manage`)
 * lifts the payment hold that a bank-detail change puts on a vendor.
 *
 * Deleting is refused (409 CONTACT_IN_USE) once the contact is referenced by
 * any document, payment, ledger line or 1099; POST /:id/archive and
 * /:id/unarchive hide a contact from lists and pickers instead (lists take
 * ?archived=only|include).
 *
 * Creating a person contact whose email belongs to another CRM person is
 * refused (409 PERSON_EMAIL_EXISTS with `existingPerson`) unless that person is
 * a bare mail identity or has the same name; the client then resubmits with
 * `linkPersonId` or `createSeparatePerson: true`.
 *
 * Permissions: invoices:read | invoices:create | invoices:update; deleting and
 * archiving take customers:delete|suppliers:delete and customers:update|suppliers:update.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { formatTin } from '@weldsuite/books-domain/us-compliance/form-1099-pdf-data';
import { isTinType } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import {
  buildVendorTaxChange,
  revealPartySecret,
  SecretNotFoundError,
  stripTaxFieldsForEvent,
  vendorTaxDerived,
  vendorTaxFields,
  VendorTaxError,
  VendorTaxKeyError,
  type PartySecretField,
} from '../../services/vendor-tax-data';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { validateGstin } from '@weldsuite/books-domain/jurisdictions/in';
import { validateCnpjOrCpf, validateCpf } from '@weldsuite/books-domain/jurisdictions/br';
import { checkVatNumberFormat, ibanProblem, IBAN_LENGTHS, normalizeIban } from '@weldsuite/books-domain/identifiers';
import { resolveEntityId } from '../../lib/entity-context';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import {
  createCompany,
  isValidWorkspaceMember,
  updateCompany,
} from '@weldsuite/crm-domain/companies';
import {
  createPerson,
  PersonDuplicateEmailError,
  updatePerson,
} from '@weldsuite/crm-domain/people';
import { describeUsage, getContactUsage, usedReferences } from '../../services/contact-usage';
import {
  clearBillingContact,
  loadBillingContacts,
  setBillingContact,
} from '../../services/billing-contact';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.parties;

/**
 * Deleting or archiving a contact is a decision about a customer or a
 * supplier, so it takes the books' customer / supplier permissions (weldbooks
 * `customers:*` and `suppliers:*`), not the invoice permissions that guard
 * everything else on this surface.
 */
const CONTACT_DELETE_PERMISSIONS = ['customers:delete', 'suppliers:delete'] as const;
const CONTACT_ARCHIVE_PERMISSIONS = ['customers:update', 'suppliers:update'] as const;

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type PartyRow = typeof schema.parties.$inferSelect;
type CompanyRow = typeof schema.companies.$inferSelect;
type PersonRow = typeof schema.people.$inferSelect;

/**
 * Either address shape: the shared `PostalAddress` (line1, line2, city,
 * state, postalCode, country, county) or the legacy Dutch one (street +
 * houseNumber, province). Stored normalized to the shared shape.
 */
const addressSchema = z.object({
  line1: z.string().max(255),
  line2: z.string().max(255),
  city: z.string().max(100),
  state: z.string().max(100),
  postalCode: z.string().max(20),
  country: z.string().max(100),
  county: z.string().max(100),
  street: z.string().max(255),
  houseNumber: z.string().max(20),
  province: z.string().max(100),
}).partial().nullable().optional();

/**
 * The contact person of a company contact. With `personId` it is that CRM
 * person (and the other fields update them); without, a new person is created
 * (or the CRM person with that email reused). `null` removes the contact person.
 */
const contactPersonSchema = z.object({
  personId: z.string().max(30).optional(),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
}).nullable().optional();

const createContactSchema = z.object({
  role: z.enum(['customer', 'supplier', 'both', 'none']).optional(),
  /** Which identity the contact wraps. Fixed once the contact has one. */
  kind: z.enum(['company', 'person']).optional(),
  /** Link this existing CRM company instead of creating one. */
  companyId: z.string().max(30).optional(),
  /** Link this existing CRM person instead of creating one. */
  personId: z.string().max(30).optional(),
  contactPerson: contactPersonSchema,
  fullName: z.string().min(1).max(255),
  companyName: z.string().max(255).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().max(255).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  vatNumber: z.string().max(50).nullable().optional(),
  registrationNumber: z.string().max(100).nullable().optional(),
  iban: z.string().max(34).nullable().optional(),
  bic: z.string().max(11).nullable().optional(),
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  paymentTermsDays: z.number().int().min(0).max(3650).nullable().optional(),
  currency: z.string().length(3).optional(),
  defaultRevenueAccountId: z.string().max(30).nullable().optional(),
  defaultExpenseAccountId: z.string().max(30).nullable().optional(),
  crmCustomerId: z.string().max(30).optional(),
  crmContactId: z.string().max(30).optional(),
  creditLimit: z.string().optional(),
  notes: z.string().max(10000).nullable().optional(),
  tags: z.array(z.string()).optional(),
  sepaMandate: z.object({
    mandateId: z.string().optional(),
    signatureDate: z.string().optional(),
    type: z.enum(['one-off', 'recurring']).optional(),
  }).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Brazil: the counterparty's municipal registration and the flags the tax
   * engine needs. The CNPJ is `vatNumber` and the Inscrição Estadual
   * `registrationNumber` (of the company); a person's CPF is kept in `taxId`.
   */
  brFiscal: z
    .object({
      inscricaoMunicipal: z.string().trim().max(20).optional(),
      icmsContributor: z.boolean().optional(),
      simplesNacional: z.boolean().optional(),
      municipalityCode: z.string().regex(/^\d{7}$/, 'The IBGE municipality code has 7 digits').optional(),
      taxId: z.string().trim().max(18).optional(),
    })
    .strict()
    .nullable()
    .optional(),
  /**
   * Answers a 409 `PERSON_EMAIL_EXISTS`: a CRM person already has this email.
   * `linkPersonId` makes the contact wrap that person (their existing facts
   * stay, only empty fields are filled); `createSeparatePerson` creates a new
   * person with the same email instead. Neither is ever assumed.
   */
  linkPersonId: z.string().max(30).optional(),
  createSeparatePerson: z.boolean().optional(),
  ...vendorTaxFields,
});

/**
 * Fields a blank string clears on update (sent as null). On create, and for
 * every other field, a blank string means "not provided" and is dropped.
 */
const CLEARABLE_FIELDS = new Set([
  'email',
  'phone',
  'vatNumber',
  'taxNumber',
  'registrationNumber',
  'kvkNumber',
  'iban',
  'bic',
  'notes',
  'defaultRevenueAccountId',
  'defaultExpenseAccountId',
  'achRoutingNumber',
  'default1099Box',
  'default1099Form',
  'taxUse',
  'achAccountType',
]);

/**
 * The platform contact form posts `name`, `taxNumber` and `kvkNumber`, and
 * sends untouched optional inputs as "". Map those onto the schema's field
 * names and drop blank strings, so an empty email doesn't fail `.email()`.
 * On update a blank clearable field becomes null, so emptying an input in
 * the edit form clears the stored value.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A contact person's blank inputs are cleared values (null), so `.email()`
 * never sees ""; a blank `personId` means a new person and is dropped.
 */
function blanksToNull(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const blank = typeof value === 'string' && value.trim() === '';
    if (blank && key === 'personId') continue;
    body[key] = blank ? null : value;
  }
  return body;
}

function normalizeContactPayload(input: unknown, mode: 'create' | 'update'): unknown {
  if (!isPlainObject(input)) return input;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'contactPerson' && isPlainObject(value)) {
      body[key] = blanksToNull(value);
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      if (mode === 'update' && CLEARABLE_FIELDS.has(key)) body[key] = null;
      continue;
    }
    body[key] = value;
  }
  const aliases: Array<[alias: string, field: string]> = [
    ['name', 'fullName'],
    ['taxNumber', 'vatNumber'],
    ['kvkNumber', 'registrationNumber'],
  ];
  for (const [alias, field] of aliases) {
    if (body[field] === undefined && body[alias] !== undefined) body[field] = body[alias];
    delete body[alias];
  }
  return body;
}

const createContactBody = z.preprocess(
  (input) => normalizeContactPayload(input, 'create'),
  createContactSchema,
);
const updateContactBody = z.preprocess(
  (input) => normalizeContactPayload(input, 'update'),
  createContactSchema.partial(),
);

type ContactPayload = z.infer<typeof updateContactBody>;

/** Return validation failures in the standard `{ error: { code, message } }` shape. */
const contactValidationHook = (
  result: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } },
  c: Parameters<typeof error.badRequest>[0],
) => {
  if (!result.success) {
    const message = (result.error?.issues ?? [])
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return error.badRequest(c, message || 'Invalid request body');
  }
};

// ---------------------------------------------------------------------------
// Merged view: party columns + the wrapped identity's facts
// ---------------------------------------------------------------------------

/** `parties.paymentTerms` is free text; WeldBooks writes the number of days. */
function parsePaymentTermsDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(?:net\s*)?(\d{1,4})\s*(?:days?)?\s*$/i.exec(value);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function personPhone(person: PersonRow): string | null {
  return person.directPhone || person.mobilePhone || null;
}

/** A company contact's contact person, as clients read it. */
function toContactPersonView(person: PersonRow) {
  return {
    personId: person.id,
    name: person.displayName,
    firstName: person.firstName || null,
    lastName: person.lastName || null,
    email: person.email || null,
    phone: personPhone(person),
  };
}

/** The contact as clients read it. Empty identity values come back as null. */
function toContactView(
  party: PartyRow,
  company?: CompanyRow | null,
  person?: PersonRow | null,
  billingContact?: PersonRow | null,
) {
  const { billingAddress, shippingAddress, ...partyColumns } = omitSensitive('parties', party);
  const vatNumber = company?.vatNumber || null;
  const registrationNumber = company?.registrationNumber || null;
  return {
    ...partyColumns,
    ...vendorTaxDerived(party),
    name: party.displayName ?? company?.displayName ?? person?.displayName ?? '',
    companyName: company?.name ?? null,
    firstName: person?.firstName ?? null,
    lastName: person?.lastName ?? null,
    email: (company ? company.email : person?.email) || null,
    phone: (company ? company.phone : person && personPhone(person)) || null,
    contactPerson: company && billingContact ? toContactPersonView(billingContact) : null,
    vatNumber,
    registrationNumber,
    notes: (company ? company.notes : person?.notes) || null,
    /** Legacy names the current contact pages read. */
    taxNumber: vatNumber,
    kvkNumber: registrationNumber,
    paymentTermsDays: parsePaymentTermsDays(party.paymentTerms),
    billingAddress: normalizePostalAddress(billingAddress),
    shippingAddress: normalizePostalAddress(shippingAddress),
  };
}

type ContactView = ReturnType<typeof toContactView>;

/** Load the companies, people and billing contacts a page of parties wraps, a few queries total. */
async function loadIdentities(db: Database, rows: PartyRow[]) {
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((id): id is string => !!id))];
  const personIds = [...new Set(rows.map((r) => r.personId).filter((id): id is string => !!id))];
  const [companies, people, billingContacts] = await Promise.all([
    companyIds.length > 0
      ? db.select().from(schema.companies).where(inArray(schema.companies.id, companyIds))
      : Promise.resolve([] as CompanyRow[]),
    personIds.length > 0
      ? db.select().from(schema.people).where(inArray(schema.people.id, personIds))
      : Promise.resolve([] as PersonRow[]),
    loadBillingContacts(db, companyIds),
  ]);
  return {
    companies: new Map(companies.map((row) => [row.id, row])),
    people: new Map(people.map((row) => [row.id, row])),
    billingContacts,
  };
}

function viewWithIdentities(party: PartyRow, identities: Awaited<ReturnType<typeof loadIdentities>>) {
  return toContactView(
    party,
    party.companyId ? identities.companies.get(party.companyId) : null,
    party.personId ? identities.people.get(party.personId) : null,
    party.companyId ? identities.billingContacts.get(party.companyId) : null,
  );
}

async function loadContactView(db: Database, id: string): Promise<ContactView | null> {
  const [party] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!party) return null;
  return viewWithIdentities(party, await loadIdentities(db, [party]));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type IdentityKind = 'company' | 'person';

const IDENTITY_FIELDS = [
  'fullName',
  'companyName',
  'firstName',
  'lastName',
  'email',
  'phone',
  'vatNumber',
  'registrationNumber',
  'notes',
  'tags',
] as const;

function touchesIdentity(data: ContactPayload): boolean {
  return IDENTITY_FIELDS.some((field) => data[field] !== undefined);
}

/**
 * A company when there's a company name or a tax identifier (people carry
 * none), or no first/last name to build a person from; otherwise a person.
 */
function chooseIdentityKind(data: ContactPayload): IdentityKind {
  if (data.companyName || data.vatNumber || data.registrationNumber) return 'company';
  if (data.firstName || data.lastName) return 'person';
  return 'company';
}

/** The kind the client chose (or implied by the record it links), else the one the fields suggest. */
function resolveIdentityKind(data: ContactPayload): IdentityKind {
  if (data.kind) return data.kind;
  if (data.companyId) return 'company';
  if (data.personId) return 'person';
  return chooseIdentityKind(data);
}

const PERSON_TAX_ID_MESSAGE =
  'This contact is a person, and VAT and registration numbers are stored on a company. Create the contact as a company to record them.';

/** Refuse the fields that don't fit a contact of this kind. */
function assertFitsKind(kind: IdentityKind, data: ContactPayload): void {
  if (kind === 'company') {
    if (data.personId) {
      throw new ContactIdentityError('badRequest', 'personId: a company contact links a CRM company (companyId), not a person.');
    }
    return;
  }
  if (data.companyId) {
    throw new ContactIdentityError('badRequest', 'companyId: a person contact links a CRM person (personId), not a company.');
  }
  if (data.vatNumber || data.registrationNumber) throw new ContactIdentityError('badRequest', PERSON_TAX_ID_MESSAGE);
  if (data.contactPerson) {
    throw new ContactIdentityError('badRequest', 'contactPerson: only a company contact has a contact person.');
  }
}

function splitFullName(fullName: string | undefined): { firstName?: string; lastName?: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.length > 0 ? rest.join(' ') : undefined };
}

/**
 * First and last name for a person contact. Given neither, the full name is
 * split on its first space; given one, the other is what the full name has
 * around it ("Mary Ann Smith" with last name "Smith" gives "Mary Ann").
 */
function personNames(data: ContactPayload): { firstName?: string; lastName?: string } {
  const fullName = data.fullName?.trim();
  if (data.firstName === undefined && data.lastName === undefined) return splitFullName(fullName);
  let { firstName, lastName } = data;
  if (fullName && firstName === undefined && lastName && fullName.endsWith(lastName)) {
    firstName = fullName.slice(0, -lastName.length).trim() || undefined;
  }
  if (fullName && lastName === undefined && firstName && fullName.startsWith(firstName)) {
    lastName = fullName.slice(firstName.length).trim() || undefined;
  }
  return { firstName, lastName };
}

/** The service inputs take '' for a cleared text column. */
function clearable(value: string | null | undefined): string | undefined {
  return value === null ? '' : value;
}

/**
 * Company name fields. The contact's `name` is what lists show: with a
 * separate company name it becomes the trading name (the display name), and
 * the company name stays the legal name.
 */
function companyNameFields(
  data: ContactPayload,
  existing: CompanyRow | null,
): { name?: string; tradingName?: string } {
  if (data.companyName) {
    if (data.fullName === undefined) return { name: data.companyName };
    return {
      name: data.companyName,
      tradingName: data.fullName !== data.companyName ? data.fullName : '',
    };
  }
  if (data.fullName === undefined) return {};
  if (existing?.tradingName) {
    return { tradingName: data.fullName !== existing.name ? data.fullName : '' };
  }
  return { name: data.fullName };
}

function companyIdentityInput(data: ContactPayload, existing: CompanyRow | null) {
  return {
    ...companyNameFields(data, existing),
    email: clearable(data.email),
    phone: clearable(data.phone),
    vatNumber: clearable(data.vatNumber),
    registrationNumber: clearable(data.registrationNumber),
    notes: clearable(data.notes),
    tags: data.tags,
  };
}

function personIdentityInput(data: ContactPayload) {
  return {
    ...personNames(data),
    fullName: data.fullName,
    email: clearable(data.email),
    directPhone: clearable(data.phone),
    notes: clearable(data.notes),
    tags: data.tags,
  };
}

/** Drop undefined keys so a partial update leaves untouched columns alone. */
function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Drop undefined and blank values: a new identity has nothing to clear. */
function presentOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** Party (accounting) columns from the payload. */
function toPartyColumns(data: ContactPayload): Partial<typeof t.$inferInsert> {
  const record: Partial<typeof t.$inferInsert> = {};
  if (data.role !== undefined) record.role = data.role;
  if (data.billingAddress !== undefined) record.billingAddress = normalizePostalAddress(data.billingAddress);
  if (data.shippingAddress !== undefined) record.shippingAddress = normalizePostalAddress(data.shippingAddress);
  if (data.paymentTermsDays !== undefined) {
    record.paymentTerms = data.paymentTermsDays === null ? null : String(data.paymentTermsDays);
  }
  if (data.currency !== undefined) record.currency = data.currency.toUpperCase();
  if (data.iban !== undefined) record.iban = data.iban?.replace(/\s/g, '').toUpperCase() ?? null;
  if (data.bic !== undefined) record.bic = data.bic?.trim().toUpperCase() ?? null;
  if (data.defaultRevenueAccountId !== undefined) record.defaultRevenueAccountId = data.defaultRevenueAccountId;
  if (data.defaultExpenseAccountId !== undefined) record.defaultExpenseAccountId = data.defaultExpenseAccountId;
  if (data.sepaMandate !== undefined) record.sepaMandate = data.sepaMandate;
  if (data.brFiscal !== undefined) record.brFiscal = data.brFiscal;
  return record;
}

/** Raised when the identity can't be created or changed as asked. */
class ContactIdentityError extends Error {
  constructor(
    readonly status: 'conflict' | 'badRequest',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContactIdentityError';
  }
}

interface IdentityLink {
  kind: IdentityKind;
  companyId: string | null;
  personId: string | null;
  displayName: string;
}

async function ownerIdFor(c: AppContext, db: Database): Promise<string | undefined> {
  const userId = c.get('userId');
  return userId && (await isValidWorkspaceMember(db, userId)) ? userId : undefined;
}

function publishIdentityEvent(
  c: AppContext,
  kind: IdentityKind,
  action: 'created' | 'updated',
  row: CompanyRow | PersonRow,
): void {
  if (kind === 'company') {
    const company = row as CompanyRow;
    publishEntityEvent({
      c,
      entityType: 'company',
      entityId: company.id,
      action,
      data: {
        id: company.id,
        name: company.name,
        email: company.email,
        phone: company.phone,
        website: company.website,
        industry: company.industry,
        status: company.status,
      },
    });
    return;
  }
  const person = row as PersonRow;
  publishEntityEvent({
    c,
    entityType: 'person',
    entityId: person.id,
    action,
    data: {
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      fullName: person.fullName,
      displayName: person.displayName,
      email: person.email,
      title: person.title,
    },
  });
}

/** A CRM company or person is the identity of one contact at most. */
async function assertNotWrapped(db: Database, kind: IdentityKind, identityId: string): Promise<void> {
  const column = kind === 'company' ? t.companyId : t.personId;
  const [wrapped] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(column, identityId), isNull(t.deletedAt)))
    .limit(1);
  if (wrapped) {
    const message = kind === 'company'
      ? 'This company is already a customer or supplier.'
      : 'This person is already a customer or supplier.';
    throw new ContactIdentityError('conflict', message, { contactId: wrapped.id });
  }
}

/** Wrap an existing CRM company, writing the payload's identity fields to it. */
async function linkCompany(
  c: AppContext,
  db: Database,
  companyId: string,
  data: ContactPayload,
): Promise<IdentityLink> {
  const [existing] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), isNull(schema.companies.deletedAt)))
    .limit(1);
  if (!existing) throw new ContactIdentityError('badRequest', `companyId: company ${companyId} not found`);
  await assertNotWrapped(db, 'company', companyId);

  let company = existing;
  if (touchesIdentity(data)) {
    const result = await updateCompany(db, companyId, definedOnly(companyIdentityInput(data, existing)));
    if (result) {
      company = result.row;
      if (result.changes) publishIdentityEvent(c, 'company', 'updated', company);
    }
  }
  return { kind: 'company', companyId, personId: null, displayName: company.displayName };
}

/** Wrap an existing CRM person (bringing a mail-only one into the CRM), writing the payload's identity fields to it. */
async function linkPerson(
  c: AppContext,
  db: Database,
  personId: string,
  data: ContactPayload,
): Promise<IdentityLink> {
  const [existing] = await db
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.id, personId), isNull(schema.people.deletedAt)))
    .limit(1);
  if (!existing) throw new ContactIdentityError('badRequest', `personId: person ${personId} not found`);
  await assertNotWrapped(db, 'person', personId);

  const input = { ...definedOnly(personIdentityInput(data)), ...(existing.inCrm ? {} : { inCrm: true }) };
  const result = await updatePerson(db, personId, input as Parameters<typeof updatePerson>[2]);
  const person = result?.row ?? existing;
  if (result?.changes) publishIdentityEvent(c, 'person', 'updated', person);
  return { kind: 'person', companyId: null, personId, displayName: person.displayName };
}

/**
 * Create the CRM identity a contact wraps, or link the existing one the
 * payload names. A new person whose email already exists (often a mail-only
 * identity) is reused: its empty fields are filled in, unless another contact
 * already wraps it.
 */
async function createIdentity(
  c: AppContext,
  db: Database,
  data: ContactPayload & { fullName: string },
): Promise<IdentityLink> {
  const kind = resolveIdentityKind(data);
  assertFitsKind(kind, data);
  if (kind === 'company' && data.companyId) return linkCompany(c, db, data.companyId, data);
  if (kind === 'person' && data.personId) return linkPerson(c, db, data.personId, data);

  const ownerId = await ownerIdFor(c, db);
  // Seeds the CRM primary address; a fresh copy, since the identity schemas
  // type addresses as open records.
  const billing = normalizePostalAddress(data.billingAddress);
  const primaryAddress = billing ? { ...billing } : undefined;

  if (kind === 'company') {
    const input = presentOnly(companyIdentityInput(data, null));
    const company = await createCompany(db, {
      ...input,
      name: input.name ?? data.fullName,
      status: 'active',
      primaryAddress,
      ownerId,
    });
    publishIdentityEvent(c, 'company', 'created', company);
    return { kind, companyId: company.id, personId: null, displayName: company.displayName };
  }

  const input = presentOnly(personIdentityInput(data));

  // The user picked the person to link to.
  if (data.linkPersonId) {
    return linkExistingPerson(c, db, data.linkPersonId, input, primaryAddress);
  }

  try {
    const person = await createPerson(
      db,
      { ...input, primaryAddress, ownerId },
      { allowDuplicateEmail: data.createSeparatePerson === true },
    );
    publishIdentityEvent(c, 'person', 'created', person);
    return { kind, companyId: null, personId: person.id, displayName: person.displayName };
  } catch (err) {
    if (!(err instanceof PersonDuplicateEmailError)) throw err;
    const [existing] = await db.select().from(schema.people).where(eq(schema.people.id, err.existingPersonId)).limit(1);
    if (!existing) throw err;
    // Another contact already wraps this person: nothing to choose, it is a duplicate.
    await assertPersonNotWrapped(db, existing.id);
    // A bare mail identity (no name of its own) or the same person: reuse it quietly.
    if (isSamePerson(existing, personNames(data), data.fullName)) {
      return linkExistingPerson(c, db, existing.id, input, primaryAddress);
    }
    // Someone else's record: never attach this contact's tax and bank data to it unasked.
    const existingName = existing.displayName || existing.fullName || '';
    const existingSuffix = existingName ? `: ${existingName}` : '';
    throw new ContactIdentityError(
      'conflict',
      `A person with this email already exists${existingSuffix}. Link the contact to them or create a separate person.`,
      {
        code: 'PERSON_EMAIL_EXISTS',
        existingPerson: { id: existing.id, name: existingName, email: existing.email },
      },
    );
  }
}

const normalizeName = (value: string | null | undefined) => (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether an existing CRM person can be reused for a new contact without
 * asking: it carries no name of its own (a mail identity whose display name
 * is just the address), or it has the same first + last / display name as the
 * contact being created (case-insensitive).
 */
function isSamePerson(
  existing: PersonRow,
  typed: { firstName?: string; lastName?: string },
  typedFullName: string | undefined,
): boolean {
  const own =
    normalizeName([existing.firstName, existing.lastName].filter(Boolean).join(' ')) || normalizeName(existing.fullName);
  const display = normalizeName(existing.displayName);
  if (!own && (!display || display === normalizeName(existing.email))) return true;

  const existingNames = new Set([own, display, normalizeName(existing.fullName)].filter(Boolean));
  const typedNames = [
    normalizeName([typed.firstName, typed.lastName].filter(Boolean).join(' ')),
    normalizeName(typedFullName),
  ].filter(Boolean);
  return typedNames.some((name) => existingNames.has(name));
}

async function assertPersonNotWrapped(db: Database, personId: string): Promise<void> {
  const [wrapped] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.personId, personId), isNull(t.deletedAt)))
    .limit(1);
  if (wrapped) {
    throw new ContactIdentityError('conflict', 'A contact with this email address already exists.', {
      contactId: wrapped.id,
    });
  }
}

async function linkExistingPerson(
  c: AppContext,
  db: Database,
  personId: string,
  input: Partial<ReturnType<typeof personIdentityInput>>,
  primaryAddress: Record<string, string | undefined> | undefined,
): Promise<IdentityLink> {
  await assertPersonNotWrapped(db, personId);
  const person = await fillPersonGaps(c, db, personId, { ...input, primaryAddress });
  return { kind: 'person', companyId: null, personId, displayName: person.displayName };
}

/**
 * Bring an existing person (found by email) into the CRM and fill in the
 * fields they don't have yet; what they already have is kept, and so is the
 * email the match was made on.
 */
async function fillPersonGaps(
  c: AppContext,
  db: Database,
  personId: string,
  candidates: Record<string, unknown>,
): Promise<PersonRow> {
  const [existing] = await db.select().from(schema.people).where(eq(schema.people.id, personId)).limit(1);
  if (!existing || existing.deletedAt) {
    throw new ContactIdentityError('badRequest', 'The person to link to no longer exists.', { code: 'PERSON_NOT_FOUND' });
  }

  const fill: Record<string, unknown> = { inCrm: true };
  for (const [key, value] of Object.entries(candidates)) {
    if (value === undefined || value === '' || key === 'email') continue;
    const current = (existing as Record<string, unknown>)[key];
    const isEmpty = current === null || current === undefined || current === ''
      || (Array.isArray(current) && current.length === 0);
    if (isEmpty) fill[key] = value;
  }
  const result = await updatePerson(db, personId, fill as Parameters<typeof updatePerson>[2]);
  const person = result?.row ?? existing;
  publishIdentityEvent(c, 'person', 'updated', person);
  return person;
}

// ---------------------------------------------------------------------------
// Contact person of a company contact (its CRM billing contact)
// ---------------------------------------------------------------------------

type ContactPersonInput = NonNullable<ContactPayload['contactPerson']>;

function contactPersonIdentityInput(input: ContactPersonInput) {
  return {
    firstName: clearable(input.firstName),
    lastName: clearable(input.lastName),
    email: clearable(input.email),
    directPhone: clearable(input.phone),
  };
}

/** Same events the CRM's own link route publishes. */
function publishLinkEvents(
  c: AppContext,
  companyId: string,
  personIds: readonly string[],
  created?: { linkId: string; personId: string },
): void {
  if (created) {
    publishEntityEvent({
      c,
      entityType: 'contact_link',
      entityId: created.linkId,
      action: 'created',
      data: { id: created.linkId, personId: created.personId, companyId },
    });
  }
  for (const personId of new Set(personIds)) {
    publishEntityEvent({ c, entityType: 'person', entityId: personId, action: 'updated', data: { id: personId } });
  }
  if (created || personIds.length > 0) {
    publishEntityEvent({ c, entityType: 'company', entityId: companyId, action: 'updated', data: { id: companyId } });
  }
}

/** The CRM person the input names (updated with its fields), or a new one built from them. */
async function resolveContactPerson(
  c: AppContext,
  db: Database,
  input: ContactPersonInput,
): Promise<PersonRow | null> {
  const fields = contactPersonIdentityInput(input);

  if (input.personId) {
    const [existing] = await db
      .select()
      .from(schema.people)
      .where(and(eq(schema.people.id, input.personId), isNull(schema.people.deletedAt)))
      .limit(1);
    if (!existing) {
      throw new ContactIdentityError('badRequest', `contactPerson.personId: person ${input.personId} not found`);
    }
    // Only what differs, so saving the form unchanged leaves the CRM person alone.
    const current: Record<string, string> = {
      firstName: existing.firstName ?? '',
      lastName: existing.lastName ?? '',
      email: existing.email ?? '',
      directPhone: personPhone(existing) ?? '',
    };
    const changes: Record<string, unknown> = existing.inCrm ? {} : { inCrm: true };
    for (const [key, value] of Object.entries(definedOnly(fields))) {
      if (value !== current[key]) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) return existing;
    const result = await updatePerson(db, existing.id, changes as Parameters<typeof updatePerson>[2]);
    const person = result?.row ?? existing;
    if (result?.changes) publishIdentityEvent(c, 'person', 'updated', person);
    return person;
  }

  const present = presentOnly(fields);
  if (!present.firstName && !present.lastName && !present.email) return null;
  try {
    const person = await createPerson(db, { ...present, ownerId: await ownerIdFor(c, db) });
    publishIdentityEvent(c, 'person', 'created', person);
    return person;
  } catch (err) {
    if (!(err instanceof PersonDuplicateEmailError)) throw err;
    // The CRM already knows this person: they become the contact person.
    return fillPersonGaps(c, db, err.existingPersonId, present);
  }
}

/** Apply the payload's `contactPerson` to a company contact: set, change or remove it. */
async function syncContactPerson(
  c: AppContext,
  db: Database,
  companyId: string,
  input: ContactPayload['contactPerson'],
): Promise<void> {
  if (input === undefined) return;
  if (input === null) {
    publishLinkEvents(c, companyId, await clearBillingContact(db, companyId));
    return;
  }
  const person = await resolveContactPerson(c, db, input);
  if (!person) return;
  const link = await setBillingContact(db, companyId, person.id);
  if (!link.changed) return;
  publishLinkEvents(
    c,
    companyId,
    [person.id, ...link.demotedPersonIds],
    link.created ? { linkId: link.linkId, personId: person.id } : undefined,
  );
}

/** Update the company a contact wraps. Null when it is gone, so the caller builds a fresh identity. */
async function updateWrappedCompany(
  c: AppContext,
  db: Database,
  companyId: string,
  data: ContactPayload,
): Promise<IdentityLink | null> {
  const [existing] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), isNull(schema.companies.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const result = await updateCompany(db, existing.id, definedOnly(companyIdentityInput(data, existing)));
  if (!result) return null;
  if (result.changes) publishIdentityEvent(c, 'company', 'updated', result.row);
  return { kind: 'company', companyId: result.row.id, personId: null, displayName: result.row.displayName };
}

/** Update the person a contact wraps. Null when it is gone, so the caller builds a fresh identity. */
async function updateWrappedPerson(
  c: AppContext,
  db: Database,
  personId: string,
  data: ContactPayload,
): Promise<IdentityLink | null> {
  if (data.vatNumber || data.registrationNumber) {
    throw new ContactIdentityError(
      'badRequest',
      'This contact is a person, and VAT and registration numbers are stored on a company. Create the contact as a company to record them.',
    );
  }
  let result: Awaited<ReturnType<typeof updatePerson>>;
  try {
    result = await updatePerson(db, personId, definedOnly(personIdentityInput(data)));
  } catch (err) {
    if (!(err instanceof PersonDuplicateEmailError)) throw err;
    throw new ContactIdentityError('conflict', 'Another person in the CRM already has this email address.', {
      code: 'PERSON_EMAIL_EXISTS',
      existingPersonId: err.existingPersonId,
    });
  }
  if (!result) return null;
  if (result.changes) publishIdentityEvent(c, 'person', 'updated', result.row);
  return { kind: 'person', companyId: null, personId: result.row.id, displayName: result.row.displayName };
}

/**
 * Apply identity changes to the contact's company or person, creating the
 * identity first when the party wraps none (rows from the old route) or the
 * wrapped one was deleted in the CRM. Returns the link to store on the party.
 */
async function syncIdentity(
  c: AppContext,
  db: Database,
  contact: PartyRow,
  data: ContactPayload,
): Promise<IdentityLink | null> {
  const currentKind = contact.kind === 'company' || contact.kind === 'person' ? contact.kind : null;
  if (currentKind) {
    if (data.kind && data.kind !== currentKind) {
      throw new ContactIdentityError('badRequest', `kind: this contact is a ${currentKind}, and a contact's type can't be changed.`);
    }
    const linked = currentKind === 'company' ? contact.companyId : contact.personId;
    const asked = currentKind === 'company' ? data.companyId : data.personId;
    if (asked && asked !== linked) {
      throw new ContactIdentityError('badRequest', `${currentKind}Id: this contact already wraps another CRM ${currentKind}.`);
    }
    assertFitsKind(currentKind, data);
  }

  const wrappedCompanyId = contact.kind === 'company' ? contact.companyId : null;
  const wrappedPersonId = contact.kind === 'person' ? contact.personId : null;

  if (wrappedCompanyId || wrappedPersonId) {
    if (!touchesIdentity(data)) return null;
    const updated = wrappedCompanyId
      ? await updateWrappedCompany(c, db, wrappedCompanyId, data)
      : await updateWrappedPerson(c, db, wrappedPersonId as string, data);
    if (updated) return updated;
  }

  // No (live) identity yet: build one from the payload and the party's name. A
  // contact whose identity was deleted in the CRM gets a new one of its kind.
  return createIdentity(c, db, {
    ...data,
    ...(currentKind ? { kind: currentKind, companyId: undefined, personId: undefined } : {}),
    fullName: data.fullName ?? contact.displayName ?? 'Unnamed contact',
    billingAddress: data.billingAddress !== undefined ? data.billingAddress : contact.billingAddress,
  });
}

/**
 * Format checks on what was typed: a VAT number has to fit the country in its prefix (or, without one,
 * the contact's country: "BE0123" is not a Belgian number), an IBAN needs the right length for its
 * country and valid mod-97 check digits. A value that is no EU VAT number at all (a US EIN, an
 * Indian GSTIN) is left to the checks of its own country. `storedBilling` is the address the contact
 * already has, for an update that does not send one.
 */
function checkIdentifierFormats(data: ContactPayload, storedBilling?: unknown): void {
  checkVatFormat(data, storedBilling);
  checkIbanFormat(data);
}

function checkVatFormat(data: ContactPayload, storedBilling?: unknown): void {
  const vat = data.vatNumber?.trim();
  if (!vat) return;
  const billing = data.billingAddress !== undefined ? data.billingAddress : storedBilling;
  const check = checkVatNumberFormat(vat, normalizePostalAddress(billing as never)?.country);
  if (!check.valid) {
    const example = check.example ? ` (for example ${check.example})` : '';
    throw new ContactIdentityError('badRequest', `"${vat}" is not a valid ${check.prefix} VAT number${example}`, {
      field: 'vatNumber',
    });
  }
  if (check.prefix && check.formatted) data.vatNumber = check.formatted;
}

/** Why an IBAN was rejected, in words for the form. */
function ibanProblemReason(problem: NonNullable<ReturnType<typeof ibanProblem>>, countryCode: string): string {
  if (problem === 'country_length') return `an IBAN from ${countryCode} has ${IBAN_LENGTHS[countryCode]} characters`;
  if (problem === 'checksum') return 'the check digits do not match';
  return 'it should be two letters, two digits and the account number';
}

function checkIbanFormat(data: ContactPayload): void {
  const iban = data.iban?.trim();
  if (!iban) return;
  const problem = ibanProblem(iban);
  if (!problem) return;
  const reason = ibanProblemReason(problem, normalizeIban(iban).slice(0, 2));
  throw new ContactIdentityError('badRequest', `"${iban}" is not a valid IBAN: ${reason}`, { field: 'iban' });
}

/**
 * India: a GSTIN on a contact of an Indian entity is checked like the entity's
 * own (format, state code, check digit, and the contact's PAN when it has one)
 * and stored upper-cased. A number that is not GSTIN-shaped on a contact outside
 * India (a customer abroad with a VAT number) is left alone.
 */
async function checkIndianTaxNumber(c: AppContext, db: Database, data: ContactPayload): Promise<void> {
  const vat = data.vatNumber?.trim();
  if (!vat) return;
  const entityId = await resolveEntityId(c, db);
  if (!entityId) return;
  const [entity] = await db
    .select({ jurisdictionCode: schema.entities.jurisdictionCode })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId))
    .limit(1);
  if (entity?.jurisdictionCode?.toUpperCase() !== 'IN') return;

  const country = normalizePostalAddress(data.billingAddress)?.country;
  const indian = !country || ['IN', 'IND', 'INDIA'].includes(country);
  const looksLikeGstin = /^\d{2}[A-Z]{5}\d{4}/i.test(vat.replace(/[\s-]/g, ''));
  if (!indian || (!looksLikeGstin && country !== 'IN')) return;

  const check = validateGstin(vat, { pan: data.registrationNumber });
  if (!check.valid) {
    throw new ContactIdentityError('badRequest', check.error ?? 'Invalid GSTIN', { field: 'vatNumber' });
  }
  data.vatNumber = check.formatted;
}

/**
 * Brazil: a CNPJ or CPF on a contact of a Brazilian entity is checked (check
 * digits, the alphanumeric CNPJ included) and stored in its printed form. A
 * CPF belongs to a person, so it moves to `brFiscal.taxId` and the contact
 * stays a person rather than becoming a company. A buyer abroad is left alone.
 */
async function checkBrazilianTaxNumber(c: AppContext, db: Database, data: ContactPayload): Promise<void> {
  const vat = data.vatNumber?.trim();
  const cpf = data.brFiscal?.taxId?.trim();
  if (!vat && !cpf) return;
  const entityId = await resolveEntityId(c, db);
  if (!entityId) return;
  const [entity] = await db
    .select({ jurisdictionCode: schema.entities.jurisdictionCode })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId))
    .limit(1);
  if (entity?.jurisdictionCode?.toUpperCase() !== 'BR') return;
  const country = normalizePostalAddress(data.billingAddress)?.country;
  if (country && !['BR', 'BRA', 'BRAZIL', 'BRASIL'].includes(country.toUpperCase())) return;

  if (cpf) {
    const check = validateCpf(cpf);
    if (!check.valid) throw new ContactIdentityError('badRequest', check.error ?? 'Invalid CPF', { field: 'brFiscal.taxId' });
    data.brFiscal = { ...data.brFiscal, taxId: check.formatted };
  }
  if (!vat) return;
  const check = validateCnpjOrCpf(vat);
  if (!check.valid) throw new ContactIdentityError('badRequest', check.error ?? 'Invalid CNPJ', { field: 'vatNumber' });
  if (check.kind === 'cpf') {
    data.brFiscal = { ...data.brFiscal, taxId: check.formatted };
    data.vatNumber = undefined;
  } else {
    data.vatNumber = check.formatted;
  }
}

/** The CRM company a contact wraps, once its identity is settled. */
function contactCompanyId(contact: PartyRow | null, link: IdentityLink | null): string | null {
  if (link) return link.kind === 'company' ? link.companyId : null;
  return contact?.kind === 'company' ? contact.companyId : null;
}

function identityErrorResponse(c: AppContext, err: ContactIdentityError) {
  return err.status === 'conflict'
    ? error.conflict(c, err.message, err.details)
    : error.badRequest(c, err.message, err.details);
}

/** Saving an email that another CRM person already has. */
function duplicateEmailResponse(c: AppContext, err: PersonDuplicateEmailError) {
  return error.conflict(c, 'Another person in the CRM already has this email address.', {
    code: 'PERSON_EMAIL_EXISTS',
    existingPersonId: err.existingPersonId,
  });
}

/** The scanned W-9 has to be an accounting document of this workspace. */
async function assertW9Document(db: Database, data: ContactPayload): Promise<void> {
  const documentId = data.w9?.documentId;
  if (!documentId) return;
  const [doc] = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
    .limit(1);
  if (!doc) throw new VendorTaxError(`w9.documentId: document ${documentId} not found`);
}

/** Audit changes in client field names (`name`, `vatNumber`, ...). */
function contactChanges(
  data: ContactPayload,
  before: ContactView,
  after: ContactView,
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(data) as Array<keyof ContactPayload>) {
    if (data[key] === undefined) continue;
    const field = key === 'fullName' ? 'name' : key;
    if (!(field in after)) continue;
    const oldValue = (before as Record<string, unknown>)[field];
    const newValue = (after as Record<string, unknown>)[field];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[field] = { old: oldValue ?? null, new: newValue ?? null };
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET / — list contacts
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const page = Math.max(Number.parseInt(c.req.query('page') || '1', 10), 1);
  const pageSize = Math.min(Math.max(Number.parseInt(c.req.query('pageSize') || '25', 10), 1), 100);

  try {
    // `role` is the accounting role (customer | supplier | both). Maps to the
    // `role` column — NOT `parties.kind`, which stores the wrapper kind.
    const roleFilter = c.req.query('role');
    const search = c.req.query('search');
    const conditions = [isNull(t.deletedAt)];

    // Archived contacts stay out of lists and pickers unless asked for:
    // ?archived=only lists just them, ?archived=include lists everyone.
    const archived = c.req.query('archived');
    if (archived === 'only') conditions.push(isNotNull(t.archivedAt));
    else if (archived !== 'include') conditions.push(isNull(t.archivedAt));

    if (roleFilter) {
      if (roleFilter === 'customer' || roleFilter === 'supplier') {
        // Include "both"-role contacts on either tab so dual-role parties show up.
        conditions.push(or(eq(t.role, roleFilter), eq(t.role, 'both'))!);
      } else {
        conditions.push(eq(t.role, roleFilter));
      }
    }
    if (search) {
      conditions.push(ilike(t.displayName, `%${search}%`));
    }
    // ?kind=company|person: the contacts that are a company, or a person.
    const kindFilter = c.req.query('kind');
    if (kindFilter === 'company' || kindFilter === 'person') conditions.push(eq(t.kind, kindFilter));
    // ?is1099Vendor=true lists the vendors flagged for 1099 reporting.
    if (c.req.query('is1099Vendor') === 'true') conditions.push(eq(t.is1099Vendor, true));

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const identities = await loadIdentities(db, rows);
    const data = rows.map((row) => viewWithIdentities(row, identities));
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[books-api/accounting-contacts] list failed:', err);
    return error.internal(c, 'Failed to fetch contacts');
  }
});

// GET /:id
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const contact = await loadContactView(db, id);
    if (!contact) return error.notFound(c, 'Contact', id);
    return success(c, contact);
  } catch (err) {
    console.error('[books-api/accounting-contacts] get failed:', err);
    return error.internal(c, 'Failed to fetch contact');
  }
});

// GET /:id/invoices
app.get('/:id/invoices', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices } = schema;
  try {
    const contactInvoices = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.contactId, c.req.param('id')), isNull(invoices.deletedAt)))
      .orderBy(desc(invoices.issueDate));

    return success(c, contactInvoices);
  } catch (err) {
    console.error('[books-api/accounting-contacts] invoices failed:', err);
    return error.internal(c, 'Failed to fetch contact invoices');
  }
});

// GET /:id/bills
app.get('/:id/bills', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  try {
    const contactBills = await db
      .select()
      .from(bills)
      .where(and(eq(bills.contactId, c.req.param('id')), isNull(bills.deletedAt)))
      .orderBy(desc(bills.issueDate));

    return success(c, contactBills);
  } catch (err) {
    console.error('[books-api/accounting-contacts] bills failed:', err);
    return error.internal(c, 'Failed to fetch contact bills');
  }
});

// GET /:id/balance — outstanding receivable (invoices) + payable (bills)
app.get('/:id/balance', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices, bills } = schema;
  const contactId = c.req.param('id');

  try {
    const [invoiceBalance] = await db
      .select({
        totalOutstanding: sql<string>`coalesce(sum(${invoices.balanceDue}::numeric), 0)`,
        totalOverdue: sql<string>`coalesce(sum(case when ${invoices.dueDate} < now() and ${invoices.balanceDue}::numeric > 0 then ${invoices.balanceDue}::numeric else 0 end), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.contactId, contactId), isNull(invoices.deletedAt)));

    const [billBalance] = await db
      .select({
        totalOutstanding: sql<string>`coalesce(sum(${bills.balanceDue}::numeric), 0)`,
        totalOverdue: sql<string>`coalesce(sum(case when ${bills.dueDate} < now() and ${bills.balanceDue}::numeric > 0 then ${bills.balanceDue}::numeric else 0 end), 0)`,
      })
      .from(bills)
      .where(and(eq(bills.contactId, contactId), isNull(bills.deletedAt)));

    return success(c, {
      receivable: invoiceBalance,
      payable: billBalance,
    });
  } catch (err) {
    console.error('[books-api/accounting-contacts] balance failed:', err);
    return error.internal(c, 'Failed to fetch contact balance');
  }
});

// POST /import-from-crm — no longer needed as contacts and customers are now the same table
app.post('/import-from-crm', requirePermission('invoices:create'), (c) => {
  return success(c, { imported: 0, message: 'Contacts and customers now use the same table. No import needed.' });
});

// POST /
app.post('/', requirePermission('invoices:create'), zValidator('json', createContactBody, contactValidationHook as never), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    // Validate (and encrypt) the tax data first, so a bad TIN leaves no orphan identity behind.
    await assertW9Document(db, data);
    checkIdentifierFormats(data);
    await checkIndianTaxNumber(c, db, data);
    await checkBrazilianTaxNumber(c, db, data);
    const taxChange = await buildVendorTaxChange(null, data, c.env);
    const identity = await createIdentity(c, db, data);
    const companyId = contactCompanyId(null, identity);
    if (companyId) await syncContactPerson(c, db, companyId, data.contactPerson);

    const id = generateId('acn');
    const now = new Date();
    await db.insert(t).values({
      ...toPartyColumns(data),
      ...taxChange.columns,
      id,
      kind: identity.kind,
      companyId: identity.companyId,
      personId: identity.personId,
      displayName: identity.displayName,
      role: data.role ?? 'customer',
      outstandingBalance: '0',
      createdAt: now,
      updatedAt: now,
    });

    const contact = await loadContactView(db, id);
    if (!contact) return error.internal(c, 'Failed to create contact');

    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'created', data: stripTaxFieldsForEvent(contact) });

    return success(c, contact, 201);
  } catch (err) {
    if (err instanceof ContactIdentityError) return identityErrorResponse(c, err);
    if (err instanceof PersonDuplicateEmailError) return duplicateEmailResponse(c, err);
    if (err instanceof VendorTaxError) return error.badRequest(c, err.message, err.details);
    if (err instanceof VendorTaxKeyError) return error.unavailable(c, err.message);
    console.error('[books-api/accounting-contacts] create failed:', err);
    return error.internal(c, 'Failed to create contact');
  }
});

// PUT/PATCH /:id — legacy client uses PUT; app-api convention is PATCH
app.on(['PUT', 'PATCH'], '/:id', requirePermission('invoices:update'), zValidator('json', updateContactBody, contactValidationHook as never), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [contact] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!contact) return error.notFound(c, 'Contact', id);
    const before = await loadContactView(db, id);

    await assertW9Document(db, data);
    checkIdentifierFormats(data, contact.billingAddress);
    await checkIndianTaxNumber(c, db, data);
    await checkBrazilianTaxNumber(c, db, data);
    const taxChange = await buildVendorTaxChange(contact, data, c.env);
    const link = await syncIdentity(c, db, contact, data);
    const companyId = contactCompanyId(contact, link);
    if (companyId) await syncContactPerson(c, db, companyId, data.contactPerson);

    await db
      .update(t)
      .set({
        ...toPartyColumns(data),
        ...taxChange.columns,
        ...(link ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(t.id, id));

    const updated = await loadContactView(db, id);
    if (!updated || !before) return error.notFound(c, 'Contact', id);

    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: 'updated',
      changes: { ...contactChanges(data, before, updated), ...taxChange.changes },
    });
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'updated', data: stripTaxFieldsForEvent(updated) });

    return success(c, updated);
  } catch (err) {
    if (err instanceof ContactIdentityError) return identityErrorResponse(c, err);
    if (err instanceof PersonDuplicateEmailError) return duplicateEmailResponse(c, err);
    if (err instanceof VendorTaxError) return error.badRequest(c, err.message, err.details);
    if (err instanceof VendorTaxKeyError) return error.unavailable(c, err.message);
    console.error('[books-api/accounting-contacts] update failed:', err);
    return error.internal(c, 'Failed to update contact');
  }
});

// DELETE /:id — soft delete, only for a contact the books never used. One that
// appears on a document, payment, ledger line or 1099 is archived instead.
app.delete('/:id', requirePermission(...CONTACT_DELETE_PERMISSIONS), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [contact] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!contact) return error.notFound(c, 'Contact', id);

    const used = usedReferences(await getContactUsage(db, id));
    const openBalance = Number(contact.outstandingBalance ?? 0) !== 0;
    if (Object.keys(used).length > 0 || openBalance) {
      const reason = Object.keys(used).length > 0 ? describeUsage(used) : 'an open balance';
      return error.conflict(
        c,
        `This contact can't be deleted because it is used by ${reason}. Archive it instead to hide it from lists and pickers.`,
        { code: 'CONTACT_IN_USE', references: used, openBalance, canArchive: true },
      );
    }

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'deleted', data: { id } });

    return noContent(c);
  } catch (err) {
    console.error('[books-api/accounting-contacts] delete failed:', err);
    return error.internal(c, 'Failed to delete contact');
  }
});

// POST /:id/archive and /:id/unarchive — hide a contact from lists and pickers
// without touching its history (documents, payments and ledger lines keep
// pointing at it). Idempotent.
async function setContactArchived(c: AppContext, archived: boolean) {
  const db = c.get('tenantDb');
  const id = c.req.param('id') ?? '';
  try {
    const [contact] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!contact) return error.notFound(c, 'Contact', id);

    const alreadyDone = archived ? contact.archivedAt !== null : contact.archivedAt === null;
    if (!alreadyDone) {
      const now = new Date();
      await db
        .update(t)
        .set({ archivedAt: archived ? now : null, status: archived ? 'archived' : 'active', updatedAt: now })
        .where(eq(t.id, id));

      await writeAccountingAudit(c, db, {
        entityType: 'accounting_contact',
        entityId: id,
        action: archived ? 'archived' : 'unarchived',
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_contact',
        entityId: id,
        action: archived ? 'archived' : 'updated',
        data: { id, archived },
      });
    }

    const view = await loadContactView(db, id);
    if (!view) return error.notFound(c, 'Contact', id);
    return success(c, view);
  } catch (err) {
    console.error('[books-api/accounting-contacts] archive failed:', err);
    return error.internal(c, archived ? 'Failed to archive contact' : 'Failed to unarchive contact');
  }
}

app.post('/:id/archive', requirePermission(...CONTACT_ARCHIVE_PERMISSIONS), (c) => setContactArchived(c, true));
app.post('/:id/unarchive', requirePermission(...CONTACT_ARCHIVE_PERMISSIONS), (c) => setContactArchived(c, false));

// ---------------------------------------------------------------------------
// POST /:id/promote-role — promote a party's accounting role
//
// Migrated from apps/api-worker/src/routes/accounting/promote-role.ts.
// Operates on the `parties` table (CRM counterparty layer) — `id` is a
// partyId, not an accountingContactId.
//
// Idempotent: role only advances; never demotes.
//   none + customer → customer
//   none + supplier → supplier
//   customer + supplier → both  (and vice-versa)
//   both + * → both (no-op)
// ---------------------------------------------------------------------------
const promoteRoleSchema = z.object({
  promoteTo: z.enum(['customer', 'supplier']),
});

app.post(
  '/:id/promote-role',
  requirePermission('invoices:update'),
  zValidator('json', promoteRoleSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const partyId = c.req.param('id');
    const { promoteTo } = c.req.valid('json');

    try {
      const { parties } = schema;

      const [contact] = await db
        .select({ id: parties.id, role: parties.role })
        .from(parties)
        .where(eq(parties.id, partyId))
        .limit(1);

      if (!contact) return error.notFound(c, 'Party', partyId);

      const current = contact.role ?? 'none';

      // Already has the target role or is already 'both' — idempotent no-op.
      if (current === 'both' || current === promoteTo) {
        return success(c, { id: partyId, role: current, changed: false });
      }

      const next = current === 'none' ? promoteTo : 'both';

      await db
        .update(parties)
        .set({ role: next, updatedAt: new Date() })
        .where(eq(parties.id, partyId));

      publishEntityEvent({
        c,
        entityType: 'accounting_contact',
        entityId: partyId,
        action: 'updated',
        data: { id: partyId, role: next },
      });

      return success(c, { id: partyId, role: next, changed: true });
    } catch (err) {
      console.error('[books-api/accounting-contacts] promote-role failed:', err);
      return error.internal(c, 'Failed to promote accounting role');
    }
  },
);

// ---------------------------------------------------------------------------
// Sensitive vendor data: reveal (logged) and bank-detail verification
// ---------------------------------------------------------------------------

const revealBodySchema = z.object({ reason: z.string().trim().max(255).optional() });

async function readOptionalJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/**
 * Decrypt one stored secret of a contact. The reveal is written to the
 * append-only `tax_id_reveals` log first; a failed log write refuses it.
 */
async function revealContactSecret(c: AppContext, field: PartySecretField) {
  const db = c.get('tenantDb');
  const id = c.req.param('id') ?? '';
  const body = revealBodySchema.safeParse(await readOptionalJson(c));
  if (!body.success) return error.badRequest(c, 'Invalid request body', body.error.flatten());

  try {
    const [party] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!party) return error.notFound(c, 'Contact', id);

    const value = await revealPartySecret(db, c.env, {
      party,
      field,
      userId: c.get('userId') ?? 'unknown',
      reason: body.data.reason,
      entityId: c.req.header('x-accounting-entity-id') ?? null,
    });

    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: field === 'tin' ? 'tin_revealed' : 'ach_account_revealed',
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_contact',
      entityId: id,
      action: 'updated',
      data: { id, taxIdRevealed: field },
    });

    c.header('Cache-Control', 'no-store');
    if (field === 'tin') {
      const tinType = isTinType(party.tinType) ? party.tinType : 'ssn';
      return success(c, { tin: formatTin(tinType, value), tinType: party.tinType });
    }
    return success(c, {
      achAccountNumber: value,
      achRoutingNumber: party.achRoutingNumber,
      achAccountType: party.achAccountType,
    });
  } catch (err) {
    if (err instanceof SecretNotFoundError) return error.notFound(c, err.field === 'tin' ? 'TIN of contact' : 'ACH account number of contact', id);
    if (err instanceof VendorTaxKeyError) return error.unavailable(c, err.message);
    console.error('[books-api/accounting-contacts] reveal failed:', err instanceof Error ? err.message : 'unknown error');
    return error.internal(c, 'Failed to reveal the value');
  }
}

// POST /:id/reveal-tin: the stored TIN in clear text (tax_ids:reveal, logged).
app.post('/:id/reveal-tin', requirePermission('tax_ids:reveal'), (c) => revealContactSecret(c, 'tin'));

// POST /:id/reveal-ach-account: the stored ACH account number in clear text (tax_ids:reveal, logged).
app.post('/:id/reveal-ach-account', requirePermission('tax_ids:reveal'), (c) => revealContactSecret(c, 'ach_account_number'));

// GET /:id/tax-id-reveals: who looked at this vendor's TIN or account number, newest first.
app.get('/:id/tax-id-reveals', requirePermission('tax_ids:reveal'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const lines = await db
      .select({ id: schema.form1099FilingLines.id })
      .from(schema.form1099FilingLines)
      .where(eq(schema.form1099FilingLines.partyId, id));
    const rows = await db
      .select()
      .from(schema.taxIdReveals)
      .where(
        or(
          and(eq(schema.taxIdReveals.subjectType, 'party'), eq(schema.taxIdReveals.subjectId, id)),
          lines.length > 0
            ? and(eq(schema.taxIdReveals.subjectType, 'form_1099_line'), inArray(schema.taxIdReveals.subjectId, lines.map((l) => l.id)))
            : undefined,
        ),
      )
      .orderBy(desc(schema.taxIdReveals.createdAt))
      .limit(200);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[books-api/accounting-contacts] reveal log failed:', err);
    return error.internal(c, 'Failed to fetch the reveal log');
  }
});

// POST /:id/verify-bank-details: someone confirmed the vendor's bank details (for example by calling the vendor);
// lifts the payment hold set when the routing or account number changed.
app.post('/:id/verify-bank-details', requirePermission('banking:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [party] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!party) return error.notFound(c, 'Contact', id);
    if (!party.achRoutingNumber || !party.achAccountLast4) {
      return error.badRequest(c, 'This contact has no bank details to verify');
    }

    const now = new Date();
    const userId = c.get('userId') ?? 'unknown';
    await db
      .update(t)
      .set({ bankDetailsVerifiedAt: now, bankDetailsVerifiedBy: userId, updatedAt: now })
      .where(eq(t.id, id));

    const updated = await loadContactView(db, id);
    if (!updated) return error.notFound(c, 'Contact', id);
    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: 'bank_verified',
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_contact',
      entityId: id,
      action: 'updated',
      data: { id, bankDetailsVerified: true },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[books-api/accounting-contacts] verify bank details failed:', err);
    return error.internal(c, 'Failed to verify the bank details');
  }
});

export const accountingContactsRoutes = app;
