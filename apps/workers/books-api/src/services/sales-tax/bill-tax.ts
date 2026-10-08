/**
 * Use tax on a stored US bill. The vendor-charged tax of a bill is a plain
 * per-line rate and stays as saved; the lines marked "accrue use tax" go
 * through the sales tax engine at the bill's delivery address. Approving a bill
 * recalculates the accrual first, so the tax that posts is today's answer for
 * the saved lines, and an engine that can't answer refuses the approval.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { calculateDocumentTax, type DocumentTaxItem } from '../accounting-tax-resolve';
import { loadSalesTaxEntity, usesSalesTax, type UsDocumentContext } from './document-tax';
import type { SalesTaxRuntime } from './runtime';

type BillRow = typeof schema.bills.$inferSelect;
type BillItemRow = typeof schema.billItems.$inferSelect;

export function billDocumentContext(bill: BillRow): UsDocumentContext {
  return {
    kind: 'bill',
    documentId: bill.id,
    documentNumber: bill.billNumber,
    contactId: bill.contactId,
    issueDate: bill.issueDate,
    currency: bill.currency,
    billingAddress: bill.vendorAddress,
    deliveryAddress: bill.deliveryAddress,
  };
}

export function billItemToTaxItem(item: BillItemRow): DocumentTaxItem {
  return {
    id: item.id,
    description: item.description,
    quantity: item.quantity ?? '1',
    unitPrice: item.unitPrice,
    discountPercent: item.discountPercent ?? '0',
    sortOrder: item.sortOrder,
    productId: item.productId,
    taxRateId: item.taxRateId,
    taxRate: item.taxRate,
    taxCode: item.taxCode,
    accrueUseTax: item.accrueUseTax,
  };
}

export function hasUseTaxLines(items: Array<{ accrueUseTax?: boolean | null }>): boolean {
  return items.some((item) => item.accrueUseTax);
}

/**
 * Recalculate a stored draft bill's use tax and save the breakdown. Returns the
 * bill as it will post. Bills with nothing to accrue, and entities with no
 * sales tax, come back untouched.
 */
export async function refreshBillUseTax(
  db: Database,
  bill: BillRow,
  items: BillItemRow[],
  runtime?: SalesTaxRuntime,
): Promise<BillRow> {
  if (!hasUseTaxLines(items) || !usesSalesTax(await loadSalesTaxEntity(db, bill.entityId))) return bill;

  const calc = await calculateDocumentTax(db, {
    entityId: bill.entityId,
    direction: 'purchase',
    items: items.map(billItemToTaxItem),
    document: billDocumentContext(bill),
    runtime,
  });
  await db
    .update(schema.bills)
    .set({ taxBreakdown: calc.taxBreakdown, updatedAt: new Date() })
    .where(eq(schema.bills.id, bill.id));
  return { ...bill, taxBreakdown: calc.taxBreakdown };
}
