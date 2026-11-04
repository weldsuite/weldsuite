import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { financeVerdict, formatDay, formatMoney, formatPercent } from '../_lib/close';
import { useClose } from './close-context';

const TILE_BG = {
  warn: 'bg-orange-50 dark:bg-orange-950/30',
  good: 'bg-green-50 dark:bg-green-950/30',
  none: 'bg-muted/50',
} as const;

function verdictTone(kind: string): 'warn' | 'good' | undefined {
  if (kind === 'over') return 'warn';
  if (kind === 'under') return 'good';
  return undefined;
}

function Tile({ label, value, tone }: Readonly<{ label: string; value: string; tone?: 'warn' | 'good' }>) {
  return (
    <div
      className={cn(
        'rounded-lg px-3 py-2.5',
        TILE_BG[tone ?? 'none'],
      )}
    >
      <div className={cn('text-xs', tone === 'warn' ? 'text-orange-800 dark:text-orange-300' : 'text-muted-foreground')}>{label}</div>
      <div className={cn('mt-0.5 text-base font-semibold', tone === 'warn' && 'text-orange-800 dark:text-orange-300')}>{value}</div>
    </div>
  );
}

/** Final cost against the budget. Without finance access only the verdict and the percentage show. */
export function FinanceCard() {
  const { t, language, format } = useI18n();
  const copy = t.flowClosing.close.finance;
  const { checklist, projectId } = useClose();
  const finance = checklist.finance;
  const locale = intlLocaleOf(language);
  const verdict = financeVerdict(finance);
  const money = (value: string | number | null) => formatMoney(value, finance.currency, locale);

  const showVerdictAmount = verdict.kind !== 'none' && finance.amountsVisible;
  const verdictValue = [
    showVerdictAmount && verdict.amount !== null ? money(verdict.amount) : null,
    verdict.percent !== null ? formatPercent(verdict.percent, locale) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  let source = copy.percentOnly;
  if (finance.amountsVisible) {
    source = finance.snapshot ? format(copy.sourceSnapshot, { week: finance.snapshot.week }) : copy.sourceTime;
  }

  return (
    <section aria-labelledby="close-finance-title" className="rounded-xl border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="close-finance-title" className="text-sm font-semibold">
          {copy.title}
        </h3>
        <Link href={`/weldflow/project/${projectId}/finance`} className="text-[13px] text-primary hover:underline">
          {copy.openFinance}
        </Link>
      </div>
      <div className="mt-2.5 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]">
        {finance.amountsVisible ? (
          <>
            <Tile
              label={finance.baseline ? format(copy.budgetBaseline, { version: finance.baseline.version }) : copy.budget}
              value={money(finance.budget)}
            />
            <Tile label={copy.actual} value={money(finance.actual)} />
          </>
        ) : null}
        <Tile
          label={copy.verdict[verdict.kind]}
          value={verdictValue || '—'}
          tone={verdictTone(verdict.kind)}
        />
        <Tile
          label={copy.goLive}
          value={
            finance.baseline?.goLive
              ? format(copy.goLiveBaseline, { date: formatDay(finance.baseline.goLive, locale), version: finance.baseline.version })
              : copy.noGoLive
          }
        />
      </div>
      <p className="mt-2.5 text-xs text-muted-foreground">
        {source}
      </p>
    </section>
  );
}
