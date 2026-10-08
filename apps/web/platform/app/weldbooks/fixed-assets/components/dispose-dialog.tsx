import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
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
import { useDisposeFixedAsset } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { DisposeResult, FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { parseAmount, previewDisposal } from '../asset-math';
import { errorMessage, fill } from '../text';
import { AccountSelect } from './account-select';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface DisposeDialogProps {
  asset: FixedAssetDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Gain or loss of a disposal as a labelled line, coloured by the verdict. */
function VerdictLine({ result, amount, label }: Readonly<{ result: 'gain' | 'loss' | 'none'; amount: string; label: string }>) {
  return (
    <div className="flex items-center justify-between gap-3" data-testid="dispose-verdict" data-result={result}>
      <span className="text-sm font-medium">{label}</span>
      {result === 'none' ? null : (
        <Badge variant={result === 'gain' ? 'success' : 'warning'} className="tabular-nums">
          {amount}
        </Badge>
      )}
    </div>
  );
}

/**
 * Dispose of an asset: sale, scrapping or trade-in. While the form is filled in
 * it previews the gain or loss from the stored schedule; the server computes
 * the exact figures, and its answer (with the tax books' recapture) replaces
 * the form.
 */
export function DisposeDialog({ asset, open, onOpenChange }: Readonly<DisposeDialogProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.assets.fixedAssets.dispose;
  const fa = t.weldbooksUs.assets.fixedAssets;
  const common = t.weldbooksUs.assets.common;
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const dispose = useDisposeFixedAsset();

  const [date, setDate] = useState(() => {
    const now = today();
    return now < asset.placedInServiceDate ? asset.placedInServiceDate : now;
  });
  const [proceeds, setProceeds] = useState('0');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [gainLossAccountId, setGainLossAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DisposeResult | null>(null);

  const ledgerBook = asset.books.find((book) => book.postsToLedger);
  const rows = useMemo(
    () => (ledgerBook ? asset.ledgerRows.filter((row) => row.bookId === ledgerBook.id) : []),
    [asset.ledgerRows, ledgerBook],
  );
  const proceedsNumber = parseAmount(proceeds);
  const dateValid = ISO_DATE.test(date);
  const beforeService = dateValid && date < asset.placedInServiceDate;
  const proceedsValid = proceedsNumber !== null && proceedsNumber >= 0;

  const preview = useMemo(
    () => (dateValid && proceedsValid ? previewDisposal({ cost: asset.cost, rows, date, proceeds: proceedsNumber }) : null),
    [asset.cost, rows, date, dateValid, proceedsValid, proceedsNumber],
  );

  let problem: string | null = null;
  if (!dateValid) problem = td.invalidDate;
  else if (beforeService) problem = fill(td.beforeService, { date: formatDate(asset.placedInServiceDate) });
  else if (!proceedsValid) problem = td.invalidProceeds;

  const submit = async () => {
    if (problem || proceedsNumber === null) return;
    setError(null);
    try {
      const outcome = await dispose.mutateAsync({
        id: asset.id,
        input: {
          date,
          proceeds: proceedsNumber,
          ...(proceedsNumber > 0 && depositAccountId ? { depositAccountId } : {}),
          ...(gainLossAccountId ? { gainLossAccountId } : {}),
        },
      });
      setResult(outcome);
      toast.success(td.result.title);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (dispose.isPending) return;
    onOpenChange(next);
  };

  if (result) {
    const amount = formatMoney(Math.abs(result.gainOrLoss));
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="dispose-result">
          <DialogHeader>
            <DialogTitle>{td.result.title}</DialogTitle>
            <DialogDescription>{asset.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <VerdictLine
              result={result.result}
              amount={amount}
              label={result.result === 'gain' ? fill(td.result.gain, { amount }) : result.result === 'loss' ? fill(td.result.loss, { amount }) : td.result.none}
            />
            <p className="text-muted-foreground">{fill(td.result.netBookValue, { amount: formatMoney(result.netBookValue) })}</p>
            {result.catchUp.length > 0 ? (
              <p className="text-muted-foreground">{fill(td.result.catchUp, { count: result.catchUp.length })}</p>
            ) : null}
            <Link to="/weldbooks/journal/$id" params={{ id: result.journalEntryId }} className="inline-block underline-offset-2 hover:underline">
              {td.result.viewEntry}
            </Link>

            {result.taxBooks.length > 0 ? (
              <div className="space-y-2">
                <div>
                  <p className="font-medium">{td.result.taxTitle}</p>
                  <p className="text-xs text-muted-foreground">{td.result.taxHelp}</p>
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{td.result.columns.book}</TableHead>
                        <TableHead className="text-right">{td.result.columns.depreciation}</TableHead>
                        <TableHead className="text-right">{td.result.columns.proceeds}</TableHead>
                        <TableHead className="text-right">{td.result.columns.adjustedBasis}</TableHead>
                        <TableHead className="text-right">{td.result.columns.gainOrLoss}</TableHead>
                        <TableHead className="text-right">{td.result.columns.ordinary}</TableHead>
                        <TableHead className="text-right">{td.result.columns.unrecaptured}</TableHead>
                        <TableHead className="text-right">{td.result.columns.remaining}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.taxBooks.map((book) => (
                        <TableRow key={`${book.book}-${book.stateCode ?? ''}`}>
                          <TableCell className="whitespace-nowrap">
                            {book.book === 'state' && book.stateCode
                              ? `${fa.bookKinds.state} ${book.stateCode}`
                              : (fa.bookKinds[book.book as 'book' | 'federal' | 'state'] ?? book.book)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.accumulated)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.proceeds)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.adjustedBasis)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.gainOrLoss)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.ordinaryRecapture)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.unrecapturedSection1250)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(book.remainingGain)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{common.close}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const previewAmount = preview ? formatMoney(Math.abs(preview.gainOrLoss)) : '';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{fill(td.title, { name: asset.name })}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dispose-date">{td.date}</Label>
              <Input id="dispose-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dispose-proceeds">{td.proceeds}</Label>
              <Input
                id="dispose-proceeds"
                inputMode="decimal"
                autoComplete="off"
                value={proceeds}
                onChange={(event) => setProceeds(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{td.proceedsHelp}</p>
            </div>
            {proceedsNumber !== null && proceedsNumber > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="dispose-deposit">{td.depositAccount}</Label>
                <AccountSelect
                  id="dispose-deposit"
                  value={depositAccountId}
                  onChange={setDepositAccountId}
                  types={['asset']}
                  unsetLabel={common.chartDefault}
                />
                <p className="text-xs text-muted-foreground">{td.depositAccountHelp}</p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="dispose-gain-loss">{td.gainLossAccount}</Label>
              <AccountSelect
                id="dispose-gain-loss"
                value={gainLossAccountId}
                onChange={setGainLossAccountId}
                types={['revenue', 'expense']}
                unsetLabel={common.chartDefault}
              />
            </div>
          </div>

          {preview ? (
            <div className="space-y-2 rounded-md border bg-muted/30 p-4" data-testid="dispose-preview">
              <p className="text-sm font-medium">{td.preview.title}</p>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{td.preview.cost}</dt>
                  <dd className="tabular-nums" data-testid="preview-cost">{formatMoney(asset.cost)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{td.preview.accumulated}</dt>
                  <dd className="tabular-nums" data-testid="preview-accumulated">{formatMoney(preview.accumulatedDepreciation)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{td.preview.netBookValue}</dt>
                  <dd className="tabular-nums" data-testid="preview-nbv">{formatMoney(preview.netBookValue)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{td.preview.proceeds}</dt>
                  <dd className="tabular-nums" data-testid="preview-proceeds">{formatMoney(proceedsNumber)}</dd>
                </div>
              </dl>
              <VerdictLine
                result={preview.result}
                amount={previewAmount}
                label={preview.result === 'gain' ? td.preview.gain : preview.result === 'loss' ? td.preview.loss : td.preview.none}
              />
              <p className="text-xs text-muted-foreground">{td.preview.note}</p>
            </div>
          ) : null}

          {problem ? (
            <p className="text-sm text-destructive" role="alert" data-testid="dispose-problem">
              {problem}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="dispose-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={dispose.isPending}>
            {common.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={dispose.isPending || problem !== null} data-testid="dispose-submit">
            {dispose.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {dispose.isPending ? td.submitting : td.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
