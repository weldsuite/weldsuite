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
 * Which identity a new contact gets: a company when the payload has a
 * company name, a VAT or registration number (a person row has no tax ids),
 * or no first/last name; otherwise a person. Parties created by the old
 * route wrap nothing (`kind` null); their first update creates the identity
 * and links it.
 *
 * Also exposes POST /:id/promote-role which updates the CRM-level `parties.role`
 * field when a counterparty gains its first invoice (→ customer) or first bill
 * (→ supplier). The promotion is idempotent and only moves the role forward:
 *   none + customer → customer
 *   none + supplier → supplier
 *   customer/supplier + other → both
 *   both + * → both (no-op)
 *
 * Permissions: invoices:read | invoices:create | invoices:update | invoices:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
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

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.parties;

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

const createContactSchema = z.object({
  role: z.enum(['customer', 'supplier', 'both', 'none']).optional(),
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
]);

/**
 * The platform contact form posts `name`, `taxNumber` and `kvkNumber`, and
 * sends untouched optional inputs as "". Map those onto the schema's field
 * names and drop blank strings, so an empty email doesn't fail `.email()`.
 * On update a blank clearable field becomes null, so emptying an input in
 * the edit form clears the stored value.
 */
function normalizeContactPayload(input: unknown, mode: 'create' | 'update'): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
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

/** The contact as clients read it. Empty identity values come back as null. */
function toContactView(party: PartyRow, company?: CompanyRow | null, person?: PersonRow | null) {
  const { billingAddress, shippingAddress, ...partyColumns } = party;
  const vatNumber = company?.vatNumber || null;
  const registrationNumber = company?.registrationNumber || null;
  return {
    ...partyColumns,
    name: party.displayName ?? company?.displayName ?? person?.displayName ?? '',
    companyName: company?.name ?? null,
    firstName: person?.firstName ?? null,
    lastName: person?.lastName ?? null,
    email: (company ? company.email : person?.email) || null,
    phone: (company ? company.phone : person?.directPhone || person?.mobilePhone) || null,
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

/** Load the companies and people a page of parties wraps, two queries total. */
async function loadIdentities(db: Database, rows: PartyRow[]) {
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((id): id is string => !!id))];
  const personIds = [...new Set(rows.map((r) => r.personId).filter((id): id is string => !!id))];
  const [companies, people] = await Promise.all([
    companyIds.length > 0
      ? db.select().from(schema.companies).where(inArray(schema.companies.id, companyIds))
      : Promise.resolve([] as CompanyRow[]),
    personIds.length > 0
      ? db.select().from(schema.people).where(inArray(schema.people.id, personIds))
      : Promise.resolve([] as PersonRow[]),
  ]);
  return {
    companies: new Map(companies.map((row) => [row.id, row])),
    people: new Map(people.map((row) => [row.id, row])),
  };
}

async function loadContactView(db: Database, id: string): Promise<ContactView | null> {
  const [party] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!party) return null;
  const { companies, people } = await loadIdentities(db, [party]);
  return toContactView(
    party,
    party.companyId ? companies.get(party.companyId) : null,
    party.personId ? people.get(party.personId) : null,
  );
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

/**
 * Create the CRM identity a contact wraps. A person whose email already
 * exists (often a mail-only identity) is reused: its empty fields are filled
 * in, unless another contact already wraps it.
 */
async function createIdentity(
  c: AppContext,
  db: Database,
  data: ContactPayload & { fullName: string },
): Promise<IdentityLink> {
  const kind = chooseIdentityKind(data);
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
  try {
    const person = await createPerson(db, { ...input, primaryAddress, ownerId });
    publishIdentityEvent(c, 'person', 'created', person);
    return { kind, companyId: null, personId: person.id, displayName: person.displayName };
  } catch (err) {
    if (!(err instanceof PersonDuplicateEmailError)) throw err;
    return linkExistingPerson(c, db, err.existingPersonId, input, primaryAddress);
  }
}

