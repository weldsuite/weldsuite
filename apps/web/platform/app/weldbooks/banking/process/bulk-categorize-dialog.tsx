/**
 * Bulk booking: several lines with the same direction are booked in full to
 * one category and VAT rate. One categorize call per line, with progress and a
 * result summary that names every line that failed and why.
 */

import { Loader2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { invalidateAfterProcessing } from '@/hooks/queries/use-weldbooks-processing-queries';
import type { Account, TaxRate } from '@/lib/api/domains/weldbooks';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { processingApi, type CategorizeInput } from '@/lib/api/domains/weldbooks-processing';
import { useI18n } from '@/lib/i18n/provider';
import { fromCents } from '@/lib/weldbooks/bank-link-math';
import { categoryAccountsFor } from './category-form';
import { directionOf } from './process-model';
import { lineCents } from './split-model';

const NO_TAX_RATE = '__none__';

interface Failure {
  id: string;
  name: string;
  message: string;
}

export interface BulkCategorizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: readonly BankLine[];
  accounts: readonly Account[];
  taxRates: readonly TaxRate[];
  /** Called with the ids that were booked and the category they went to, once the dialog is closed after a run. */
  onBooked: (ids: string[], accountId: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
}

export function BulkCategorizeDialog({ open, onOpenChange, lines, accounts, taxRates, onBooked }: Readonly<BulkCategorizeDialogProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksConnected.processing.bulk;
  const tc = t.weldbooksConnected.processing.category;
  const unknown = t.accounting.statusLabels.counterpartyUnknown;
  const qc = useQueryClient();
  const ids = useId();
  const [accountId, setAccountId] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [booked, setBooked] = useState<string[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (open) {
      setAccountId('');
      setTaxRateId('');
      setRunning(false);
      setDone(0);
      setBooked([]);
      setFailures([]);
      setFinished(false);
    }
  }, [open]);

  const direction = lines[0] ? directionOf(lines[0]) : 'out';
  const options = useMemo<AutocompleteOption[]>(
    () =>
      categoryAccountsFor(accounts, direction).map((account) => ({
        value: account.id,
        label: `${account.code} — ${account.name}`,
      })),
    [accounts, direction],
  );
  const activeTaxRates = useMemo(() => taxRates.filter((rate) => rate.isActive !== false), [taxRates]);

  const run = async () => {
    setRunning(true);
    setDone(0);
    const okIds: string[] = [];
    const failed: Failure[] = [];
    for (const line of lines) {
      const data: CategorizeInput = {
        lines: [
          {
            accountId,
            amount: fromCents(lineCents(line.amount)),
            ...(taxRateId ? { taxRateId } : {}),
          },
        ],
      };
      try {
        await processingApi.categorize(line.id, data);
        okIds.push(line.id);
      } catch (error) {
        failed.push({ id: line.id, name: line.counterpartyName || line.description || unknown, message: messageOf(error) });
      }
      setDone((count) => count + 1);
    }
    invalidateAfterProcessing(qc);
    setBooked(okIds);
    setFailures(failed);
    setRunning(false);
    setFinished(true);
  };

  const close = () => {
    if (running) return;
    onOpenChange(false);
    if (finished && booked.length > 0) onBooked(booked, accountId);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg" data-testid="bulk-dialog">
        <DialogHeader>
          <DialogTitle>{tb.title.replace('{count}', String(lines.length))}</DialogTitle>
          <DialogDescription>{tb.description}</DialogDescription>
        </DialogHeader>

        {finished ? (
          <div className="space-y-3" role="status" data-testid="bulk-summary">
            <p className="text-sm font-medium">
              {failures.length === 0
                ? tb.allBooked.replace('{count}', String(booked.length))
                : tb.summary.replace('{ok}', String(booked.length)).replace('{failed}', String(failures.length))}
            </p>
            {failures.length > 0 ? (
              <ul className="space-y-1 text-sm text-destructive">
                {failures.map((failure) => (
                  <li key={failure.id}>{tb.failedLine.replace('{name}', failure.name).replace('{message}', failure.message)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-account`}>{tc.category}</Label>
              <Autocomplete
                id={`${ids}-account`}
                options={options}
                value={accountId}
                onValueChange={setAccountId}
                placeholder={tc.categoryPlaceholder}
                searchPlaceholder={tc.categoryPlaceholder}
                clearable={false}
                disabled={running}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-vat`}>{tc.vatRate}</Label>
              <Select
                value={taxRateId || NO_TAX_RATE}
                onValueChange={(value) => setTaxRateId(value === NO_TAX_RATE ? '' : value)}
                disabled={running}
              >
                <SelectTrigger id={`${ids}-vat`}>
                  <SelectValue placeholder={tc.vatPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TAX_RATE}>{tc.vatPlaceholder}</SelectItem>
                  {activeTaxRates.map((rate) => (
                    <SelectItem key={rate.id} value={rate.id}>
                      {rate.name} ({Number(rate.rate)}%)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {running ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="bulk-progress">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {tb.progress.replace('{done}', String(done)).replace('{total}', String(lines.length))}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {finished ? (
            <Button type="button" onClick={close}>
              {tb.close}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={close} disabled={running}>
                {tc.cancel}
              </Button>
              <Button type="button" onClick={() => void run()} disabled={!accountId || running || lines.length === 0} data-testid="bulk-run">
                {tb.run.replace('{count}', String(lines.length))}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
