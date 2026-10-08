import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useRunDepreciation } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { DepreciationRunResult } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { endOfLastMonth } from '../asset-math';
import { errorMessage, fill } from '../text';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Post the ledger book's unposted depreciation, month by month, up to a date. */
export default function DepreciationRunPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.assets.fixedAssets.run;
  const common = t.weldbooksUs.assets.common;
  const { can } = usePermissions();
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const run = useRunDepreciation();

  const [through, setThrough] = useState(() => endOfLastMonth(today()));
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<DepreciationRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dateValid = ISO_DATE.test(through);

  if (!can('journal:create')) {
    return <div className="p-6 text-sm text-muted-foreground">{common.noAccess}</div>;
  }

  const execute = async () => {
    setError(null);
    try {
      const outcome = await run.mutateAsync(through);
      setResult(outcome);
      setConfirming(false);
      if (outcome.posted.some((period) => !period.alreadyPosted)) toast.success(fill(tr.resultTitle, { date: formatDate(outcome.through) }));
    } catch (err) {
      setConfirming(false);
      setError(errorMessage(err));
    }
  };

  const newEntries = result?.posted.filter((period) => !period.alreadyPosted).length ?? 0;

  return (
    <div className="max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={common.back}>
          <Link to="/weldbooks/fixed-assets">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{tr.title}</h1>
          <p className="text-sm text-muted-foreground">{tr.subtitle}</p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 py-6">
          <p className="text-sm text-muted-foreground">{tr.description}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="run-through">{tr.through}</Label>
              <Input id="run-through" type="date" value={through} onChange={(event) => setThrough(event.target.value)} className="w-48" />
              <p className="text-xs text-muted-foreground">{tr.throughHelp}</p>
            </div>
            <Button onClick={() => setConfirming(true)} disabled={!dateValid || run.isPending} data-testid="run-open">
              {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {run.isPending ? tr.running : tr.run}
            </Button>
          </div>
          {!dateValid ? (
            <p className="text-sm text-destructive" role="alert">
              {tr.invalidDate}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="run-error">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <div className="space-y-4" data-testid="run-result">
          <h2 className="text-lg font-semibold">{fill(tr.resultTitle, { date: formatDate(result.through) })}</h2>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="py-4">
                <dt className="text-xs text-muted-foreground">{tr.totalPosted}</dt>
                <dd className="text-xl font-semibold tabular-nums" data-testid="run-total">
                  {formatMoney(result.totalPosted)}
                </dd>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <dt className="text-xs text-muted-foreground">{tr.entries}</dt>
                <dd className="text-xl font-semibold tabular-nums">{newEntries}</dd>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <dt className="text-xs text-muted-foreground">{tr.fullyDepreciated}</dt>
                <dd className="text-xl font-semibold tabular-nums">{result.fullyDepreciatedAssetIds.length}</dd>
              </CardContent>
            </Card>
          </dl>

          {result.posted.length === 0 && result.skipped.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {tr.nothingPosted}
            </p>
          ) : null}

          {result.posted.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tr.postedTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tr.columns.period}</TableHead>
                        <TableHead className="text-right">{tr.columns.assets}</TableHead>
                        <TableHead className="text-right">{tr.columns.amount}</TableHead>
                        <TableHead>{tr.columns.entry}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.posted.map((period) => (
                        <TableRow key={period.journalEntryId}>
                          <TableCell className="whitespace-nowrap">{formatDate(period.periodEnd)}</TableCell>
                          <TableCell className="text-right tabular-nums">{period.assets}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(period.amount)}</TableCell>
                          <TableCell className="space-x-2">
                            <Link
                              to="/weldbooks/journal/$id"
                              params={{ id: period.journalEntryId }}
                              className="underline-offset-2 hover:underline"
                            >
                              {period.entryNumber ?? common.journalEntry}
                            </Link>
                            {period.alreadyPosted ? <Badge variant="outline">{tr.alreadyPosted}</Badge> : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {result.skipped.length > 0 ? (
            <Card className="border-amber-500/50" data-testid="run-skipped">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
                  {tr.skippedTitle}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{tr.skippedHelp}</p>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tr.columns.period}</TableHead>
                        <TableHead className="text-right">{tr.columns.assets}</TableHead>
                        <TableHead className="text-right">{tr.columns.amount}</TableHead>
                        <TableHead>{tr.columns.reason}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.skipped.map((period) => (
                        <TableRow key={period.periodEnd}>
                          <TableCell className="whitespace-nowrap">{formatDate(period.periodEnd)}</TableCell>
                          <TableCell className="text-right tabular-nums">{period.assets}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(period.amount)}</TableCell>
                          <TableCell>{period.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Button variant="outline" asChild>
            <Link to="/weldbooks/fixed-assets">{tr.viewAssets}</Link>
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={fill(tr.confirmTitle, { date: dateValid ? formatDate(through) : through })}
        description={tr.confirmBody}
        confirmLabel={tr.confirm}
        cancelLabel={common.cancel}
        onConfirm={execute}
      />
    </div>
  );
}
