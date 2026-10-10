/**
 * The live "WeldSuite bills / you keep" figures for a licence being edited.
 *
 * The numbers come from `priceWorkspaceMonth`, the same function the monthly
 * statement uses, fed with the contract from the overview endpoint, so what the
 * partner sees while typing is what the statement will say for a full month.
 */

import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import type { PricingContract } from '@weldsuite/app-api-client/schemas/partners';
import { useI18n } from '@/lib/i18n/provider';
import { formatPercentBps } from '@/lib/partner/money';
import { cn } from '@/lib/utils';
import { previewDraft, type LicenceDraft } from '../lib/licence-draft';
import { useFormatters } from './kit';

interface LicencePreviewProps {
  contract: PricingContract | null | undefined;
  draft: LicenceDraft;
  /** Billable seats the estimate assumes (matters for per-seat pricing). */
  seats: number;
  /** When given, per-seat pricing shows an input to try other seat counts. */
  onSeatsChange?: (seats: number) => void;
}

function Row({
  label,
  value,
  hint,
  strong,
  tone,
  testId,
}: Readonly<{
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  tone?: 'negative' | 'positive';
  testId: string;
}>) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className={cn('text-sm', strong ? 'font-medium' : 'text-muted-foreground')}>{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <p
        data-testid={testId}
        className={cn(
          'shrink-0 tabular-nums',
          strong ? 'text-lg font-semibold' : 'text-sm',
          tone === 'negative' && 'text-destructive',
          tone === 'positive' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function LicencePreview({ contract, draft, seats, onSeatsChange }: Readonly<LicencePreviewProps>) {
  const { t, format } = useI18n();
  const f = useFormatters();
  const tp = t.partner.preview;

  if (!contract) {
    return <p className="text-sm text-muted-foreground">{tp.noContract}</p>;
  }

  const price = previewDraft(contract, draft, seats);
  const perSeat = draft.pricingModel === 'per_seat';

  return (
    <section aria-label={tp.title} className="rounded-xl border bg-muted/30 p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">{tp.title}</h3>
        {perSeat && onSeatsChange && (
          <div className="flex items-center gap-2">
            <Label htmlFor="preview-seats" className="text-xs text-muted-foreground">
              {format(tp.seatsAssumed, { count: seats })}
            </Label>
            <Input
              id="preview-seats"
              type="number"
              min={0}
              className="h-8 w-20"
              value={seats}
              onChange={(e) => onSeatsChange(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
        )}
      </div>

      {price ? (
        <>
          <div className="divide-y">
            <Row testId="preview-resale" label={tp.customerPays} value={f.cents(price.resale)} />
            <Row
              testId="preview-share"
              label={format(tp.weldsuiteShare, { percent: formatPercentBps(contract.revenueShareBps) })}
              value={f.cents(price.share)}
            />
            <Row
              testId="preview-floor"
              label={tp.minimum}
              hint={format(tp.minimumBreakdown, { base: f.cents(price.baseFloor), credits: f.cents(price.creditFloor) })}
              value={f.cents(price.floor)}
            />
            <Row testId="preview-due" label={tp.weldsuiteBills} value={f.cents(price.due)} strong />
            <Row
              testId="preview-margin"
              label={tp.youKeep}
              value={f.cents(price.margin)}
              strong
              tone={price.margin < 0 ? 'negative' : 'positive'}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground" data-testid="preview-basis">
            {price.margin < 0 ? tp.negativeMargin : price.basis === 'share' ? tp.basisShare : tp.basisFloor}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{tp.footnote}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{tp.invalidPrice}</p>
      )}
    </section>
  );
}
