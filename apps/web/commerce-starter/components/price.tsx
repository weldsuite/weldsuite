import { compareMoney } from '@weldsuite/commerce-sdk';

import { money } from '@/lib/format';

/** A price, with the old price struck through when it was higher. */
export function Price({
  amount,
  compareAt,
  currency,
  locale,
  className = '',
}: {
  amount: string;
  compareAt?: string | null;
  currency: string;
  locale: string;
  className?: string;
}) {
  const reduced = compareAt && compareMoney(compareAt, amount) > 0;
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-2 ${className}`}>
      {reduced ? <span className="sr-only">Sale price</span> : null}
      <span className="font-semibold">{money(amount, currency, locale)}</span>
      {reduced ? (
        <>
          <span className="sr-only">, was</span>
          <s className="text-sm text-ink-muted">{money(compareAt, currency, locale)}</s>
        </>
      ) : null}
    </span>
  );
}
