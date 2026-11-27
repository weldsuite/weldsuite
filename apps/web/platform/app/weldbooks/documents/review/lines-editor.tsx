/**
 * The lines of a document on the review screen: description, category, VAT,
 * project and a tax-inclusive amount per line, and a live check of their sum
 * against the document's own total (the lines must agree to the cent).
 */

import { useId, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ProjectSelect } from '@/components/weldflow/project-select';
import type { Account, TaxRate } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { fromCents } from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { categoryAccountsFor } from '../../banking/process/category-form';
import { newReviewLine, totalCheck, type ReviewLine } from './review-model';

const NO_TAX_RATE = '__none__';

export interface LinesEditorProps {
  lines: readonly ReviewLine[];
  onChange: (lines: ReviewLine[]) => void;
  accounts: readonly Account[];
  taxRates: readonly TaxRate[];
  /** The document's own total (VAT included), or null when the scan found none. */
  documentTotal: number | null;
  currency?: string | null;
  /** Names the lines in an error message. */
  describedBy?: string;
}

export function LinesEditor({ lines, onChange, accounts, taxRates, documentTotal, currency, describedBy }: Readonly<LinesEditorProps>) {
  const { t } = useI18n();
  const tl = t.weldbooksReceipts.review.lines;
  const { formatMoney } = useWeldbooksFormat();
  const ids = useId();

  const options = useMemo<AutocompleteOption[]>(
    () => categoryAccountsFor(accounts, 'out').map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` })),
    [accounts],
  );
  const activeTaxRates = useMemo(() => taxRates.filter((rate) => rate.isActive !== false), [taxRates]);
  const check = totalCheck(lines, documentTotal);

  const update = (key: string, patch: Partial<ReviewLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  let checkText: string;
  if (check.differenceCents === null) checkText = tl.noTotal;
  else if (check.matches) checkText = tl.matches;
  else checkText = tl.differs.replace('{amount}', formatMoney(fromCents(Math.abs(check.differenceCents)), currency));

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3" data-testid="review-lines" aria-describedby={describedBy}>
      <h3 id={`${ids}-title`} className="text-sm font-medium">
        {tl.title}
      </h3>

      {lines.map((line, index) => {
        const n = index + 1;
        const rowId = `${ids}-${line.key}`;
        return (
          <fieldset key={line.key} className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid={`review-line-${n}`}>
            <legend className={lines.length > 1 ? 'px-1 text-xs font-medium text-muted-foreground' : 'sr-only'}>
              {tl.row.replace('{n}', String(n))}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`${rowId}-description`}>{tl.description}</Label>
                <Input
                  id={`${rowId}-description`}
                  value={line.description}
                  onChange={(event) => update(line.key, { description: event.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-account`}>{tl.category}</Label>
                <Autocomplete
                  id={`${rowId}-account`}
                  options={options}
                  value={line.accountId}
                  onValueChange={(value) => update(line.key, { accountId: value })}
                  placeholder={tl.categoryPlaceholder}
                  searchPlaceholder={tl.categoryPlaceholder}
                  clearable={false}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-vat`}>{tl.vat}</Label>
                <Select
                  value={line.taxRateId || NO_TAX_RATE}
                  onValueChange={(value) => update(line.key, { taxRateId: value === NO_TAX_RATE ? '' : value })}
                >
                  <SelectTrigger id={`${rowId}-vat`}>
                    <SelectValue placeholder={tl.vatPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TAX_RATE}>{tl.vatPlaceholder}</SelectItem>
                    {activeTaxRates.map((rate) => (
                      <SelectItem key={rate.id} value={rate.id}>
                        {rate.name} ({Number(rate.rate)}%)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-project`}>{tl.project}</Label>
                <ProjectSelect id={`${rowId}-project`} value={line.projectId || null} onChange={(projectId) => update(line.key, { projectId: projectId ?? '' })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-amount`}>{tl.amount}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`${rowId}-amount`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    value={line.amount}
                    onChange={(event) => update(line.key, { amount: event.target.value })}
                  />
                  {lines.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onChange(lines.filter((candidate) => candidate.key !== line.key))}
                      aria-label={tl.remove.replace('{n}', String(n))}
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
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, newReviewLine()])}>
          <Plus className="h-4 w-4" />
          {tl.add}
        </Button>
        <div className="text-right text-sm" role="status" data-testid="lines-check">
          <p className="tabular-nums text-muted-foreground">
            {tl.sum} {formatMoney(fromCents(check.sumCents), currency)}
            {check.totalCents !== null ? (
              <>
                {' · '}
                {tl.documentTotal} {formatMoney(fromCents(check.totalCents), currency)}
              </>
            ) : null}
          </p>
          <p
            className={
              check.matches
                ? 'text-emerald-700 dark:text-emerald-400'
                : check.differenceCents === null
                  ? 'text-muted-foreground'
                  : 'text-amber-700 dark:text-amber-400'
            }
          >
            {checkText}
          </p>
        </div>
      </div>
    </section>
  );
}