async function linkExistingPerson(
  c: AppContext,
  db: Database,
  personId: string,
  input: Partial<ReturnType<typeof personIdentityInput>>,
  primaryAddress: Record<string, string | undefined> | undefined,
): Promise<IdentityLink> {
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
  const [existing] = await db.select().from(schema.people).where(eq(schema.people.id, personId)).limit(1);
  if (!existing) throw new Error(`Person ${personId} disappeared`);

  const fill: Record<string, unknown> = { inCrm: true };
  const candidates: Record<string, unknown> = { ...input, primaryAddress };
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
  return { kind: 'person', companyId: null, personId, displayName: person.displayName };
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
  if (contact.kind === 'company' && contact.companyId) {
    if (!touchesIdentity(data)) return null;
    const [existing] = await db
      .select()
      .from(schema.companies)
      .where(and(eq(schema.companies.id, contact.companyId), isNull(schema.companies.deletedAt)))
      .limit(1);
    if (existing) {
      const result = await updateCompany(db, existing.id, definedOnly(companyIdentityInput(data, existing)));
      if (result) {
        if (result.changes) publishIdentityEvent(c, 'company', 'updated', result.row);
        return { kind: 'company', companyId: result.row.id, personId: null, displayName: result.row.displayName };
      }
    }
  } else if (contact.kind === 'person' && contact.personId) {
    if (!touchesIdentity(data)) return null;
    if (data.vatNumber || data.registrationNumber) {
      throw new ContactIdentityError(
        'badRequest',
        'This contact is a person, and VAT and registration numbers are stored on a company. Create the contact as a company to record them.',
      );
    }
    const result = await updatePerson(db, contact.personId, definedOnly(personIdentityInput(data)));
    if (result) {
      if (result.changes) publishIdentityEvent(c, 'person', 'updated', result.row);
      return { kind: 'person', companyId: null, personId: result.row.id, displayName: result.row.displayName };
    }
  }

  // No (live) identity yet: build one from the payload and the party's name.
  return createIdentity(c, db, {
    ...data,
    fullName: data.fullName ?? contact.displayName ?? 'Unnamed contact',
    billingAddress: data.billingAddress !== undefined ? data.billingAddress : contact.billingAddress,
  });
}

function identityErrorResponse(c: AppContext, err: ContactIdentityError) {
  return err.status === 'conflict'
    ? error.conflict(c, err.message, err.details)
    : error.badRequest(c, err.message, err.details);
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

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const { companies, people } = await loadIdentities(db, rows);
    const data = rows.map((row) =>
      toContactView(
        row,
        row.companyId ? companies.get(row.companyId) : null,
        row.personId ? people.get(row.personId) : null,
      ),
    );
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
app.post('/import-from-crm', requirePermission('invoices:create'), async (c) => {
  return success(c, { imported: 0, message: 'Contacts and customers now use the same table. No import needed.' });
});

// POST /
app.post('/', requirePermission('invoices:create'), zValidator('json', createContactBody, contactValidationHook as never), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const identity = await createIdentity(c, db, data);

    const id = generateId('acn');
    const now = new Date();
    await db.insert(t).values({
      ...toPartyColumns(data),
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
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'created', data: contact as unknown as Record<string, unknown> });

    return success(c, contact, 201);
  } catch (err) {
    if (err instanceof ContactIdentityError) return identityErrorResponse(c, err);
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

    const link = await syncIdentity(c, db, contact, data);

    await db
      .update(t)
      .set({
        ...toPartyColumns(data),
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
      changes: contactChanges(data, before, updated),
    });
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'updated', data: updated as unknown as Record<string, unknown> });

    return success(c, updated);
  } catch (err) {
    if (err instanceof ContactIdentityError) return identityErrorResponse(c, err);
    console.error('[books-api/accounting-contacts] update failed:', err);
    return error.internal(c, 'Failed to update contact');
  }
});

// DELETE /:id — soft delete
app.delete('/:id', requirePermission('invoices:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [contact] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!contact) return error.notFound(c, 'Contact', id);

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

export const accountingContactsRoutes = app;
