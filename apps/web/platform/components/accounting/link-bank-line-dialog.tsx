/**
 * Linking a bank transaction from an invoice, credit note or bill (edition
 * feature `books-bank-links`), the other way round from the reconcile
 * screen: the unmatched transactions that could have paid the document, best
 * fit first and searchable, and what happens when the amounts differ (leave
 * the rest open or as credit, or book the gap to an account).
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ledgerCategoryAccounts } from '@/components/accounting/categorize-bank-transaction-panel';
import { useDebounce } from '@/hooks/use-debounce';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useBankLinesForDocument, useMatchBankLineToDocuments } from '@/hooks/queries/use-weldbooks-banking-queries';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { CandidateBankLine, OpenDocumentType } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { fromCents, planMatch, toCents, type GapChoice } from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export interface LinkableDocument {
  kind: OpenDocumentType;
  id: string;
  /** What the document still takes. */
  openAmount: string | number;
  currency: string | null;
}

interface LinkBankLineDialogProps {
  document: LinkableDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One unmatched transaction to pick. */
function LineOption({ line, id, formatted }: Readonly<{ line: CandidateBankLine; id: string; formatted: { amount: string; date: string } }>) {
  const title = line.counterpartyName || line.description || line.reference || '—';
  const detail = [line.counterpartyName ? line.description : null, line.bankAccountName].filter(Boolean).join(' · ');
  return (
    <li className="flex items-start gap-2 p-2">
      <RadioGroupItem id={id} value={line.id} className="mt-0.5" />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-sm tabular-nums">{formatted.amount}</span>
        </span>
        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{detail}</span>
          <span className="shrink-0 tabular-nums">{formatted.date}</span>
        </span>
      </label>
    </li>
  );
}

/** The ledger accounts a difference can go to. */
function useDifferenceAccounts(): Account[] {
  const { data } = useAccountingAccounts();
  return useMemo(() => ledgerCategoryAccounts((data?.data ?? []) as Account[]), [data]);
}

function LinkBankLineForm({ document, onDone }: Readonly<{ document: LinkableDocument; onDone: () => void }>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const ids = useId();
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const query = document.kind === 'bill' ? { billId: document.id, search: debounced } : { invoiceId: document.id, search: debounced };
  const { data, isLoading } = useBankLinesForDocument(query);
  const lines = data?.lines ?? [];
  const [lineId, setLineId] = useState('');
  const [choice, setChoice] = useState<GapChoice>('leave');
  const [accountId, setAccountId] = useState('');
  const [showProblem, setShowProblem] = useState(false);
  const accounts = useDifferenceAccounts();
  const match = useMatchBankLineToDocuments();

  const line = lines.find((l) => l.id === lineId);
  const openCents = toCents(document.openAmount);
  const lineCents = line ? Math.abs(toCents(line.amount)) : 0;
  // Less than open: leave the rest open (the line's amount) or settle in full and book the gap.
  // More than open: settle in full; the rest stays as credit or goes to the account.
  const shareCents = lineCents < openCents && choice === 'leave' ? lineCents : openCents;
  const plan = line
    ? planMatch({
        transactionAmount: line.amount,
        shares: [
          {
            id: document.id,
            type: document.kind === 'bill' ? 'bill' : 'invoice',
            amount: fromCents(shareCents),
            openAmount: document.openAmount,
          },
        ],
        choice,
        accountId,
        description: tl.differenceDescription,
      })
    : null;
  const gapCents = line ? openCents - lineCents : 0;
  const money = (cents: number) => formatMoney(fromCents(Math.abs(cents)), document.currency);

  let description = tl.dialogDescriptionInvoice;
  if (document.kind === 'bill') description = tl.dialogDescriptionBill;
  else if (document.kind === 'credit_note') description = tl.dialogDescriptionCreditNote;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!line || !plan?.body || plan.problem) {
      setShowProblem(true);
      return;
    }
    match.mutate(
      { lineId: line.id, data: plan.body },
      {
        onSuccess: () => {
          toast.success(tl.linked);
          onDone();
        },
      },
    );
  };

  let problem: string | null = null;
  if (showProblem && !line) problem = tl.noLines;
  else if (showProblem && plan?.problem === 'needsAccount') problem = tl.problems.needsAccount;
  else if (match.error) problem = (match.error as Error).message;

  let gapText: string | null = null;
  if (line && gapCents === 0) gapText = tl.paysInFull;

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-describedby={`${ids}-description`}>
      <DialogHeader>
        <DialogTitle>{tl.dialogTitle}</DialogTitle>
        <DialogDescription id={`${ids}-description`}>
          {description} {tl.stillOpen.replace('{amount}', formatMoney(document.openAmount, document.currency))}
        </DialogDescription>
      </DialogHeader>

      <search className="space-y-1">
        <Label htmlFor={`${ids}-search`}>{tl.linesSearchLabel}</Label>
        <SearchInput
          id={`${ids}-search`}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tl.linesSearchPlaceholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </search>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{tl.linesLegend}</legend>
        {isLoading ? <InlineSpinner className="py-4" /> : null}
        {!isLoading && lines.length === 0 ? <p className="text-sm text-muted-foreground">{tl.noLines}</p> : null}
        {!isLoading && lines.length > 0 ? (
          <RadioGroup
            value={lineId}
            onValueChange={(value) => {
              setShowProblem(false);
              setLineId(value);
            }}
            className="gap-0"
          >
            <ul className="max-h-72 divide-y overflow-y-auto rounded-md border" data-testid="candidate-lines">
              {lines.map((l) => (
                <LineOption
                  key={l.id}
                  line={l}
                  id={`${ids}-line-${l.id}`}
                  formatted={{ amount: formatMoney(l.amount, l.currency ?? document.currency), date: formatDate(l.date) }}
                />
              ))}
            </ul>
          </RadioGroup>
        ) : null}
      </fieldset>

      {gapText ? (
        <p className="text-sm" role="status">
          {gapText}
        </p>
      ) : null}
      {line && gapCents !== 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">
            {(gapCents > 0 ? tl.gapOverLegend : tl.gapUnderLegend).replace('{amount}', money(gapCents))}
          </legend>
          <RadioGroup value={choice} onValueChange={(value) => setChoice(value as GapChoice)}>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${ids}-leave`} value="leave" />
              <Label htmlFor={`${ids}-leave`} className="font-normal">
                {(gapCents > 0 ? tl.leaveOpen : tl.keepCredit).replace('{amount}', money(gapCents))}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${ids}-account`} value="account" />
              <Label htmlFor={`${ids}-account`} className="font-normal">
                {(gapCents > 0 ? tl.markPaidAndBook : tl.bookToAccount).replace('{amount}', money(gapCents))}
              </Label>
            </div>
          </RadioGroup>
          {choice === 'account' ? (
            <div className="space-y-1">
              <Label htmlFor={`${ids}-difference-account`}>{tl.accountLabel}</Label>
              <Select
                value={accountId}
                onValueChange={(value) => {
                  setShowProblem(false);
                  setAccountId(value);
                }}
              >
                <SelectTrigger
                  id={`${ids}-difference-account`}
                  className="w-full"
                  aria-invalid={(showProblem && plan?.problem === 'needsAccount') || undefined}
                  aria-describedby={problem ? `${ids}-problem` : undefined}
                >
                  <SelectValue placeholder={tl.accountPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {problem ? (
        <p id={`${ids}-problem`} className="text-sm text-destructive" role="alert" data-testid="link-bank-line-error">
          {problem}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t.common.actions.cancel}
        </Button>
        <Button type="submit" disabled={match.isPending}>
          <Link2 className="mr-1 h-4 w-4" />
          {tl.linkButton}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LinkBankLineDialog({ document, open, onOpenChange }: Readonly<LinkBankLineDialogProps>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so every opening starts with a fresh search and pick. */}
        {open ? <LinkBankLineForm document={document} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
