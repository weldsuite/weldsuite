/**
 * Buyer-scoped invoice HTML. Reuses the staff printable-HTML generator so
 * portal documents match WeldBooks output. Draft invoices are never returned.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateInvoiceHtml } from './accounting-invoice-html';
import {
  buildComplianceNotices,
  collectInvoiceTaxCategories,
  getContactVatNumber,
  invoiceUsesReverseCharge,
} from './accounting-compliance';

export async function loadPortalInvoice(
  db: Database,
  invoiceId: string,
  partyId: string,
) {
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.id, invoiceId),
        eq(schema.invoices.counterpartyId, partyId),
        ne(schema.invoices.status, 'draft'),
        isNull(schema.invoices.deletedAt),
      ),
    )
    .limit(1);
  return invoice ?? null;
}

export async function renderPortalInvoiceHtml(
  db: Database,
  invoiceId: string,
  partyId: string,
): Promise<{ html: string; filename: string } | null> {
  const invoice = await loadPortalInvoice(db, invoiceId, partyId);
  if (!invoice) return null;

  const items = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNull(schema.invoiceItems.deletedAt)))
    .orderBy(schema.invoiceItems.sortOrder);

  const [entityRow] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, invoice.entityId), isNull(schema.entities.deletedAt)))
    .limit(1);

  if (!entityRow) return null;

  const taxCategories = await collectInvoiceTaxCategories(db, invoiceId);
  const complianceNotices = buildComplianceNotices(entityRow, taxCategories);
  const contactVatNumber = invoiceUsesReverseCharge(taxCategories)
    ? await getContactVatNumber(db, invoice.contactId)
    : null;

  const html = generateInvoiceHtml(
    {
      invoiceNumber: invoice.invoiceNumber || invoiceId,
      type: invoice.type || 'standard',
      issueDate: invoice.issueDate?.toISOString() || new Date().toISOString(),
      dueDate: invoice.dueDate?.toISOString() || new Date().toISOString(),
      currency: invoice.currency || entityRow.baseCurrency || 'EUR',
      contactName: invoice.contactName || '',
      contactEmail: invoice.contactEmail,
      contactVatNumber,
      complianceNotices,
      billingAddress: invoice.billingAddress,
      reference: invoice.reference,
      notes: invoice.notes,
      items: items.map((i) => ({
        description: i.description || '',
        quantity: i.quantity || '1',
        unitPrice: i.unitPrice || '0',
        unit: i.unit ?? undefined,
        discountPercent: i.discountPercent ?? undefined,
        taxRate: i.taxRate ?? undefined,
        lineTotal: i.lineTotal || '0',
        lineTotalWithTax: i.lineTotalWithTax ?? undefined,
        taxAmount: i.taxAmount ?? undefined,
      })),
      subtotal: invoice.subtotal || '0',
      discountTotal: invoice.discountTotal || '0',
      taxTotal: invoice.taxTotal || '0',
      total: invoice.total || '0',
      amountPaid: invoice.amountPaid ?? undefined,
      balanceDue: invoice.balanceDue ?? undefined,
      taxBreakdown: invoice.taxBreakdown || [],
    },
    entityRow,
  );

  return { html, filename: `${invoice.invoiceNumber || 'invoice'}.html` };
}
