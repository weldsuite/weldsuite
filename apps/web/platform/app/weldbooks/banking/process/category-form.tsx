/**
 * "Book to a category": rows of category, VAT rate, contact, optional project
 * and amount. "Split" adds a row; the remainder shows what is left, and Book
 * stays disabled until the rows add up to the bank line.
 */

import { useId, useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ContactPicker } from '@/components/accounting/contact-picker';
import { ProjectSelect } from '@/components/weldflow/project-select';
import type { Account, TaxRate } from '@/lib/api/domains/weldbooks';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import type { CategorizeInput } from '@/lib/api/domains/weldbooks-processing';
import { useI18n } from '@/lib/i18n/provider';
import { fromCents } from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { directionOf, type LineDirection } from './process-model';
import {
  buildCategorizeInput,
  lineCents,
  MAX_SPLIT_ROWS,
  newSplitRow,
  nextRowAmount,
  remainderCents,
  splitProblem,
  type SplitRow,
} from './split-model';

const NO_TAX_RATE = '__none__';

/** The accounts a line can be booked to: revenue for money in, expense for money out, equity and (out) liabilities for both. */
export function categoryAccountsFor(accounts: readonly Account[], direction: LineDirection): Account[] {
  const types = direction === 'in' ? new Set(['revenue', 'equity']) : new Set(['expense', 'equity', 'liability']);
  return accounts
    .filter((account) => account.isActive !== false && types.has(account.type))
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

export interface CategoryFormProps {
  line: BankLine;
  currency: string;
  accounts: readonly Account[];
  taxRates: readonly TaxRate[];
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (input: CategorizeInput) => void;
  onCancel: () => void;
}

export function CategoryForm({
  line,
  currency,
  accounts,
  taxRates,
  pending,
  errorMessage,
  onSubmit,
  onCancel,
}: Readonly<CategoryFormProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksConnected.processing.category;
  const { formatMoney } = useWeldbooksFormat();
  const ids = useId();
  const direction = directionOf(line);
  const [rows, setRows] = useState<SplitRow[]>(() => [newSplitRow(fromCents(lineCents(line.amount)))]);

  const options = useMemo<AutocompleteOption[]>(
    () =>
      categoryAccountsFor(accounts, direction).map((account) => ({
        value: account.id,
        label: `${account.code} — ${account.name}`,
      })),
    [accounts, direction],
  );
  const contactRole = direction === 'in' ? 'customer' : 'supplier';
  const activeTaxRates = useMemo(() => taxRates.filter((rate) => rate.isActive !== false), [taxRates]);

  const left = remainderCents(line.amount, rows);
  const problem = splitProblem(line.amount, rows);
  const money = (cents: number) => formatMoney(fromCents(Math.abs(cents)), currency);

  const update = (key: string, patch: Partial<SplitRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem || pending) return;
    onSubmit(buildCategorizeInput(rows));
  };

  let remainderText: string;
  if (left > 0) remainderText = tc.remainder.replace('{amount}', money(left));
  else if (left < 0) remainderText = tc.over.replace('{amount}', money(left));
  else remainderText = tc.balanced.replace('{amount}', money(lineCents(line.amount)));

  return (
    <form
      onSubmit={submit}
      aria-labelledby={`${ids}-title`}
      className="space-y-4 rounded-xl border p-5"
      data-testid="category-form"
    >
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-semibold">
          {tc.title}
        </h3>
        <p className="text-xs text-muted-foreground">{direction === 'in' ? tc.hintIn : tc.hintOut}</p>
      </div>

      {rows.map((row, index) => {
        const n = index + 1;
        const rowId = `${ids}-${row.key}`;
        return (
          <fieldset key={row.key} className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid={`category-row-${n}`}>
            <legend className={rows.length > 1 ? 'px-1 text-xs font-medium text-muted-foreground' : 'sr-only'}>
              {tc.row.replace('{n}', String(n))}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-account`}>{tc.category}</Label>
                <Autocomplete
                  id={`${rowId}-account`}
                  options={options}
                  value={row.accountId}
                  onValueChange={(value) => update(row.key, { accountId: value })}
                  placeholder={tc.categoryPlaceholder}
                  searchPlaceholder={tc.categoryPlaceholder}
                  clearable={false}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-vat`}>{tc.vatRate}</Label>
                <Select
                  value={row.taxRateId || NO_TAX_RATE}
                  onValueChange={(value) => update(row.key, { taxRateId: value === NO_TAX_RATE ? '' : value })}
                >
                  <SelectTrigger id={`${rowId}-vat`}>
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
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-contact`}>{tc.contact}</Label>
                <ContactPicker
                  id={`${rowId}-contact`}
                  role={contactRole}
                  value={row.contactId}
                  onChange={(contactId) => update(row.key, { contactId })}
                  placeholder={tc.contactPlaceholder}
                  searchPlaceholder={tc.contactSearch}
                  optional
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-project`}>{tc.project}</Label>
                <ProjectSelect
                  id={`${rowId}-project`}
                  value={row.projectId || null}
                  onChange={(projectId) => update(row.key, { projectId: projectId ?? '' })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-amount`}>{tc.amount}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`${rowId}-amount`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    value={row.amount}
                    onChange={(event) => update(row.key, { amount: event.target.value })}
                  />
                  {rows.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                      aria-label={tc.removeRow.replace('{n}', String(n))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= MAX_SPLIT_ROWS}
          onClick={() => setRows((current) => [...current, newSplitRow(nextRowAmount(line.amount, current))])}
        >
          <Plus className="h-4 w-4" />
          {tc.split}
        </Button>
        <p
          className={left === 0 ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-sm text-muted-foreground'}
          role="status"
          data-testid="split-remainder"
        >
          {remainderText}
        </p>
      </div>

      {errorMessage ? (
        <p className="text-sm text-destructive" role="alert" data-testid="category-error">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={problem !== null || pending} data-testid="category-submit">
          {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
          {pending ? tc.booking : tc.book}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tc.cancel}
        </Button>
      </div>
    </form>
  );
}
