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
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { ledgerCategoryAccounts } from '@/components/accounting/categorize-bank-transaction-panel';
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
  type PlanProblem,
} from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

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

/** The text a problem shows, naming the document it is about. */
function problemText(
  problem: PlanProblem,
  number: string,
  labels: Readonly<Record<PlanProblem, string>>,
): string {
  return labels[problem].replace('{number}', number);
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
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const ids = useId();
  const moneyIn = Number(lineAmount) > 0;

  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const { data: documents = [], isLoading } = useOpenDocumentsForLine(lineId, debounced);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [choice, setChoice] = useState<GapChoice>('leave');
  const [accountId, setAccountId] = useState('');
  const [problem, setProblem] = useState<{ problem: PlanProblem; id?: string } | null>(null);
  const match = useMatchBankLineToDocuments();

  const accounts = useMemo(() => ledgerCategoryAccounts(ledgerAccounts), [ledgerAccounts]);
  const paidCents = Math.abs(toCents(lineAmount));
  const numberOf = (doc: OpenDocument) => doc.number ?? tl.noNumber;

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
  const gap = Number.isFinite(plan.gapCents) ? plan.gapCents : 0;
  const lastPicked = picked.at(-1);

  const toggle = (doc: OpenDocument, on: boolean) => {
    setProblem(null);
    setPicked((current) => {
      if (!on) return current.filter((p) => p.doc.id !== doc.id);
      if (current.some((p) => p.doc.id === doc.id)) return current;
      const others = current.reduce((sum, p) => sum + (toCents(p.amount) || 0), 0);
      const amount = defaultShare(paidCents, others, toCents(doc.openAmount));
      return [...current, { doc, amount: fromCents(amount) }];
    });
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

  const problemDoc = problem?.id ? picked.find((p) => p.doc.id === problem.id)?.doc : undefined;
  const problemMessage = problem
    ? problemText(problem.problem, problemDoc ? numberOf(problemDoc) : '', tl.problems)
    : null;
  const amountText = (cents: number) => formatMoney(fromCents(Math.abs(cents)), currency);

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3 border-t pt-3">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-medium">
          {moneyIn ? tl.titleIn : tl.titleOut}
        </h3>
        <p className="text-xs text-muted-foreground">{moneyIn ? tl.hintIn : tl.hintOut}</p>
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

      {isLoading ? <InlineSpinner className="py-4" /> : null}
      {!isLoading && documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tl.noDocuments}</p>
      ) : null}
      {!isLoading && documents.length > 0 ? (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-md border" data-testid="open-documents">
          {documents.map((doc) => {
            const id = `${ids}-doc-${doc.id}`;
            const checked = picked.some((p) => p.doc.id === doc.id);
            return (
              <li key={doc.id} className="flex items-start gap-2 p-2">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={checked}
                  disabled={readOnly}
                  onCheckedChange={(value) => toggle(doc, value === true)}
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {numberOf(doc)}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">{tl.types[doc.type]}</span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">{formatMoney(doc.openAmount, doc.currency)}</span>
                  </span>
                  <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{doc.contactName}</span>
                    {doc.dueDate ? (
                      <span className="shrink-0 tabular-nums">{tl.due.replace('{date}', formatDate(doc.dueDate))}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      {picked.length > 0 ? (
        <form
          onSubmit={submit}
          noValidate
          aria-labelledby={`${ids}-title`}
          className="space-y-3 rounded-md bg-muted/40 p-3"
          data-testid="match-documents-form"
        >
          <ul className="space-y-2">
            {picked.map((p) => {
              const id = `${ids}-amount-${p.doc.id}`;
              const invalid = problem?.id === p.doc.id;
              return (
                <li key={p.doc.id} className="flex items-center justify-between gap-2">
                  <Label htmlFor={id} className="min-w-0 flex-1 truncate font-normal">
                    {tl.amountLabel.replace('{number}', numberOf(p.doc))}
                  </Label>
                  <Input
                    id={id}
                    name={`amount-${p.doc.id}`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="h-8 w-28 text-right tabular-nums"
                    value={p.amount}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? `${ids}-problem` : undefined}
                    onChange={(event) => setAmount(p.doc.id, event.target.value)}
                  />
                </li>
              );
            })}
          </ul>

          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm" role="status" aria-live="polite">
            <dt className="text-muted-foreground">{tl.transaction}</dt>
            <dd className="text-right tabular-nums">{amountText(plan.paidCents)}</dd>
            <dt className="text-muted-foreground">{tl.selected}</dt>
            <dd className="text-right tabular-nums">{amountText(plan.allocatedCents)}</dd>
            <dt className="font-medium">{tl.difference}</dt>
            <dd className="text-right font-medium tabular-nums">{amountText(gap)}</dd>
          </dl>

          {gap !== 0 ? (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">
                {(gap > 0 ? tl.gapOverLegend : tl.gapUnderLegend).replace('{amount}', amountText(gap))}
              </legend>
              <RadioGroup value={choice} onValueChange={(value) => setChoice(value as GapChoice)}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${ids}-leave`} value="leave" />
                  <Label htmlFor={`${ids}-leave`} className="font-normal">
                    {gap > 0 && lastPicked
                      ? tl.leavePartly.replace('{number}', numberOf(lastPicked.doc)).replace('{amount}', amountText(gap))
                      : tl.keepCredit.replace('{amount}', amountText(gap))}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${ids}-account`} value="account" />
                  <Label htmlFor={`${ids}-account`} className="font-normal">
                    {tl.bookToAccount.replace('{amount}', amountText(gap))}
                  </Label>
                </div>
              </RadioGroup>
              {choice === 'account' ? (
                <div className="space-y-1">
                  <Label htmlFor={`${ids}-difference-account`}>{tl.accountLabel}</Label>
                  <Select
                    value={accountId}
                    onValueChange={(value) => {
                      setProblem(null);
                      setAccountId(value);
                    }}
                  >
                    <SelectTrigger
                      id={`${ids}-difference-account`}
                      className="w-full"
                      aria-invalid={problem?.problem === 'needsAccount' || undefined}
                      aria-describedby={problem?.problem === 'needsAccount' ? `${ids}-problem` : undefined}
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

          {problemMessage || match.error ? (
            <p id={`${ids}-problem`} className="text-sm text-destructive" role="alert" data-testid="match-documents-error">
              {problemMessage ?? (match.error as Error).message}
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
