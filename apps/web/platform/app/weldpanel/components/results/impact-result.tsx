/**
 * An impact result: how adoption grew after the launch, the metric for
 * adopters and everyone else before and after, and the difference in
 * differences (how much more the adopters changed).
 */

import type { PanelImpactResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatBucket, formatNumber, formatPercent, formatSignedPercent } from '../../lib/format';
import { ValueLineChart } from './charts';

interface ImpactResultViewProps {
  result: PanelImpactResult;
  /** `unique_users` measures a share: values read as percentages. */
  math?: string;
  compact?: boolean;
}

export function ImpactResultView({ result, math, compact = false }: Readonly<ImpactResultViewProps>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.impact;
  const share = math === 'unique_users';
  const value = (v: number | null) => {
    if (v === null) return '–';
    return share ? formatPercent(v, language) : new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(v);
  };
  const signed = (v: number | null) => {
    if (v === null) return '–';
    return share ? formatSignedPercent(v, language) : new Intl.NumberFormat(language, { maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(v);
  };
  const tone = (v: number | null) => {
    if (v === null || v === 0) return undefined;
    return v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive';
  };
  const data = result.adoption.map((p) => ({ label: formatBucket(p.bucket, 'day', language), bucket: p.bucket, rate: p.rate }));

  return (
    <div className="grid gap-5">
      <KpiGrid className="sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={tx.differenceInDifferences} value={<span className={tone(result.differenceInDifferences)}>{signed(result.differenceInDifferences)}</span>} hint={tx.differenceHint} />
        <KpiCard
          label={tx.relativeImpact}
          value={<span className={tone(result.relativeImpact)}>{result.relativeImpact === null ? '–' : formatSignedPercent(result.relativeImpact, language)}</span>}
          hint={tx.relativeHint}
        />
        <KpiCard label={tx.adopters} value={formatNumber(result.adopters.users, language)} />
        <KpiCard label={tx.nonAdopters} value={formatNumber(result.nonAdopters.users, language)} />
      </KpiGrid>

      {result.adopters.users === 0 ? (
        <EmptyText>{tx.noAdopters}</EmptyText>
      ) : (
        !compact && (
          <section className="grid gap-2" aria-label={tx.adoption}>
            <h3 className="text-sm font-medium">{tx.adoption}</h3>
            <ValueLineChart
              data={data}
              series={[{ key: 'rate', label: tx.adoptionRate }]}
              locale={language}
              format={(v) => formatPercent(v, language)}
              axisFormat={(v) => formatPercent(v, language, 0)}
              legend={false}
            />
          </section>
        )
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tx.group}</TableHead>
              <TableHead className="text-right">{tx.people}</TableHead>
              <TableHead className="text-right">{tx.before}</TableHead>
              <TableHead className="text-right">{tx.after}</TableHead>
              <TableHead className="text-right">{tx.change}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              [
                ['adopters', tx.adopters, result.adopters],
                ['nonAdopters', tx.nonAdopters, result.nonAdopters],
              ] as const
            ).map(([key, label, group]) => (
              <TableRow key={key}>
                <TableCell className="font-medium">{label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(group.users, language)}</TableCell>
                <TableCell className="text-right tabular-nums">{value(group.before)}</TableCell>
                <TableCell className="text-right tabular-nums">{value(group.after)}</TableCell>
                <TableCell className={cn('text-right tabular-nums', tone(group.change))}>{signed(group.change)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
