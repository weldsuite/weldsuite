import { compareMoney } from '@weldsuite/commerce-sdk';

import { config } from '../lib/client';
import { money } from '../lib/format';
import { text } from '../lib/messages';

function lower(amount: string, than: string | null): than is string {
  if (!than) return false;
  try {
    return compareMoney(amount, than) < 0;
  } catch {
    return false;
  }
}

/** A price, with the old one struck through on a sale. */
export function Price({ amount, compareAt = null, currency, from = false }: Readonly<{ amount: string; compareAt?: string | null; currency: string; from?: boolean }>) {
  const locale = config?.locale ?? 'en-IE';
  const label = from ? text.from(money(amount, currency, locale)) : money(amount, currency, locale);
  if (!lower(amount, compareAt)) return <span className="tabular-nums">{label}</span>;
  const was = money(compareAt, currency, locale);
  return (
    <span className="tabular-nums">
      <span className="font-semibold">{label}</span>{' '}
      <span className="sr-only">{text.was(was)}</span>
      <s aria-hidden="true" className="text-ink-muted">
        {was}
      </s>
    </span>
  );
}
