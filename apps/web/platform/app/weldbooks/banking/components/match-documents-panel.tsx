/**
 * Matching one bank transaction to any open documents, as in Moneybird
 * (edition feature `books-bank-links`): search every open invoice (money in),
 * bill or credit note (money out), tick one or more, adjust what each takes,
 * and say what happens to a gap: the last document stays partly open or the
 * rest stays as credit, or the gap is booked to an account (bank costs, a
 * payment discount, rounding). One payment settles them all.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { toast } from 'sonner';
import { ledgerCategoryAccounts } from '@/components/accounting/categorize-bank-transaction-panel';
import { GapChoiceFieldset } from '@/components/accounting/gap-choice-fieldset';
import { useDebounce } from '@/hooks/use-debounce';
import { useMatchBankLineToDocuments, useOpenDocumentsForLine } from '@/hooks/queries/use-weldbooks-banking-queries';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { OpenDocument } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import {
  defaultShare,
  fromCents,
  planMatch,
  toCents,
  type GapChoice,
  type MatchPlan,
  type PlanProblem,
} from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type Labels = ReturnType<typeof useI18n>['t']['accounting']['bankLinks'];

interface Picked {
  doc: OpenDocument;
  /** As typed. */
  amount: string;
}

interface MatchDocumentsPanelProps {
  lineId: string;
  /** Signed: money in is positive. */
  lineAmount: string | number;
  currency: string;
  ledgerAccounts: Account[];
  readOnly: boolean;
  onMatched: () => void;
}

/** A refused submit, and the document it is about. */
interface Problem {
  problem: PlanProblem;
  id?: string;
}

function numberOf(doc: OpenDocument, tl: Labels): string {
  return doc.number ?? tl.noNumber;
}

/** The message a refused submit shows, naming the document it is about. */
function problemMessage(problem: Problem, picked: readonly Picked[], tl: Labels): string {
  const doc = problem.id ? picked.find((p) => p.doc.id === problem.id)?.doc : undefined;
  return tl.problems[problem.problem].replace('{number}', doc ? numberOf(doc, tl) : '');
}

