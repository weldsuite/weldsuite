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
import { ledgerCategoryAccounts } from '@/components/accounting/categorize-bank-transaction-panel';
import { GapChoiceFieldset } from '@/components/accounting/gap-choice-fieldset';
import { useDebounce } from '@/hooks/use-debounce';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useBankLinesForDocument, useMatchBankLineToDocuments } from '@/hooks/queries/use-weldbooks-banking-queries';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { CandidateBankLine, OpenDocumentType } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { fromCents, planMatch, toCents, type GapChoice, type MatchPlan } from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type Labels = ReturnType<typeof useI18n>['t']['accounting']['bankLinks'];

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

function dialogDescription(kind: OpenDocumentType, tl: Labels): string {
  if (kind === 'bill') return tl.dialogDescriptionBill;
  if (kind === 'credit_note') return tl.dialogDescriptionCreditNote;
  return tl.dialogDescriptionInvoice;
}

/**
 * The request for linking `line` to the document, and the gap (open amount
 * less the transaction, in cents). Less than open: leave the rest open (the
 * line's amount) or settle in full and book the gap. More than open: settle
 * in full; the rest stays as credit or goes to the account.
 */
function linkPlan(
  document: LinkableDocument,
  line: CandidateBankLine,
  choice: GapChoice,
  accountId: string,
  description: string,
): { plan: MatchPlan; gapCents: number } {
  const openCents = toCents(document.openAmount);
  const lineCents = Math.abs(toCents(line.amount));
  const shareCents = lineCents < openCents && choice === 'leave' ? lineCents : openCents;
  const plan = planMatch({
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
    description,
  });
  return { plan, gapCents: openCents - lineCents };
}

/** The wording of the gap choice: the legend and the two options. */
function linkGapLabels(gapCents: number, money: (cents: number) => string, tl: Labels) {
  const amount = money(gapCents);
  if (gapCents > 0) {
    return {
      legend: tl.gapOverLegend.replace('{amount}', amount),
      leave: tl.leaveOpen.replace('{amount}', amount),
      account: tl.markPaidAndBook.replace('{amount}', amount),
    };
  }
  return {
    legend: tl.gapUnderLegend.replace('{amount}', amount),
    leave: tl.keepCredit.replace('{amount}', amount),
    account: tl.bookToAccount.replace('{amount}', amount),
  };
}

/** Why a submit was refused, or why the server refused it. */
function linkProblem(
  shown: boolean,
  picked: boolean,
  needsAccount: boolean,
  error: Error | null,
  tl: Labels,
): string | null {
  if (shown && !picked) return tl.noLines;
  if (needsAccount) return tl.problems.needsAccount;
  return error?.message ?? null;
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

/** The unmatched transactions found, one to pick. */
function CandidateLineList({
  idPrefix,
  lines,
  isLoading,
  lineId,
  currency,
  onPick,
}: Readonly<{
  idPrefix: string;
  lines: CandidateBankLine[];
  isLoading: boolean;
  lineId: string;
  currency: string | null;
  onPick: (lineId: string) => void;
}>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  let body;
  if (isLoading) body = <InlineSpinner className="py-4" />;
  else if (lines.length === 0) body = <p className="text-sm text-muted-foreground">{tl.noLines}</p>;
  else
    body = (
      <RadioGroup value={lineId} onValueChange={onPick} className="gap-0">
        <ul className="max-h-72 divide-y overflow-y-auto rounded-md border" data-testid="candidate-lines">
          {lines.map((l) => (
            <LineOption
              key={l.id}
              line={l}
              id={`${idPrefix}-line-${l.id}`}
              formatted={{ amount: formatMoney(l.amount, l.currency ?? currency), date: formatDate(l.date) }}
            />
          ))}
        </ul>
      </RadioGroup>
    );
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{tl.linesLegend}</legend>
      {body}
    </fieldset>
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
  const { formatMoney } = useWeldbooksFormat();
  const ids = useId();
  const errorId = `${ids}-problem`;
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const { data, isLoading } = useBankLinesForDocument(
    document.kind === 'bill' ? { billId: document.id, search: debounced } : { invoiceId: document.id, search: debounced },
  );
  const lines = data?.lines ?? [];
  const [lineId, setLineId] = useState('');
  const [choice, setChoice] = useState<GapChoice>('leave');
  const [accountId, setAccountId] = useState('');
  const [showProblem, setShowProblem] = useState(false);
  const accounts = useDifferenceAccounts();
  const match = useMatchBankLineToDocuments();

  const line = lines.find((l) => l.id === lineId);
  const linked = line ? linkPlan(document, line, choice, accountId, tl.differenceDescription) : null;
  const gapCents = linked?.gapCents ?? 0;
  const money = (cents: number) => formatMoney(fromCents(Math.abs(cents)), document.currency);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!line || !linked?.plan.body || linked.plan.problem) {
      setShowProblem(true);
      return;
    }
    match.mutate(
      { lineId: line.id, data: linked.plan.body },
      {
        onSuccess: () => {
          toast.success(tl.linked);
          onDone();
        },
      },
    );
  };

  const needsAccount = showProblem && linked?.plan.problem === 'needsAccount';
  const problem = linkProblem(showProblem, !!line, needsAccount, match.error as Error | null, tl);
  const gap = linkGapLabels(gapCents, money, tl);

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-describedby={`${ids}-description`}>
      <DialogHeader>
        <DialogTitle>{tl.dialogTitle}</DialogTitle>
        <DialogDescription id={`${ids}-description`}>
          {dialogDescription(document.kind, tl)}{' '}
          {tl.stillOpen.replace('{amount}', formatMoney(document.openAmount, document.currency))}
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

      <CandidateLineList
        idPrefix={ids}
        lines={lines}
        isLoading={isLoading}
        lineId={lineId}
        currency={document.currency}
        onPick={(value) => {
          setShowProblem(false);
          setLineId(value);
        }}
      />

      {line && gapCents === 0 ? (
        <p className="text-sm" role="status">
          {tl.paysInFull}
        </p>
      ) : null}
      {line && gapCents !== 0 ? (
        <GapChoiceFieldset
          idPrefix={ids}
          legend={gap.legend}
          leaveLabel={gap.leave}
          accountChoiceLabel={gap.account}
          choice={choice}
          onChoiceChange={setChoice}
          accounts={accounts}
          accountId={accountId}
          onAccountChange={(value) => {
            setShowProblem(false);
            setAccountId(value);
          }}
          labels={{ account: tl.accountLabel, accountPlaceholder: tl.accountPlaceholder }}
          accountErrorId={needsAccount ? errorId : undefined}
        />
      ) : null}

      {problem ? (
        <p id={errorId} className="text-sm text-destructive" role="alert" data-testid="link-bank-line-error">
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
