/** A stickiness result: how many people (or groups) were active in 1, 2, 3… days or weeks, or did the event so many times. */

import type { PanelStickinessResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber, formatPercent } from '../../lib/format';
import { CategoryBarChart } from './charts';

export function StickinessResultView({ result, compact = false }: Readonly<{ result: PanelStickinessResult; compact?: boolean }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.stickiness;
  const axis = result.measure === 'count' ? tx.axis.count : tx.axis[result.interval];
  const data = result.buckets.map((b) => ({ label: b.label, count: b.count }));

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{format(tx.total, { count: formatNumber(result.total, language) })}</p>
      <CategoryBarChart data={data} series={[{ key: 'count', label: tx.columns.count }]} locale={language} legend={false} />
      <p className="text-center text-xs text-muted-foreground">{axis}</p>
      {!compact && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{axis}</TableHead>
                <TableHead className="text-right">{tx.columns.count}</TableHead>
                <TableHead className="text-right">{tx.columns.share}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.buckets.map((b) => (
                <TableRow key={b.label}>
                  <TableCell className="font-medium tabular-nums">{b.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(b.count, language)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(b.share, language)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
