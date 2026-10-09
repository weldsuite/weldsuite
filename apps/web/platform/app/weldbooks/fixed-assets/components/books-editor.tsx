import { Controller, useFieldArray, type UseFormReturn } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { US_STATES } from '@/components/address/us-states';
import { CONVENTIONS, type BookKind } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { isMacrsMethod, methodsFor } from '../asset-math';
import { emptyBook, type AssetFormValues } from '../asset-form-model';

/** Radix Select cannot hold an empty value, so "automatic" travels as this. */
const AUTO = '__auto__';

interface BooksEditorProps {
  form: UseFormReturn<AssetFormValues>;
  isUs: boolean;
  disabled?: boolean;
  /** The recovery period a new row starts with, by book. */
  defaultYears: (book: BookKind) => string;
}

/** The depreciation books of an asset as editable rows. Only the book (GAAP) can post to the ledger. */
export function BooksEditor({ form, isUs, disabled, defaultYears }: Readonly<BooksEditorProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksUs.assets.fixedAssets.books;
  const fa = t.weldbooksUs.assets.fixedAssets;
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'books' });
  const rows = form.watch('books');
  const errors = form.formState.errors.books;
  const hasLedgerBook = rows.some((row) => row.book === 'book');

  const add = (kind: BookKind) => append({ ...emptyBook(kind), recoveryYears: defaultYears(kind) });

  return (
    <div className="space-y-4" data-testid="books-editor">
      {fields.length === 0 ? <p className="text-sm text-muted-foreground">{tb.noBooks}</p> : null}

      {fields.map((field, index) => {
        const row = rows[index];
        if (!row) return null;
        const rowErrors = Array.isArray(errors) ? errors[index] : undefined;
        const macrs = isMacrsMethod(row.method);
        const needsYears = row.method !== 'expensed' && row.method !== 'none';
        const title =
          row.book === 'state' && row.stateCode ? `${fa.bookKinds.state} ${row.stateCode.toUpperCase()}` : fa.bookKinds[row.book];
        return (
          <fieldset key={field.id} className="space-y-3 rounded-md border p-4" disabled={disabled}>
            <legend className="sr-only">{tb.rowTitle.replace('{number}', String(index + 1))}</legend>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{title}</span>
                <Badge variant={row.book === 'book' ? 'secondary' : 'outline'}>
                  {row.book === 'book' ? tb.postsToLedger : tb.taxOnly}
                </Badge>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(index)}
                aria-label={`${tb.remove}: ${title}`}
                disabled={disabled}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {isUs ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`book-kind-${index}`}>{tb.book}</Label>
                  <Controller
                    control={form.control}
                    name={`books.${index}.book`}
                    render={({ field: kind }) => (
                      <Select
                        value={kind.value}
                        onValueChange={(next) => {
                          const nextKind = next as BookKind;
                          kind.onChange(nextKind);
                          // A tax book starts on MACRS, the ledger book on a book method; the ledger flag follows the kind.
                          const methods = methodsFor(nextKind);
                          if (!methods.includes(row.method)) {
                            form.setValue(`books.${index}.method`, nextKind === 'book' ? 'straight_line' : 'macrs_gds', { shouldDirty: true });
                          }
                          form.setValue(`books.${index}.postsToLedger`, nextKind === 'book' ? row.postsToLedger : false, { shouldDirty: true });
                        }}
                      >
                        <SelectTrigger id={`book-kind-${index}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="book">{fa.bookKinds.book}</SelectItem>
                          <SelectItem value="federal">{fa.bookKinds.federal}</SelectItem>
                          <SelectItem value="state">{fa.bookKinds.state}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {rowErrors?.book ? <p className="text-sm text-destructive">{rowErrors.book.message}</p> : null}
                </div>
              ) : null}

              {row.book === 'state' ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`book-state-${index}`}>{tb.state}</Label>
                  <Controller
                    control={form.control}
                    name={`books.${index}.stateCode`}
                    render={({ field: state }) => (
                      <Select value={state.value || ''} onValueChange={state.onChange}>
                        <SelectTrigger id={`book-state-${index}`}>
                          <SelectValue placeholder={tb.chooseState} />
                        </SelectTrigger>
                        <SelectContent>
                          {US_STATES.map((item) => (
                            <SelectItem key={item.code} value={item.code}>
                              {item.code} — {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {rowErrors?.stateCode ? <p className="text-sm text-destructive">{rowErrors.stateCode.message}</p> : null}
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor={`book-method-${index}`}>{tb.method}</Label>
                <Controller
                  control={form.control}
                  name={`books.${index}.method`}
                  render={({ field: method }) => (
                    <Select value={method.value} onValueChange={method.onChange}>
                      <SelectTrigger id={`book-method-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {methodsFor(row.book).map((value) => (
                          <SelectItem key={value} value={value}>
                            {fa.methods[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              {!macrs ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`book-convention-${index}`}>{tb.convention}</Label>
                  <Controller
                    control={form.control}
                    name={`books.${index}.convention`}
                    render={({ field: convention }) => (
                      <Select
                        value={convention.value === '' ? AUTO : convention.value}
                        onValueChange={(next) => convention.onChange(next === AUTO ? '' : next)}
                      >
                        <SelectTrigger id={`book-convention-${index}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={AUTO}>{tb.conventionAuto}</SelectItem>
                          {CONVENTIONS.map((value) => (
                            <SelectItem key={value} value={value}>
                              {fa.conventions[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium leading-none">{tb.convention}</p>
                  <p className="text-sm">{tb.conventionAuto}</p>
                  <p className="text-xs text-muted-foreground">{tb.conventionAutoHelp}</p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor={`book-years-${index}`}>{tb.recoveryYears}</Label>
                <Input
                  id={`book-years-${index}`}
                  inputMode="decimal"
                  disabled={!needsYears}
                  {...form.register(`books.${index}.recoveryYears`)}
                />
                {rowErrors?.recoveryYears ? <p className="text-sm text-destructive">{rowErrors.recoveryYears.message}</p> : null}
              </div>

              {macrs ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor={`book-179-${index}`}>{tb.section179}</Label>
                    <Input id={`book-179-${index}`} inputMode="decimal" {...form.register(`books.${index}.section179Amount`)} />
                    {rowErrors?.section179Amount ? <p className="text-sm text-destructive">{rowErrors.section179Amount.message}</p> : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`book-bonus-${index}`}>{tb.bonusPercent}</Label>
                    <Input id={`book-bonus-${index}`} inputMode="decimal" {...form.register(`books.${index}.bonusPercent`)} />
                    {rowErrors?.bonusPercent ? <p className="text-sm text-destructive">{rowErrors.bonusPercent.message}</p> : null}
                  </div>
                </>
              ) : null}
            </div>

            {row.book === 'book' ? (
              <div className="flex items-center gap-2">
                <Controller
                  control={form.control}
                  name={`books.${index}.postsToLedger`}
                  render={({ field: posts }) => (
                    <Checkbox
                      id={`book-posts-${index}`}
                      checked={posts.value}
                      onCheckedChange={(checked) => posts.onChange(checked === true)}
                    />
                  )}
                />
                <Label htmlFor={`book-posts-${index}`} className="font-normal">
                  {tb.postsToLedgerField}
                </Label>
              </div>
            ) : null}
            {rowErrors?.postsToLedger ? <p className="text-sm text-destructive">{rowErrors.postsToLedger.message}</p> : null}
          </fieldset>
        );
      })}

      {!Array.isArray(errors) && errors?.message ? <p className="text-sm text-destructive">{errors.message}</p> : null}
      {!Array.isArray(errors) && errors?.root?.message ? <p className="text-sm text-destructive">{errors.root.message}</p> : null}

      {!disabled ? (
        <div className="flex flex-wrap gap-2">
          {!hasLedgerBook ? (
            <Button type="button" variant="outline" size="sm" onClick={() => add('book')}>
              <Plus className="h-4 w-4" />
              {tb.addBook}
            </Button>
          ) : null}
          {isUs ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => add('federal')}>
                <Plus className="h-4 w-4" />
                {tb.addFederal}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => add('state')}>
                <Plus className="h-4 w-4" />
                {tb.addState}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