/** The open documents found, each with a checkbox. */
function OpenDocumentList({
  idPrefix,
  documents,
  isLoading,
  pickedIds,
  readOnly,
  onToggle,
}: Readonly<{
  idPrefix: string;
  documents: OpenDocument[];
  isLoading: boolean;
  pickedIds: ReadonlySet<string>;
  readOnly: boolean;
  onToggle: (doc: OpenDocument, on: boolean) => void;
}>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  if (isLoading) return <InlineSpinner className="py-4" />;
  if (documents.length === 0) return <p className="text-sm text-muted-foreground">{tl.noDocuments}</p>;
  return (
    <ul className="max-h-64 divide-y overflow-y-auto rounded-md border" data-testid="open-documents">
      {documents.map((doc) => {
        const id = `${idPrefix}-doc-${doc.id}`;
        return (
          <li key={doc.id} className="flex items-start gap-2 p-2">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={pickedIds.has(doc.id)}
              disabled={readOnly}
              onCheckedChange={(value) => onToggle(doc, value === true)}
            />
            <label htmlFor={id} className="grid min-w-0 flex-1 cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-2">
              <span className="truncate text-sm font-medium">
                {numberOf(doc, tl)}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">{tl.types[doc.type]}</span>
              </span>
              <span className="text-right text-sm tabular-nums">{formatMoney(doc.openAmount, doc.currency)}</span>
              <span className="truncate text-xs text-muted-foreground">{doc.contactName}</span>
              <span className="text-right text-xs tabular-nums text-muted-foreground">
                {doc.dueDate ? tl.due.replace('{date}', formatDate(doc.dueDate)) : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** What each picked document takes, editable. */
function PickedAmounts({
  idPrefix,
  picked,
  invalidId,
  errorId,
  onAmount,
}: Readonly<{
  idPrefix: string;
  picked: readonly Picked[];
  /** The document a refused submit is about. */
  invalidId?: string;
  errorId: string;
  onAmount: (id: string, amount: string) => void;
}>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  return (
    <ul className="space-y-2">
      {picked.map((p) => {
        const id = `${idPrefix}-amount-${p.doc.id}`;
        const invalid = invalidId === p.doc.id;
        return (
          <li key={p.doc.id} className="flex items-center justify-between gap-2">
            <Label htmlFor={id} className="min-w-0 flex-1 truncate font-normal">
              {tl.amountLabel.replace('{number}', numberOf(p.doc, tl))}
            </Label>
            <Input
              id={id}
              name={`amount-${p.doc.id}`}
              inputMode="decimal"
              autoComplete="off"
              className="h-8 w-28 text-right tabular-nums"
              value={p.amount}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => onAmount(p.doc.id, event.target.value)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The transaction, what is picked and the difference, announced as they change. */
function MatchTotals({ plan, gapCents, money }: Readonly<{ plan: MatchPlan; gapCents: number; money: (cents: number) => string }>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm" role="status" aria-live="polite">
      <dt className="text-muted-foreground">{tl.transaction}</dt>
      <dd className="text-right tabular-nums">{money(plan.paidCents)}</dd>
      <dt className="text-muted-foreground">{tl.selected}</dt>
      <dd className="text-right tabular-nums">{money(plan.allocatedCents)}</dd>
      <dt className="font-medium">{tl.difference}</dt>
      <dd className="text-right font-medium tabular-nums">{money(gapCents)}</dd>
    </dl>
  );
}

/** The picked documents after ticking (`on`) or unticking `doc`: a new one takes what is left of the transaction. */
function togglePicked(current: Picked[], doc: OpenDocument, on: boolean, paidCents: number): Picked[] {
  if (!on) return current.filter((p) => p.doc.id !== doc.id);
  if (current.some((p) => p.doc.id === doc.id)) return current;
  const others = current.reduce((sum, p) => sum + (toCents(p.amount) || 0), 0);
  return [...current, { doc, amount: fromCents(defaultShare(paidCents, others, toCents(doc.openAmount))) }];
}

/** The wording of the gap choice: the legend and the two options. */
function gapLabels(gapCents: number, lastPicked: Picked | undefined, money: (cents: number) => string, tl: Labels) {
  const amount = money(gapCents);
  if (gapCents > 0) {
    return {
      legend: tl.gapOverLegend.replace('{amount}', amount),
      leave: lastPicked
        ? tl.leavePartly.replace('{number}', numberOf(lastPicked.doc, tl)).replace('{amount}', amount)
        : tl.keepCredit.replace('{amount}', amount),
      account: tl.bookToAccount.replace('{amount}', amount),
    };
  }
  return {
    legend: tl.gapUnderLegend.replace('{amount}', amount),
    leave: tl.keepCredit.replace('{amount}', amount),
    account: tl.bookToAccount.replace('{amount}', amount),
  };
}

export function MatchDocumentsPanel({
  lineId,
  lineAmount,
  currency,
  ledgerAccounts,
  readOnly,
  onMatched,
}: Readonly<MatchDocumentsPanelProps>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  const { formatMoney } = useWeldbooksFormat();
  const ids = useId();
  const errorId = `${ids}-problem`;
  const heading = Number(lineAmount) > 0 ? { title: tl.titleIn, hint: tl.hintIn } : { title: tl.titleOut, hint: tl.hintOut };

  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const { data: documents = [], isLoading } = useOpenDocumentsForLine(lineId, debounced);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [choice, setChoice] = useState<GapChoice>('leave');
  const [accountId, setAccountId] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const match = useMatchBankLineToDocuments();

  const accounts = useMemo(() => ledgerCategoryAccounts(ledgerAccounts), [ledgerAccounts]);
  const paidCents = Math.abs(toCents(lineAmount));
  const plan = planMatch({
    transactionAmount: lineAmount,
    shares: picked.map((p) => ({
      id: p.doc.id,
      type: p.doc.type === 'bill' ? 'bill' : 'invoice',
      amount: p.amount,
      openAmount: p.doc.openAmount,
    })),
    choice,
    accountId,
    description: tl.differenceDescription,
  });
  const gapCents = Number.isFinite(plan.gapCents) ? plan.gapCents : 0;
  const money = (cents: number) => formatMoney(fromCents(Math.abs(cents)), currency);
  const gap = gapLabels(gapCents, picked.at(-1), money, tl);

  const toggle = (doc: OpenDocument, on: boolean) => {
    setProblem(null);
    setPicked((current) => togglePicked(current, doc, on, paidCents));
  };

  const setAmount = (id: string, amount: string) => {
    setProblem(null);
    setPicked((current) => current.map((p) => (p.doc.id === id ? { ...p, amount } : p)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!plan.body || plan.problem) {
      setProblem({ problem: plan.problem ?? 'noDocuments', id: plan.problemId });
      return;
    }
    match.mutate(
      { lineId, data: plan.body },
      {
        onSuccess: () => {
          toast.success(tl.matched);
          onMatched();
        },
      },
    );
  };

  const message = problem ? problemMessage(problem, picked, tl) : (match.error as Error | null)?.message;

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3 border-t pt-3">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-medium">
          {heading.title}
        </h3>
        <p className="text-xs text-muted-foreground">{heading.hint}</p>
      </div>

      <search className="space-y-1">
        <Label htmlFor={`${ids}-search`}>{tl.searchLabel}</Label>
        <SearchInput
          id={`${ids}-search`}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tl.searchPlaceholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </search>

      <OpenDocumentList
        idPrefix={ids}
        documents={documents}
        isLoading={isLoading}
        pickedIds={new Set(picked.map((p) => p.doc.id))}
        readOnly={readOnly}
        onToggle={toggle}
      />

      {picked.length > 0 ? (
        <form
          onSubmit={submit}
          noValidate
          aria-labelledby={`${ids}-title`}
          className="space-y-3 rounded-md bg-muted/40 p-3"
          data-testid="match-documents-form"
        >
          <PickedAmounts idPrefix={ids} picked={picked} invalidId={problem?.id} errorId={errorId} onAmount={setAmount} />
          <MatchTotals plan={plan} gapCents={gapCents} money={money} />
          {gapCents === 0 ? null : (
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
                setProblem(null);
                setAccountId(value);
              }}
              labels={{ account: tl.accountLabel, accountPlaceholder: tl.accountPlaceholder }}
              accountErrorId={problem?.problem === 'needsAccount' ? errorId : undefined}
            />
          )}

          {message ? (
            <p id={errorId} className="text-sm text-destructive" role="alert" data-testid="match-documents-error">
              {message}
            </p>
          ) : null}

          <Button type="submit" size="sm" disabled={match.isPending || readOnly}>
            <Link2 className="mr-1 h-4 w-4" />
            {tl.matchButton.replace('{count}', String(picked.length))}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
