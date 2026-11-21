/**
 * The order's total as the server priced it. The figures update after a short
 * pause in typing; a status line says so for screen readers (`role="status"`
 * is polite, so typing isn't interrupted).
 */

import { Check } from 'lucide-react';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { DiscountProblem, OrderQuote } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from '../../lib/text';
import { money } from '../../lib/orders';
import { rateText, vatTreatmentText } from '../../lib/vat';

/** A discount problem in words; null when there is none. */
export function discountProblemText(problem: DiscountProblem | string | null | undefined): string | null {
  if (!problem) return null;
  const t = getTranslations('commerce').orders.quote;
  const known: Record<string, string> = t.discountProblems;
  return known[problem] ?? t.discountProblemUnknown;
}

function Row({ label, value, strong }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return (
    <div className={strong ? 'flex justify-between border-t pt-2 text-base font-semibold' : 'flex justify-between text-sm'}>
      <dt className={strong ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function OrderQuoteSummary({
  quote,
  currency,
  isFetching,
  isError,
  hasItems,
}: Readonly<{
  quote: OrderQuote | undefined;
  currency: string;
  isFetching: boolean;
  isError: boolean;
  hasItems: boolean;
}>) {
  const t = getTranslations('commerce').orders.quote;
  const tp = getTranslations('commerce').orders.panel.totals;
  const tv = getTranslations('commerce').orders.panel.vat;
  const showTotals = hasItems && quote !== undefined;
  const treatment = quote ? vatTreatmentText(quote.vatTreatment, quote.destinationCountry) : null;

  return (
    <section aria-labelledby="order-quote-title" className="grid gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 id="order-quote-title" className="text-sm font-semibold">
          {t.title}
        </h2>
        {isFetching && <InlineSpinner />}
      </div>
      <p role="status" className="sr-only">
        {isFetching ? t.updating : ''}
      </p>

      {!hasItems && <p className="text-sm text-muted-foreground">{t.noItems}</p>}
      {hasItems && isError && !quote && (
        <p role="alert" className="text-sm text-destructive">
          {t.failed}
        </p>
      )}

      {showTotals && (
        <dl className="grid gap-1.5">
          <Row label={tp.subtotal} value={money(quote.subtotal, currency)} />
          {Number(quote.discountTotal) > 0 && <Row label={tp.discount} value={`−${money(quote.discountTotal, currency)}`} />}
          <Row label={tp.shipping} value={money(quote.shippingTotal, currency)} />
          {Number(quote.vatRelief) > 0 && <Row label={tv.relief} value={`−${money(quote.vatRelief, currency)}`} />}
          {quote.taxLines
            .filter((line) => Number(line.amount) > 0)
            .map((line) => (
              <Row key={line.rate} label={fill(quote.pricesIncludeTax ? tv.rateIncluded : tv.rate, { rate: rateText(line.rate) })} value={money(line.amount, currency)} />
            ))}
          <Row label={tp.total} value={money(quote.total, currency)} strong />
        </dl>
      )}

      {showTotals && (
        <div className="grid gap-2 text-xs text-muted-foreground">
          {treatment && <p>{treatment}</p>}
          <p>{quote.pricesIncludeTax ? t.vatIncluded : t.vatExcluded}</p>
          {quote.viesUnavailable && <InfoBanner variant="warning">{tv.viesWarning}</InfoBanner>}
        </div>
      )}

      {quote?.discount && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
          <Check className="h-4 w-4" aria-hidden="true" />
          {fill(t.discountApplied, { code: quote.discount.code })}
        </p>
      )}
    </section>
  );
}
