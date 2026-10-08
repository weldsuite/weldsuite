import { useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { usePostingCatchUp } from '@/hooks/queries/use-accounting-queries';
import type { PostingCatchUpResult } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

const COUNT_KEYS = ['invoices', 'bills', 'payments', 'bankTransactions', 'taxLines'] as const;

/**
 * Posts documents from before automatic posting existed. "Preview" is a dry
 * run that only counts; "Run" posts after a confirmation.
 */
export function LedgerCatchUpCard() {
  const { t } = useI18n();
  const tc = t.accounting.settings.ledgerCatchUp;
  const canRun = useCan('accounts:update');
  const catchUp = usePostingCatchUp();
  const [result, setResult] = useState<PostingCatchUpResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<'preview' | 'run' | null>(null);

  const execute = async (dryRun: boolean) => {
    setPending(dryRun ? 'preview' : 'run');
    try {
      const res = await catchUp.mutateAsync(dryRun);
      setResult(res.data);
      if (!dryRun) {
        toast.success(tc.done);
        setConfirmOpen(false);
      }
    } catch (err) {
      toast.error(tc.failed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setPending(null);
    }
  };

  const total = result ? COUNT_KEYS.reduce((sum, key) => sum + (Number(result[key]) || 0), 0) : 0;
  const typeLabel = (type: string) => (tc.types as Record<string, string>)[type] ?? type;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.title}</CardTitle>
        <CardDescription>{tc.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canRun ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void execute(true)} disabled={pending !== null}>
              {pending === 'preview' ? tc.previewing : tc.preview}
            </Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={pending !== null}>
              {pending === 'run' ? tc.running : tc.run}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{tc.noPermission}</p>
        )}

        {result && (
          <div className="space-y-4" aria-live="polite">
            {total === 0 && result.skipped.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tc.nothingToPost}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">{result.dryRun ? tc.previewResult : tc.runResult}</p>
                <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {COUNT_KEYS.map((key) => (
                    <div key={key} className="rounded-md border p-3">
                      <dt className="text-xs text-muted-foreground">{tc.counts[key]}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{Number(result[key]) || 0}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {result.skipped.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">{tc.skipped.replace('{count}', String(result.skipped.length))}</p>
                <div className="max-h-72 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tc.skippedColType}</TableHead>
                        <TableHead>{tc.skippedColNumber}</TableHead>
                        <TableHead>{tc.skippedColReason}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.skipped.map((row) => (
                        <TableRow key={`${row.type}-${row.id}`}>
                          <TableCell className="whitespace-nowrap">{typeLabel(row.type)}</TableCell>
                          <TableCell className="whitespace-nowrap">{row.number ?? row.id}</TableCell>
                          <TableCell className="text-muted-foreground">{row.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tc.confirmTitle}
        description={tc.confirmDescription}
        confirmLabel={tc.confirm}
        cancelLabel={t.accounting.lockDates.cancel}
        loading={pending === 'run'}
        onConfirm={() => execute(false)}
      />
    </Card>
  );
}
