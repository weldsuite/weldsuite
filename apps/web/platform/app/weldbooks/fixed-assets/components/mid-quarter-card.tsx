import { CheckCircle2, Info } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { MidQuarterReport } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { formatShare } from '../asset-math';
import { fill } from '../text';

/**
 * The mid-quarter test of a tax year: how the year's basis falls over the
 * quarters, the verdict, and the assets the test counted or left out.
 */
export function MidQuarterCard({ report }: Readonly<{ report: MidQuarterReport }>) {
  const { t } = useI18n();
  const tm = t.weldbooksUs.assets.fixedAssets.tax.midQuarter;
  const fa = t.weldbooksUs.assets.fixedAssets;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const reasons = tm.excludedReasons as Record<string, string>;

  return (
    <Card data-testid="mid-quarter-card" data-applies={report.applies ? 'true' : 'false'}>
      <CardHeader>
        <CardTitle className="text-base">{fill(tm.title, { year: report.taxYear })}</CardTitle>
        <CardDescription>{tm.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {report.assets.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="h-4 w-4" aria-hidden />
            {tm.none}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={report.applies ? 'warning' : 'success'} className="gap-1.5" data-testid="mid-quarter-verdict">
                {report.applies ? null : <CheckCircle2 aria-hidden />}
                {report.applies ? tm.applies : tm.doesNotApply}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {tm.share}: <span className="font-medium tabular-nums text-foreground">{formatShare(report.lastQuarterShare)}</span> ·{' '}
                {tm.threshold}: <span className="tabular-nums">{formatShare(report.threshold)}</span>
              </span>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">{tm.quarterBasis}</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {report.quarterBasis.map((amount, index) => (
                  <div key={index} className="rounded-md border p-3">
                    <dt className="text-xs text-muted-foreground">{fill(tm.quarter, { number: index + 1 })}</dt>
                    <dd className="font-medium tabular-nums">{formatMoney(amount)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                {tm.totalBasis}: {formatMoney(report.totalBasis)} · {tm.lastQuarter}: {formatMoney(report.lastQuarterBasis)}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">{tm.assetsTitle}</p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tm.asset}</TableHead>
                      <TableHead>{tm.placedInService}</TableHead>
                      <TableHead className="text-right">{tm.quarterColumn}</TableHead>
                      <TableHead className="text-right">{tm.basis}</TableHead>
                      <TableHead>{tm.counted}</TableHead>
                      <TableHead>{tm.convention}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.assets.map((asset) => (
                      <TableRow key={asset.assetId}>
                        <TableCell className="max-w-[240px] truncate font-medium">{asset.name}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(asset.placedInServiceDate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{asset.quarter}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(asset.basis)}</TableCell>
                        <TableCell>
                          {asset.counted ? (
                            <Badge variant="secondary">{fa.tax.midQuarter.counted}</Badge>
                          ) : (
                            <Badge variant="outline">
                              {tm.excluded}
                              {asset.excludedReason ? `: ${reasons[asset.excludedReason] ?? asset.excludedReason}` : ''}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {(fa.conventions as Record<string, string>)[asset.convention] ?? asset.convention}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
