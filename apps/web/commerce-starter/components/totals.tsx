import { isZeroMoney, type StorefrontOrder, type TaxLine, type VatTreatment } from '@weldsuite/commerce-sdk';

import { money, taxRate } from '@/lib/format';

interface TotalsInput {
  currency: string;
  pricesIncludeTax: boolean;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  vatTreatment: VatTreatment | null;
  taxLines?: TaxLine[];
}

const TREATMENT_NOTES: Record<string, string> = {
  reverse_charge: 'VAT reverse-charged: the buyer accounts for VAT (EU business purchase).',
  outside_eu: 'No EU VAT: the order ships outside the EU.',
};

/** Subtotal, discount, shipping, VAT per rate and the total, as a description list. */
export function Totals({
  totals,
  locale,
  shippingKnown = true,
}: Readonly<{
  totals: TotalsInput;
  locale: string;
  /** False until a shipping method is chosen. */
  shippingKnown?: boolean;
}>) {
  const m = (amount: string) => money(amount, totals.currency, locale);
  const vatNote = totals.pricesIncludeTax ? 'incl.' : 'excl.';
  const lines = totals.taxLines?.filter((line) => !isZeroMoney(line.amount)) ?? [];
  let shipping = 'Chosen at checkout';
  if (shippingKnown) shipping = isZeroMoney(totals.shippingTotal) ? 'Free' : m(totals.shippingTotal);
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
        <dt>Subtotal ({vatNote} VAT)</dt>
        <dd className="text-right tabular-nums">{m(totals.subtotal)}</dd>
        {!isZeroMoney(totals.discountTotal) ? (
          <>
            <dt>Discount</dt>
            <dd className="text-right tabular-nums">−{m(totals.discountTotal)}</dd>
          </>
        ) : null}
        <dt>Shipping</dt>
        <dd className="text-right tabular-nums">{shipping}</dd>
        {lines.length > 0 ? (
          lines.map((line) => (
            <div key={line.rate} className="contents">
              <dt className="text-ink-muted">
                VAT {taxRate(line.rate, locale)} {totals.pricesIncludeTax ? '(included)' : ''}
              </dt>
              <dd className="text-right tabular-nums text-ink-muted">{m(line.amount)}</dd>
            </div>
          ))
        ) : (
          <>
            <dt className="text-ink-muted">VAT {totals.pricesIncludeTax ? '(included)' : ''}</dt>
            <dd className="text-right tabular-nums text-ink-muted">
              {totals.vatTreatment ? m(totals.taxTotal) : 'Worked out from your address'}
            </dd>
          </>
        )}
        <dt className="border-t border-line pt-2 text-lg font-semibold">Total</dt>
        <dd className="border-t border-line pt-2 text-right text-lg font-semibold tabular-nums">{m(totals.total)}</dd>
      </dl>
      {totals.vatTreatment && TREATMENT_NOTES[totals.vatTreatment] ? (
        <p className="hint">{TREATMENT_NOTES[totals.vatTreatment]}</p>
      ) : null}
    </div>
  );
}

/** An order's lines and totals. */
export function OrderLines({ order, locale }: Readonly<{ order: StorefrontOrder; locale: string }>) {
  const m = (amount: string) => money(amount, order.currency, locale);
  return (
    <div className="flex flex-col gap-6">
      {/* tabIndex: keyboard users can scroll a table wider than the screen (a focusable region). */}
      <div role="region" aria-labelledby={`lines-${order.id}`} tabIndex={0} className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption id={`lines-${order.id}`} className="sr-only">
            Items in order {order.orderNumber}
          </caption>
          <thead>
            <tr className="border-b border-line text-sm text-ink-muted">
              <th scope="col" className="py-2 pr-4 font-medium">Item</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Price</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Quantity</th>
              <th scope="col" className="py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-b border-line align-top">
                <th scope="row" className="py-3 pr-4 font-normal">
                  <span className="font-medium">{item.name}</span>
                  {item.variantName ? <span className="block text-sm text-ink-muted">{item.variantName}</span> : null}
                  {item.sku ? <span className="block text-sm text-ink-muted">SKU {item.sku}</span> : null}
                </th>
                <td className="py-3 pr-4 text-right tabular-nums">{m(item.unitPrice)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{item.quantity}</td>
                <td className="py-3 text-right tabular-nums">{m(item.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sm:ml-auto sm:w-96">
        <Totals totals={order} locale={locale} />
      </div>
    </div>
  );
}
