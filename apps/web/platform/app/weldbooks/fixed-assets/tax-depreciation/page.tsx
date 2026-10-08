import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { US_STATES } from '@/components/address/us-states';
import { useTaxDepreciationReport } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../text';
import { MidQuarterCard } from '../components/mid-quarter-card';

const YEAR_CHOICES = 8;

function Line({ label, value, strong }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return (
    <div className="flex justify-between gap-3 border-b py-1.5 last:border-b-0">
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}>{value}</dd>
    </div>
  );
}

/** The year's tax depreciation in the shape of Form 4562, with the mid-quarter test of the year. US only. */
export default function TaxDepreciationPage() {
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const tt = fa.tax;
  const common = t.weldbooksUs.assets.common;
  const { code, isResolved, isError: jurisdictionError } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(code);
  const { formatMoney, formatDate, today } = useWeldbooksFormat();

  const [taxYear, setTaxYear] = useState<number | undefined>(undefined);
  const [book, setBook] = useState<'federal' | 'state'>('federal');
  const [stateCode, setStateCode] = useState('');

  const params = useMemo(
    () => ({ ...(taxYear ? { taxYear } : {}), book, ...(book === 'state' && stateCode ? { stateCode } : {}) }),
    [taxYear, book, stateCode],
  );
  const report = useTaxDepreciationReport(params, { enabled: isUs && (book === 'federal' || stateCode !== '') });
  const data = report.data;

  const currentYear = Number(today().slice(0, 4));
  const selectedYear = taxYear ?? data?.taxYear ?? currentYear;
  const yearOptions = useMemo(() => {
    const years = Array.from({ length: YEAR_CHOICES }, (_, index) => currentYear + 1 - index);
    return years.includes(selectedYear) ? years : [...years, selectedYear].sort((a, b) => b - a);
  }, [currentYear, selectedYear]);

  if (!isResolved && !jurisdictionError) return <PageLoader fullScreen={false} />;

  if (!isUs) {
    return (
      <div className="space-y-2 p-4 sm:p-6">
        <h1 className="text-2xl font-semibold">{tt.title}</h1>
        <p className="text-sm text-muted-foreground">{common.usOnly}</p>
      </div>
    );
  }

  const form = data?.form4562;
  const classLabels = fa.classes as Record<string, string>;

  let body: React.ReactNode;
  if (book === 'state' && !stateCode) {
    body = <p className="text-sm text-muted-foreground">{tt.chooseState}</p>;
  } else if (report.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (report.isError || !data || !form) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-sm text-destructive" role="alert">
            {tt.loadFailed}
          </p>
          <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
            {common.retry}
          </Button>
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          {tt.description} · {formatDate(data.start)} – {formatDate(data.end)}
        </p>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card data-testid="form-part1">
            <CardHeader>
              <CardTitle className="text-base">{tt.part1.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="text-sm">
                <Line label={tt.part1.totalCost} value={formatMoney(form.part1.totalCostOfSection179Property)} />
                {form.part1.limit !== null ? <Line label={tt.part1.limit} value={formatMoney(form.part1.limit)} /> : null}
                {form.part1.phaseOutThreshold !== null ? (
                  <Line label={tt.part1.threshold} value={formatMoney(form.part1.phaseOutThreshold)} />
                ) : null}
                <Line label={tt.part1.reduction} value={formatMoney(form.part1.reduction)} />
                {form.part1.dollarLimit !== null ? <Line label={tt.part1.dollarLimit} value={formatMoney(form.part1.dollarLimit)} /> : null}
                <Line label={tt.part1.elected} value={formatMoney(form.part1.elected)} />
                <Line label={tt.part1.deduction} value={formatMoney(form.part1.deduction)} strong />
              </dl>
            </CardContent>
          </Card>

          <Card data-testid="form-part2">
            <CardHeader>
              <CardTitle className="text-base">{tt.part2.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="text-sm">
                <Line label={tt.part2.bonus} value={formatMoney(form.part2.bonus)} strong />
              </dl>
            </CardContent>
          </Card>
        </div>

        <Card data-testid="form-part3">
          <CardHeader>
            <CardTitle className="text-base">{tt.part3.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="text-sm">
              <Line label={tt.part3.priorYear} value={formatMoney(form.part3.priorYearAssets)} />
            </dl>
            <div className="space-y-2">
              <p className="text-sm font-medium">{tt.part3.currentYear}</p>
              {form.part3.currentYearAssets.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tt.part3.none}</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tt.part3.class}</TableHead>
                        <TableHead>{tt.part3.convention}</TableHead>
                        <TableHead>{tt.part3.method}</TableHead>
                        <TableHead className="text-right">{tt.part3.count}</TableHead>
                        <TableHead className="text-right">{tt.part3.basis}</TableHead>
                        <TableHead className="text-right">{tt.part3.depreciation}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {form.part3.currentYearAssets.map((row) => (
                        <TableRow key={`${row.recoveryYears}-${row.convention}-${row.method}`}>
                          <TableCell>{classLabels[String(row.recoveryYears)] ?? fill(fa.detail.book.years, { years: row.recoveryYears })}</TableCell>
                          <TableCell>{(fa.conventions as Record<string, string>)[row.convention] ?? row.convention}</TableCell>
                          <TableCell>{(fa.methods as Record<string, string>)[row.method] ?? row.method}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(row.basis)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(row.depreciation)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <dl className="text-sm">
                <Line label={tt.part3.currentYearTotal} value={formatMoney(form.part3.currentYearTotal)} />
              </dl>
            </div>
          </CardContent>
        </Card>

        {form.listedProperty.length > 0 ? (
          <Card data-testid="form-listed">
            <CardHeader>
              <CardTitle className="text-base">{tt.listed.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tt.listed.asset}</TableHead>
                      <TableHead className="text-right">{tt.listed.businessUse}</TableHead>
                      <TableHead className="text-right">{tt.listed.total}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {form.listedProperty.map((row) => (
                      <TableRow key={row.assetId}>
                        <TableCell>
                          <Link to="/weldbooks/fixed-assets/$id" params={{ id: row.assetId }} className="underline-offset-2 hover:underline">
                            {row.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{row.businessUsePercent}%</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(row.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardContent className="py-4">
            <dl>
              <Line label={tt.total} value={formatMoney(form.total)} strong />
            </dl>
          </CardContent>
        </Card>

        {data.lines.length === 0 ? (
          <Card>
            <CardContent className="space-y-1 py-8 text-center">
              <p className="font-medium">{tt.emptyTitle}</p>
              <p className="text-sm text-muted-foreground">{fill(tt.emptyDescription, { book: fa.bookKinds[book].toLowerCase() })}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            <h2 className="text-base font-semibold">{tt.lines.title}</h2>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tt.lines.asset}</TableHead>
                    <TableHead>{tt.lines.placedInService}</TableHead>
                    <TableHead className="text-right">{tt.lines.cost}</TableHead>
                    <TableHead className="text-right">{tt.lines.businessUse}</TableHead>
                    <TableHead>{tt.lines.method}</TableHead>
                    <TableHead className="text-right">{tt.lines.basis}</TableHead>
                    <TableHead className="text-right">{tt.lines.section179}</TableHead>
                    <TableHead className="text-right">{tt.lines.bonus}</TableHead>
                    <TableHead className="text-right">{tt.lines.macrs}</TableHead>
                    <TableHead className="text-right">{tt.lines.total}</TableHead>
                    <TableHead className="text-right">{tt.lines.accumulated}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((line) => (
                    <TableRow key={line.assetId}>
                      <TableCell className="max-w-[240px]">
                        <Link to="/weldbooks/fixed-assets/$id" params={{ id: line.assetId }} className="font-medium underline-offset-2 hover:underline">
                          {line.name}
                        </Link>
                        {line.placedInServiceThisYear ? null : <Badge variant="outline" className="ml-2">{tt.part3.priorYear}</Badge>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(line.placedInServiceDate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{line.businessUsePercent}%</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {(fa.methods as Record<string, string>)[line.method] ?? line.method} ·{' '}
                        {fill(fa.detail.book.years, { years: line.recoveryYears })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.depreciableBasis)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.section179)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.bonus)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.macrs)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatMoney(line.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.accumulated)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <MidQuarterCard report={data.midQuarter} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={common.back}>
          <Link to="/weldbooks/fixed-assets">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{tt.title}</h1>
          <p className="text-sm text-muted-foreground">{tt.subtitle}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36 space-y-1.5">
          <Label htmlFor="tax-year">{tt.taxYear}</Label>
          <Select value={String(selectedYear)} onValueChange={(value) => setTaxYear(Number(value))}>
            <SelectTrigger id="tax-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((year) => (
                <SelectItem key={year} value={String(year)}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44 space-y-1.5">
          <Label htmlFor="tax-book">{tt.book}</Label>
          <Select value={book} onValueChange={(value) => setBook(value as 'federal' | 'state')}>
            <SelectTrigger id="tax-book">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="federal">{fa.bookKinds.federal}</SelectItem>
              <SelectItem value="state">{fa.bookKinds.state}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {book === 'state' ? (
          <div className="w-56 space-y-1.5">
            <Label htmlFor="tax-state">{tt.state}</Label>
            <Select value={stateCode} onValueChange={setStateCode}>
              <SelectTrigger id="tax-state">
                <SelectValue placeholder={tt.chooseState} />
              </SelectTrigger>
              <SelectContent>
                {US_STATES.map((state) => (
                  <SelectItem key={state.code} value={state.code}>
                    {state.code} — {state.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {body}
    </div>
  );
}
