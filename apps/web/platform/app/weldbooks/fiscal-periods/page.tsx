import { useMemo, useState } from 'react';
import { CalendarRange, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
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
import { useFiscalCalendar, useGenerateFiscalPeriods } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { GenerateFiscalPeriodsResult } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { errorMessage, fill } from '../fixed-assets/text';

const YEAR_CHOICES = 7;

/** The periods of a fiscal year the entity's setup defines (calendar months, or 4-4-5 weeks) and the ones still to create. */
export default function FiscalPeriodsPage() {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const common = t.weldbooksUs.assets.common;
  const { can } = usePermissions();
  const { formatDate, today } = useWeldbooksFormat();

  const currentYear = Number(today().slice(0, 4));
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [includeQuarters, setIncludeQuarters] = useState(false);
  const [includeYear, setIncludeYear] = useState(false);
  const [generated, setGenerated] = useState<GenerateFiscalPeriodsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => ({ fiscalYear, includeQuarters, includeYear }), [fiscalYear, includeQuarters, includeYear]);
  const calendar = useFiscalCalendar(params);
  const generate = useGenerateFiscalPeriods();
  const data = calendar.data;

  const yearOptions = useMemo(
    () => Array.from({ length: YEAR_CHOICES }, (_, index) => currentYear + 2 - index),
    [currentYear],
  );
  const missing = data?.periods.filter((period) => period.existingId === null).length ?? 0;
  const weekBased = data?.kind === 'fifty_two_fifty_three';

  const submit = async () => {
    setError(null);
    try {
      const result = await generate.mutateAsync(params);
      setGenerated(result);
      toast.success(fill(tf.generatedToast, { count: result.created.length }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  let body: React.ReactNode;
  if (calendar.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (calendar.isError || !data) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-sm text-destructive" role="alert">
            {tf.loadFailed}
          </p>
          <Button variant="outline" size="sm" onClick={() => void calendar.refetch()}>
            {common.retry}
          </Button>
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3" data-testid="fiscal-summary">
          <Badge variant={weekBased ? 'warning' : 'secondary'} className="gap-1.5">
            <CalendarRange aria-hidden />
            {weekBased ? tf.kinds.fifty_two_fifty_three : tf.kinds.month}
          </Badge>
          {data.weeks ? (
            <Badge variant={data.weeks === 53 ? 'warning' : 'outline'} data-testid="fiscal-weeks">
              {fill(tf.weeks, { weeks: data.weeks })}
            </Badge>
          ) : null}
          <span className="text-sm text-muted-foreground">
            {formatDate(data.startDate)} – {formatDate(data.endDate)}
          </span>
        </div>
        {weekBased ? (
          <p className="text-sm text-muted-foreground">{data.weeks === 53 ? tf.weekBasedNote53 : tf.weekBasedNote}</p>
        ) : null}

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tf.columns.period}</TableHead>
                <TableHead>{tf.columns.type}</TableHead>
                <TableHead>{tf.columns.dates}</TableHead>
                {weekBased ? <TableHead className="text-right">{tf.columns.weeks}</TableHead> : null}
                <TableHead>{tf.columns.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.periods.map((period) => (
                <TableRow key={`${period.type}-${period.startDate}-${period.endDate}`} data-testid={`fiscal-period-${period.name}`}>
                  <TableCell className="whitespace-nowrap font-medium">{period.name}</TableCell>
                  <TableCell>{tf.types[period.type]}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(period.startDate)} – {formatDate(period.endDate)}
                  </TableCell>
                  {weekBased ? (
                    <TableCell className="text-right tabular-nums">
                      {period.weeks === null ? '' : period.weeks}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <Badge variant={period.existingId ? 'success' : 'outline'}>{period.existingId ? tf.exists : tf.toCreate}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {generated ? (
          <p className="text-sm text-muted-foreground" data-testid="fiscal-generated">
            {fill(tf.generatedSummary, { created: generated.created.length, skipped: generated.skipped.length })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">{tf.title}</h1>
        <p className="text-sm text-muted-foreground">{tf.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-40 space-y-1.5">
          <Label htmlFor="fiscal-year">{tf.fiscalYear}</Label>
          <Select
            value={String(fiscalYear)}
            onValueChange={(value) => {
              setFiscalYear(Number(value));
              setGenerated(null);
            }}
          >
            <SelectTrigger id="fiscal-year">
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
          <p className="text-xs text-muted-foreground">{tf.fiscalYearHelp}</p>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox id="fiscal-quarters" checked={includeQuarters} onCheckedChange={(checked) => setIncludeQuarters(checked === true)} />
          <Label htmlFor="fiscal-quarters" className="font-normal">
            {tf.includeQuarters}
          </Label>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox id="fiscal-whole-year" checked={includeYear} onCheckedChange={(checked) => setIncludeYear(checked === true)} />
          <Label htmlFor="fiscal-whole-year" className="font-normal">
            {tf.includeYear}
          </Label>
        </div>
        {can('reports:create') ? (
          <Button onClick={() => void submit()} disabled={generate.isPending || missing === 0 || !data} data-testid="fiscal-generate">
            {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {missing === 0 && data ? tf.nothingToCreate : fill(tf.generate, { count: missing })}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="fiscal-error">
          {error}
        </p>
      ) : null}

      {body}
    </div>
  );
}
