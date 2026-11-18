/** A signal result: candidate events ranked by how strongly doing them early goes with reaching the goal. */

import type { PanelSignalResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber, formatPercent } from '../../lib/format';
import { useDefinitionLabels } from '../definitions';

/** A correlation bar from -1 to 1 around a middle line. */
function CorrelationBar({ value }: Readonly<{ value: number | null }>) {
  if (value === null) return <span className="text-muted-foreground">–</span>;
  const width = Math.min(50, Math.abs(value) * 50);
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-24 rounded bg-muted" aria-hidden>
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <div
          className={cn('absolute inset-y-0 rounded', value >= 0 ? 'left-1/2 bg-emerald-500/80' : 'right-1/2 bg-destructive/80')}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-12 text-right tabular-nums">{value.toFixed(2)}</span>
    </div>
  );
}

export function SignalResultView({ result }: Readonly<{ result: PanelSignalResult }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.signal;
  const labels = useDefinitionLabels();

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {format(tx.summary, { goalUsers: formatNumber(result.goalUsers, language), users: formatNumber(result.users, language), percent: formatPercent(result.goalRate, language) })}
      </p>
      {result.candidates.length === 0 ? (
        <EmptyText>{tx.none}</EmptyText>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx.columns.event}</TableHead>
                <TableHead className="text-right">{tx.columns.did}</TableHead>
                <TableHead className="text-right">{tx.columns.didRate}</TableHead>
                <TableHead className="text-right">{tx.columns.didNot}</TableHead>
                <TableHead className="text-right">{tx.columns.didNotRate}</TableHead>
                <TableHead className="text-right">{tx.columns.lift}</TableHead>
                <TableHead>{tx.columns.correlation}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.candidates.map((c) => (
                <TableRow key={c.event}>
                  <TableCell className="max-w-56 truncate font-medium" title={labels.event(c.event)}>
                    {labels.event(c.event)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.didUsers, language)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(c.didGoalRate, language)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.didNotUsers, language)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(c.didNotGoalRate, language)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {c.lift === null ? '–' : format(tx.liftValue, { value: new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(c.lift) })}
                  </TableCell>
                  <TableCell>
                    <CorrelationBar value={c.correlation} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
