/**
 * Invoice templates (the invoice designer's stored layouts): /api/invoice-templates.
 *
 * A template belongs to one accounting entity; exactly one per entity is the
 * default, and an invoice may pick one (`invoices.template_id`). The entity's
 * first template becomes its default; deleting the default promotes nothing, so
 * invoices fall back to the built-in layout. The document is validated with
 * `invoiceTemplateDocumentSchema` from @weldsuite/books-domain.
 *
 * GET / takes `entityId` (else the X-Accounting-Entity-Id header, else the
 * workspace default entity) and returns that entity's templates, default first,
 * then by name. The list is small configuration, so it is not paginated.
 *
 * Permissions: invoices:read to read; changing templates is branding-level
 * configuration, gated like the accounting settings: accounts:create (create,
 * duplicate) | accounts:update | accounts:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createInvoiceTemplateSchema,
  updateInvoiceTemplateSchema,
} from '@weldsuite/books-domain/invoice-template/schema';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { entityExists, resolveEntityId } from '../../lib/entity-context';
import {
  createInvoiceTemplate,
  deleteInvoiceTemplate,
  duplicateInvoiceTemplate,
  findInvoiceTemplate,
  listInvoiceTemplates,
  toInvoiceTemplate,
  updateInvoiceTemplate,
  type InvoiceTemplateRow,
} from '../../services/invoice-templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Event payload: the document is bulky and belongs to the template, not the event. */
function eventData(row: InvoiceTemplateRow) {
  return { id: row.id, entityId: row.entityId, name: row.name, isDefault: row.isDefault, paperSize: row.paperSize };
}

// GET /
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list: not an error.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const rows = await listInvoiceTemplates(db, entityId);
    return list(c, rows.map(toInvoiceTemplate), cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[books-api/invoice-templates] list failed:', err);
    return error.internal(c, 'Failed to fetch invoice templates');
  }
});

// GET /:id
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findInvoiceTemplate(db, id);
    if (!row) return error.notFound(c, 'Invoice template', id);
    return success(c, toInvoiceTemplate(row));
  } catch (err) {
    console.error('[books-api/invoice-templates] get failed:', err);
    return error.internal(c, 'Failed to fetch invoice template');
  }
});

// POST /
app.post('/', requirePermission('accounts:create'), zValidator('json', createInvoiceTemplateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    if (!(await entityExists(db, data.entityId))) return error.badRequest(c, 'Accounting entity not found');

    const row = await createInvoiceTemplate(db, { ...data, createdBy: c.get('userId') ?? null });

    await writeAccountingAudit(c, db, {
      accountingEntityId: row.entityId,
      entityType: 'invoice_template',
      entityId: row.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'invoice_template', entityId: row.id, action: 'created', data: eventData(row) });

    return success(c, toInvoiceTemplate(row), 201);
  } catch (err) {
    console.error('[books-api/invoice-templates] create failed:', err);
    return error.internal(c, 'Failed to create invoice template');
  }
});

// PATCH /:id
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateInvoiceTemplateSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const row = await updateInvoiceTemplate(db, id, data);
    if (!row) return error.notFound(c, 'Invoice template', id);

    await writeAccountingAudit(c, db, {
      accountingEntityId: row.entityId,
      entityType: 'invoice_template',
      entityId: id,
      action: 'updated',
      // The document is not diffed into the audit trail: it is a whole page layout.
      changes: Object.fromEntries(
        (['name', 'isDefault'] as const)
          .filter((k) => data[k] !== undefined)
          .map((k) => [k, { old: undefined, new: data[k] }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'invoice_template', entityId: id, action: 'updated', data: eventData(row) });

    return success(c, toInvoiceTemplate(row));
  } catch (err) {
    console.error('[books-api/invoice-templates] update failed:', err);
    return error.internal(c, 'Failed to update invoice template');
  }
});

// DELETE /:id: invoices that used the template fall back to the entity default / built-in layout
app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const row = await deleteInvoiceTemplate(db, id);
    if (!row) return error.notFound(c, 'Invoice template', id);

    await writeAccountingAudit(c, db, {
      accountingEntityId: row.entityId,
      entityType: 'invoice_template',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'invoice_template', entityId: id, action: 'deleted', data: { id } });

    return noContent(c);
  } catch (err) {
    console.error('[books-api/invoice-templates] delete failed:', err);
    return error.internal(c, 'Failed to delete invoice template');
  }
});

// POST /:id/duplicate: "<name> (copy)", never the default
app.post('/:id/duplicate', requirePermission('accounts:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const row = await duplicateInvoiceTemplate(db, id, c.get('userId') ?? null);
    if (!row) return error.notFound(c, 'Invoice template', id);

    await writeAccountingAudit(c, db, {
      accountingEntityId: row.entityId,
      entityType: 'invoice_template',
      entityId: row.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'invoice_template', entityId: row.id, action: 'created', data: eventData(row) });

    return success(c, toInvoiceTemplate(row), 201);
  } catch (err) {
    console.error('[books-api/invoice-templates] duplicate failed:', err);
    return error.internal(c, 'Failed to duplicate invoice template');
  }
});

export const invoiceTemplatesRoutes = app;
