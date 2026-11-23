import { compareMoney, formatMoney, formatTaxRate } from '@weldsuite/commerce-sdk';
import { useShop } from '../context';
import { format } from '../strings';

/** A formatter for amounts in the shop's language; a malformed amount is shown as it came. */
export function useMoney(): (amount: string, currency?: string) => string {
  const { shop } = useShop();
  return (amount, currency = shop.channel.currency) => {
    try {
      return formatMoney(amount, currency, { locale: shop.intlLocale });
    } catch {
      return amount;
    }
  };
}

/** A tax rate ("21.00") as a percentage in the shop's language. */
export function useTaxRate(): (rate: string) => string {
  const { shop } = useShop();
  return (rate) => {
    try {
      return formatTaxRate(rate, shop.intlLocale);
    } catch {
      return `${rate}%`;
    }
  };
}

function isLower(amount: string, than: string | null): than is string {
  if (!than) return false;
  try {
    return compareMoney(amount, than) < 0;
  } catch {
    return false;
  }
}

export interface PriceProps {
  amount: string;
  compareAt?: string | null;
  currency?: string;
  /** The lowest of several variant prices: "From €10". */
  from?: boolean;
  className?: string;
}

/**
 * A price, with the old price struck through on a sale. Nothing when the
 * shop hides prices from guests (the page says so once, not per product).
 */
export function Price({ amount, compareAt = null, currency, from = false, className }: Readonly<PriceProps>) {
  const { shop } = useShop();
  const money = useMoney();
  if (!shop.showPrices) return null;
  const s = shop.strings.price;
  const price = money(amount, currency);
  const label = from ? format(s.from, { price }) : price;
  if (isLower(amount, compareAt)) {
    const was = money(compareAt, currency);
    return (
      <span className={className}>
        <span className="sr-only">{`${format(s.now, { price: label })}, ${format(s.was, { price: was })}`}</span>
        <span aria-hidden="true" className="font-semibold tabular-nums">
          {label}
        </span>{' '}
        <s aria-hidden="true" className="text-shop-subtle tabular-nums">
          {was}
        </s>
      </span>
    );
  }
  return <span className={`tabular-nums ${className ?? ''}`}>{label}</span>;
}

/** "incl. VAT" / "excl. VAT", as the channel shows prices. */
export function VatNote({ className = 'shop-hint' }: Readonly<{ className?: string }>) {
  const { shop } = useShop();
  if (!shop.showPrices) return null;
  return <span className={className}>{shop.channel.pricesIncludeTax ? shop.strings.price.inclVat : shop.strings.price.exclVat}</span>;
}
