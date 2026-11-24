import { isZeroMoney, type Address, type StorefrontOrder, type TaxLine } from '@weldsuite/commerce-sdk';
import type { ReactNode } from 'react';
import { useShop } from '../context';
import { format } from '../strings';
import { useMoney, useTaxRate } from './price';

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

function zero(amount: string): boolean {
  try {
    return isZeroMoney(amount);
  } catch {
    return false;
  }
}

/**
 * Subtotal, discount, shipping, VAT and total of a cart or order. VAT is per
 * rate when prices exclude it, and "including €x VAT" when they include it.
 */
export function Totals({
  totals,
  shippingKnown,
  taxKnown,
}: Readonly<{ totals: TotalsSource; shippingKnown: boolean; taxKnown: boolean }>) {
  const { shop } = useShop();
  const s = shop.strings.cart;
  const money = useMoney();
  const rate = useTaxRate();
  const amount = (value: string) => money(value, totals.currency);
  const lines = totals.taxLines ?? [];
  let shipping: ReactNode;
  if (!shippingKnown) shipping = <span className="shop-hint">{s.shippingLater}</span>;
  else if (zero(totals.shippingTotal)) shipping = s.shippingFree;
  else shipping = amount(totals.shippingTotal);
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
      <dt>{s.subtotal}</dt>
      <dd className="text-end tabular-nums">{amount(totals.subtotal)}</dd>
      {zero(totals.discountTotal) ? null : (
        <>
          <dt>{s.discount}</dt>
          <dd className="text-end tabular-nums">−{amount(totals.discountTotal)}</dd>
        </>
      )}
      <dt>{s.shipping}</dt>
      <dd className="text-end tabular-nums">{shipping}</dd>
      {!totals.pricesIncludeTax && taxKnown && lines.length > 0
        ? lines.map((line) => (
            <div key={line.rate} className="contents">
              <dt>{format(s.vat, { rate: rate(line.rate) })}</dt>
              <dd className="text-end tabular-nums">{amount(line.amount)}</dd>
            </div>
          ))
        : null}
      {!totals.pricesIncludeTax && taxKnown && lines.length === 0 ? (
        <>
          <dt>{s.vatTotal}</dt>
          <dd className="text-end tabular-nums">{amount(totals.taxTotal)}</dd>
        </>
      ) : null}
      {!totals.pricesIncludeTax && !taxKnown ? (
        <>
          <dt>{s.vatTotal}</dt>
          <dd className="text-end">
            <span className="shop-hint">{s.vatLater}</span>
          </dd>
        </>
      ) : null}
      <dt className="border-t border-shop-border pt-3 text-lg font-semibold">{s.grandTotal}</dt>
      <dd className="border-t border-shop-border pt-3 text-end text-lg font-semibold tabular-nums">{amount(totals.total)}</dd>
      {totals.pricesIncludeTax && taxKnown && !zero(totals.taxTotal) ? (
        <dd className="col-span-2 text-end shop-hint">{format(s.vatIncluded, { amount: amount(totals.taxTotal) })}</dd>
      ) : null}
    </dl>
  );
}

/** "NL" → "Netherlands", in the shop's language. */
export function useCountryName(): (code: string) => string {
  const { shop } = useShop();
  return (code) => {
    try {
      return new Intl.DisplayNames([shop.intlLocale], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
}

/** A postal address, one part per line. */
export function AddressLines({ address }: Readonly<{ address: Address | null }>) {
  const country = useCountryName();
  if (!address) return null;
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(' ');
  const parts = [address.name, address.company, address.line1, address.line2, cityLine, address.region, address.country ? country(address.country) : null];
  return (
    <address className="not-italic">
      {parts
        .filter((part): part is string => Boolean(part))
        .map((part, index) => (
          <span key={index} className="block">
            {part}
          </span>
        ))}
    </address>
  );
}

/** An order's lines and totals, for the order pages. */
export function OrderLines({ order }: Readonly<{ order: StorefrontOrder }>) {
  const { shop } = useShop();
  const s = shop.strings.order;
  const money = useMoney();
  return (
    <div className="flex flex-col gap-6">
      <table className="w-full text-start">
        <caption className="sr-only">{s.items}</caption>
        <thead>
          <tr className="border-b border-shop-border text-sm">
            <th scope="col" className="py-2 text-start font-medium">
              {s.item}
            </th>
            <th scope="col" className="py-2 text-end font-medium">
              {s.quantity}
            </th>
            <th scope="col" className="hidden py-2 text-end font-medium sm:table-cell">
              {s.unitPrice}
            </th>
            <th scope="col" className="py-2 text-end font-medium">
              {s.lineTotal}
            </th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id} className="border-b border-shop-border align-top">
              <td className="py-3 pe-3">
                <span className="block font-medium">{item.name}</span>
                {item.variantName ? <span className="block shop-hint">{item.variantName}</span> : null}
                {item.sku ? <span className="block shop-hint">{format(shop.strings.product.sku, { sku: item.sku })}</span> : null}
              </td>
              <td className="py-3 text-end tabular-nums">{item.quantity}</td>
              <td className="hidden py-3 text-end tabular-nums sm:table-cell">{money(item.unitPrice, order.currency)}</td>
              <td className="py-3 text-end tabular-nums">{money(item.total, order.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ms-auto w-full max-w-sm">
        <Totals totals={order} shippingKnown taxKnown />
      </div>
    </div>
  );
}
