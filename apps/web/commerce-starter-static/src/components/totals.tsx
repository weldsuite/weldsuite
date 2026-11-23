import { isZeroMoney, type TaxLine } from '@weldsuite/commerce-sdk';

import { config } from '../lib/client';
import { money, taxRate } from '../lib/format';
import { text } from '../lib/messages';

export interface TotalsSource {
  currency: string;
  pricesIncludeTax: boolean;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  taxLines?: TaxLine[];
}

const zero = (amount: string) => {
  try {
    return isZeroMoney(amount);
  } catch {
    return false;
  }
};

/** Subtotal, discount, shipping, VAT per rate (or "including" when prices include it) and total. */
export function Totals({ totals, shippingKnown, taxKnown }: Readonly<{ totals: TotalsSource; shippingKnown: boolean; taxKnown: boolean }>) {
  const locale = config?.locale ?? 'en-IE';
  const amount = (value: string) => money(value, totals.currency, locale);
  const lines = totals.taxLines ?? [];
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
      <dt>{text.subtotal}</dt>
      <dd className="text-end tabular-nums">{amount(totals.subtotal)}</dd>
      {zero(totals.discountTotal) ? null : (
        <>
          <dt>{text.discount}</dt>
          <dd className="text-end tabular-nums">−{amount(totals.discountTotal)}</dd>
        </>
      )}
      <dt>{text.shipping}</dt>
      <dd className="text-end tabular-nums">{!shippingKnown ? <span className="hint">{text.shippingLater}</span> : zero(totals.shippingTotal) ? text.free : amount(totals.shippingTotal)}</dd>
      {!totals.pricesIncludeTax ? (
        taxKnown && lines.length > 0 ? (
          lines.map((line) => (
            <div key={line.rate} className="contents">
              <dt>{text.vat(taxRate(line.rate, locale))}</dt>
              <dd className="text-end tabular-nums">{amount(line.amount)}</dd>
            </div>
          ))
        ) : (
          <>
            <dt>{text.vatTotal}</dt>
            <dd className="text-end tabular-nums">{taxKnown ? amount(totals.taxTotal) : <span className="hint">{text.vatLater}</span>}</dd>
          </>
        )
      ) : null}
      <dt className="border-t border-line pt-3 text-lg font-semibold">{text.total}</dt>
      <dd className="border-t border-line pt-3 text-end text-lg font-semibold tabular-nums">{amount(totals.total)}</dd>
      {totals.pricesIncludeTax && taxKnown && !zero(totals.taxTotal) ? <dd className="col-span-2 text-end hint">{text.vatIncluded(amount(totals.taxTotal))}</dd> : null}
    </dl>
  );
}
