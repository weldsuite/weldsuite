import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import type { ReconciliationLine } from '@/lib/api/domains/weldbooks-banking';
import { allTicked } from '../reconciliation-math';

interface LineTableProps {
  title: string;
  /** Lines after the search and cleared filters. */
  lines: readonly ReconciliationLine[];
  /** All lines of this side, filtered or not, for the counts. */
  totalCount: number;
  ticked: ReadonlySet<string>;
  tickedTotal: number;
  formatAmount: (amount: number) => string;
  formatDate: (date: string) => string;
  readOnly?: boolean;
  onToggle: (id: string, ticked: boolean) => void;
  onToggleAll: (lines: readonly ReconciliationLine[], ticked: boolean) => void;
  testId: string;
}

/** One side of the worksheet: deposits and credits, or checks and payments, each with a tick box. */
export function LineTable({
  title,
  lines,
  totalCount,
  ticked,
  tickedTotal,
  formatAmount,
  formatDate,
  readOnly,
  onToggle,
  onToggleAll,
  testId,
}: Readonly<LineTableProps>) {
  const { t } = useI18n();
  const tw = t.weldbooksUs.banking.worksheet;
  const everyVisibleTicked = allTicked(ticked, lines);
  const tickedCount = lines.filter((l) => ticked.has(l.id)).length;

  return (
    <section className="rounded-lg border bg-card" data-testid={testId}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={everyVisibleTicked}
            disabled={readOnly || lines.length === 0}
            onCheckedChange={(checked) => onToggleAll(lines, !!checked)}
            aria-label={tw.selectAll.replace('{title}', title)}
            data-testid={`${testId}-select-all`}
          />
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-summary`}>
          {tw.selectedOf
            .replace('{selected}', String(tickedCount))
            .replace('{total}', String(totalCount))
            .replace('{amount}', formatAmount(tickedTotal))}
        </p>
      </header>
      {lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{tw.noLines}</p>
      ) : (
        <ul className="max-h-[55vh] divide-y overflow-y-auto">
          {lines.map((line) => {
            const isTicked = ticked.has(line.id);
            const detail = [line.contactName, line.document?.number ?? line.entryNumber].filter(Boolean).join(' · ');
            return (
              <li key={line.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted/40',
                    isTicked && 'bg-primary/5',
                    readOnly && 'cursor-default',
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={isTicked}
                    disabled={readOnly}
                    onCheckedChange={(checked) => onToggle(line.id, !!checked)}
                    aria-label={tw.selectLine.replace('{description}', line.description ?? line.entryNumber ?? line.id)}
                    data-testid={`line-${line.id}`}
                  />
                  <span className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(line.date)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{line.description || line.document?.number || line.entryNumber || '—'}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {detail ? <span className="truncate">{detail}</span> : null}
                      {line.document?.checkNumber ? (
                        <Badge variant="outline">{tw.checkNumber.replace('{number}', line.document.checkNumber)}</Badge>
                      ) : null}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-sm font-medium tabular-nums">{formatAmount(line.amount)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
