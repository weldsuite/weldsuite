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
 * Also exposes POST /:id/promote-role which updates the CRM-level `parties.role`
 * field when a counterparty gains its first invoice (→ customer) or first bill
 * (→ supplier). The promotion is idempotent and only moves the role forward:
 *   none + customer → customer
 *   none + supplier → supplier
 *   customer/supplier + other → both
 *   both + * → both (no-op)
 *
 * Note: identity facts (name/email/phone) and tax identifiers live on the
 * wrapped `companies` / `people` rows after the refactor. `parties` only
 * carries the commercial fields — the request schema still accepts the full
 * legacy payload and echoes it back, but only party-level columns persist
 * (identical to the legacy runtime behaviour, where drizzle dropped the
 * unknown keys). `fullName` is additionally stamped onto `displayName` so
 * list search works — the legacy route silently lost it.
 *
 * Permissions: invoices:read | invoices:create | invoices:update | invoices:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.parties;

const addressSchema = z.object({
  street: z.string().optional(),
  houseNumber: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  country: z.string().optional(),
}).optional();

const createContactSchema = z.object({
  role: z.enum(['customer', 'supplier', 'both', 'none']).optional(),
  fullName: z.string().min(1).max(255),
  companyName: z.string().max(255).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  vatNumber: z.string().max(50).optional(),
  registrationNumber: z.string().max(20).optional(),
  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  paymentTermsDays: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  defaultRevenueAccountId: z.string().max(30).optional(),
  defaultExpenseAccountId: z.string().max(30).optional(),
  crmCustomerId: z.string().max(30).optional(),
  crmContactId: z.string().max(30).optional(),
  creditLimit: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sepaMandate: z.object({
    mandateId: z.string().optional(),
    signatureDate: z.string().optional(),
    type: z.enum(['one-off', 'recurring']).optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateContactSchema = createContactSchema.partial();

type ContactPayload = z.infer<typeof updateContactSchema>;

/** Map the legacy contact payload onto the columns that exist on `parties`. */
function toPartyColumns(data: ContactPayload): Partial<typeof t.$inferInsert> {
  const record: Partial<typeof t.$inferInsert> = {};
  if (data.fullName !== undefined) record.displayName = data.fullName;
  if (data.role !== undefined) record.role = data.role;
  if (data.billingAddress !== undefined) record.billingAddress = data.billingAddress;
  if (data.shippingAddress !== undefined) record.shippingAddress = data.shippingAddress;
  if (data.currency !== undefined) record.currency = data.currency;
  if (data.iban !== undefined) record.iban = data.iban;
  if (data.bic !== undefined) record.bic = data.bic;
  if (data.defaultRevenueAccountId !== undefined) record.defaultRevenueAccountId = data.defaultRevenueAccountId;
  if (data.defaultExpenseAccountId !== undefined) record.defaultExpenseAccountId = data.defaultExpenseAccountId;
  if (data.sepaMandate !== undefined) record.sepaMandate = data.sepaMandate;
  return record;
}

// GET / — list contacts
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(c.req.query('pageSize') || '25', 10), 1), 100);

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
      conditions.push(like(t.displayName, `%${search}%`));
    }

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/accounting-contacts] list failed:', err);
    return error.internal(c, 'Failed to fetch contacts');
  }
});

// GET /:id
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [contact] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!contact) return error.notFound(c, 'Contact', id);
    return success(c, contact);
  } catch (err) {
    console.error('[app-api/accounting-contacts] get failed:', err);
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
    console.error('[app-api/accounting-contacts] invoices failed:', err);
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
    console.error('[app-api/accounting-contacts] bills failed:', err);
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
    console.error('[app-api/accounting-contacts] balance failed:', err);
    return error.internal(c, 'Failed to fetch contact balance');
  }
});

// POST /import-from-crm — no longer needed as contacts and customers are now the same table
app.post('/import-from-crm', requirePermission('invoices:create'), async (c) => {
  return success(c, { imported: 0, message: 'Contacts and customers now use the same table. No import needed.' });
});

// POST /
app.post('/', requirePermission('invoices:create'), zValidator('json', createContactSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const id = generateId('acn');
    const now = new Date();

    await db.insert(t).values({
      id,
      ...toPartyColumns(data),
      role: data.role ?? 'customer',
      outstandingBalance: '0',
      createdAt: now,
      updatedAt: now,
    });

    // Legacy response shape: echoes the full request payload plus the
    // server-set fields, not the persisted row.
    const newContact = {
      id,
      ...data,
      role: data.role ?? 'customer',
      outstandingBalance: '0',
      createdAt: now,
      updatedAt: now,
    };

    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'created', data: newContact as unknown as Record<string, unknown> });

    return success(c, newContact, 201);
  } catch (err) {
    console.error('[app-api/accounting-contacts] create failed:', err);
    return error.internal(c, 'Failed to create contact');
  }
});

// PUT/PATCH /:id — legacy client uses PUT; app-api convention is PATCH
app.on(['PUT', 'PATCH'], '/:id', requirePermission('invoices:update'), zValidator('json', updateContactSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [contact] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!contact) return error.notFound(c, 'Contact', id);

    await db
      .update(t)
      .set({ ...toPartyColumns(data), updatedAt: new Date() })
      .where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      entityType: 'accounting_contact',
      entityId: id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { old: (contact as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'accounting_contact', entityId: id, action: 'updated', data: { ...contact, ...data } as unknown as Record<string, unknown> });

    return success(c, { ...contact, ...data });
  } catch (err) {
    console.error('[app-api/accounting-contacts] update failed:', err);
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
    console.error('[app-api/accounting-contacts] delete failed:', err);
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
      console.error('[app-api/accounting-contacts] promote-role failed:', err);
      return error.internal(c, 'Failed to promote accounting role');
    }
  },
);

export const accountingContactsRoutes = app;
