/**
 * The invoice lines of a commerce order for a US entity (the sales tax engine
 * calculates them; docs/plans/weldbooks-us.md §2).
 *
 * One line per order item, shipping as a line of its own with tax code
 * `shipping`, and any order-level discount the items don't already carry
 * (a coupon) spread over the item lines pro rata, since a seller's discount
 * lowers the taxable price. A line's tax code is what the order's own tax
 * calculation used (`metadata.salesTax.lines[].taxCode`), else `non_taxable`
 * for a product not marked taxable, else the product's tax class, else
 * `general`. The customer's business / personal use comes from the party.
 */

import { inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { allocateCents, fromCents, toCents } from '@weldsuite/books-domain/sales-tax';
import { normalizeWeldTaxCode } from '@weldsuite/books-domain/jurisdictions/us/tax-codes';

type OrderRow = typeof schema.orders.$inferSelect;
type OrderItemRow = typeof schema.orderItems.$inferSelect;

export interface OrderInvoiceLine {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  productId: string | null;
  taxCode: string;
}

function money(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The tax codes the order's own tax calculation settled on, by order item id. */
function orderTaxCodes(order: OrderRow): Map<string, string> {
  const salesTax = (order.metadata as { salesTax?: { lines?: Array<{ lineId?: string; taxCode?: string }> } } | null)?.salesTax;
  const codes = new Map<string, string>();
  for (const line of salesTax?.lines ?? []) {
    if (line.lineId && line.taxCode) codes.set(line.lineId, line.taxCode);
  }
  return codes;
}

export async function orderInvoiceLines(db: Database, order: OrderRow, items: OrderItemRow[]): Promise<OrderInvoiceLine[]> {
  const productIds = [...new Set(items.map((i) => i.productId).filter((id): id is string => Boolean(id)))];
  const products =
    productIds.length > 0
      ? await db
          .select({ id: schema.products.id, taxable: schema.products.taxable, taxClass: schema.products.taxClass })
          .from(schema.products)
          .where(inArray(schema.products.id, productIds))
      : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const fromOrder = orderTaxCodes(order);

  const gross = items.map((item) => {
    const quantity = item.quantity > 0 ? item.quantity : 1;
    const own = toCents(money(item.discountAmount));
    return { item, quantity, own, cents: Math.max(0, toCents(money(item.unitPrice) * quantity) - own) };
  });
  const itemDiscounts = gross.reduce((sum, g) => sum + g.own, 0);
  const orderDiscount = Math.max(0, toCents(money(order.discountTotal)) - itemDiscounts);
  const base = gross.reduce((sum, g) => sum + g.cents, 0);
  const shares = orderDiscount > 0 && base > 0 ? allocateCents(Math.min(orderDiscount, base), gross.map((g) => g.cents)) : [];

  const lines: OrderInvoiceLine[] = gross.map((g, i) => {
    const cents = Math.max(0, g.cents - (shares[i] ?? 0));
    const product = g.item.productId ? productById.get(g.item.productId) : undefined;
    const taxCode =
      fromOrder.get(g.item.id) ??
      (product?.taxable === false ? 'non_taxable' : product?.taxClass ? normalizeWeldTaxCode(product.taxClass) : 'general');
    const name = g.item.name + (g.item.description ? ` - ${g.item.description}` : '');

    // Price per unit when the discounted total divides into cents-and-fractions exactly, else one line for the lot.
    const unit = Math.round((fromCents(cents) / g.quantity) * 10_000) / 10_000;
    const exact = toCents(unit * g.quantity) === cents;
    return exact
      ? { description: name, quantity: String(g.quantity), unitPrice: unit.toFixed(4), discountPercent: '0', productId: g.item.productId, taxCode }
      : {
          description: `${name} (${g.quantity} x ${money(g.item.unitPrice).toFixed(2)})`,
          quantity: '1',
          unitPrice: fromCents(cents).toFixed(2),
          discountPercent: '0',
          productId: g.item.productId,
          taxCode,
        };
  });

  const shipping = toCents(money(order.shippingTotal));
  if (shipping > 0) {
    lines.push({
      description: 'Shipping',
      quantity: '1',
      unitPrice: fromCents(shipping).toFixed(2),
      discountPercent: '0',
      productId: null,
      taxCode: 'shipping',
    });
  }
  return lines;
}
