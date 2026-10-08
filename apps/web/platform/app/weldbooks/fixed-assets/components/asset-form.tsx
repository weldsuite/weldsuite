import { useMemo, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
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
import { Textarea } from '@weldsuite/ui/components/textarea';
import { MACRS_CLASSES, type BookKind } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { previewDefaultBooks, macrsClassOf, parseAmount } from '../asset-math';
import {
  booksFromPreview,
  makeAssetSchema,
  type AssetFormTexts,
  type AssetFormValues,
} from '../asset-form-model';
import { AccountSelect, DimensionSelect } from './account-select';
import { BookDefaultsPreview } from './book-defaults-preview';
import { BooksEditor } from './books-editor';
import { DeMinimisAdvice } from './de-minimis-advice';

/** Radix Select cannot hold an empty value, so "no class" travels as this. */
const NO_CLASS = '__none__';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AssetFormProps {
  mode: 'create' | 'edit';
  initial: AssetFormValues;
  /** US entity: tax books, MACRS classes, section 179, bonus and the de minimis check. */
  isUs: boolean;
  /** The asset is created from a bill line: a blank name, date or cost is taken from the line. */
  billLine?: boolean;
  /** Edit: depreciation is posted or the asset is disposed, so the financial facts and books are read-only. */
  locked?: boolean;
  submitting: boolean;
  submitError?: string | null;
  onCancel: () => void;
  submitLabel: string;
  onSubmit: (values: AssetFormValues) => void;
  /** Rendered between the asset fields and the rest (the bill line card). */
  intro?: ReactNode;
  /** Rendered after the books (the bill line's reclass option). */
  extras?: ReactNode;
}

function useValidationTexts(): AssetFormTexts {
  const { t } = useI18n();
  return t.weldbooksUs.assets.fixedAssets.form.validation;
}

function FieldError({ message }: Readonly<{ message?: string }>) {
  return message ? (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  ) : null;
}

/** The fixed asset form: create, edit and create-from-a-bill-line share it. */
export function AssetForm({
  mode,
  initial,
  isUs,
  billLine,
  locked,
  submitting,
  submitError,
  onCancel,
  submitLabel,
  onSubmit,
  intro,
  extras,
}: Readonly<AssetFormProps>) {
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const tf = fa.form;
  const common = t.weldbooksUs.assets.common;
  const { today } = useWeldbooksFormat();
  const validation = useValidationTexts();
  const schema = useMemo(() => makeAssetSchema(validation, { billLine }), [validation, billLine]);
  const form = useForm<AssetFormValues>({ resolver: zodResolver(schema), defaultValues: initial });
  const values = form.watch();
  const errors = form.formState.errors;
  const isEdit = mode === 'edit';

  const classValue = macrsClassOf(values.assetClass);
  const defaultYears = (book: BookKind): string => {
    if (book === 'book') return values.usefulLifeYears.trim() || (classValue !== null ? String(classValue) : '5');
    return classValue !== null ? String(classValue) : '';
  };

  // Cheap to compute, so it follows every keystroke instead of being memoised on a dozen fields.
  const preview = previewDefaultBooks({
    isUs,
    assetClass: values.assetClass || null,
    usefulLifeYears: parseAmount(values.usefulLifeYears),
    acquisitionDate: ISO_DATE.test(values.acquisitionDate) ? values.acquisitionDate : today(),
    placedInServiceDate: ISO_DATE.test(values.placedInServiceDate)
      ? values.placedInServiceDate
      : ISO_DATE.test(values.acquisitionDate)
        ? values.acquisitionDate
        : today(),
    businessUsePercent: parseAmount(values.businessUsePercent) ?? 100,
    listedProperty: values.listedProperty,
    section179Amount: parseAmount(values.section179Amount),
    bonusPercent: parseAmount(values.bonusPercent),
    bonusReducedElection: values.bonusReducedElection,
  });

  const setCustomize = (on: boolean) => {
    form.setValue('customizeBooks', on, { shouldDirty: true });
    form.setValue('books', on ? booksFromPreview(preview) : [], { shouldDirty: true });
  };

  const costNumber = parseAmount(values.cost);
  const financialDisabled = locked === true;
  const costPlaceholder = billLine ? tf.fromBill.costOverrideHelp : undefined;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate data-testid="asset-form">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tf.sections.asset}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="asset-name">{tf.fields.name}</Label>
            <Input id="asset-name" autoComplete="off" {...form.register('name')} />
            <FieldError message={errors.name?.message} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-number">{tf.fields.assetNumber}</Label>
            <Input id="asset-number" autoComplete="off" {...form.register('assetNumber')} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="asset-description">{tf.fields.description}</Label>
            <Textarea id="asset-description" rows={2} {...form.register('description')} />
          </div>
          {isUs ? (
            <div className="space-y-1.5">
              <Label htmlFor="asset-class">{tf.fields.assetClass}</Label>
              <Select
                value={values.assetClass === '' ? NO_CLASS : values.assetClass}
                onValueChange={(next) => form.setValue('assetClass', next === NO_CLASS ? '' : next, { shouldDirty: true })}
                disabled={isEdit}
              >
                <SelectTrigger id="asset-class">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLASS}>{tf.fields.assetClassNone}</SelectItem>
                  {MACRS_CLASSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {fa.classes[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{tf.fields.assetClassHelp}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {intro}

      <fieldset disabled={financialDisabled} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tf.sections.costAndDates}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="asset-acquired">{tf.fields.acquisitionDate}</Label>
              <Input id="asset-acquired" type="date" {...form.register('acquisitionDate')} />
              <FieldError message={errors.acquisitionDate?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-placed">{tf.fields.placedInServiceDate}</Label>
              <Input id="asset-placed" type="date" {...form.register('placedInServiceDate')} />
              <p className="text-xs text-muted-foreground">{tf.fields.placedInServiceHelp}</p>
              <FieldError message={errors.placedInServiceDate?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-cost">{tf.fields.cost}</Label>
              <Input id="asset-cost" inputMode="decimal" autoComplete="off" placeholder={costPlaceholder} {...form.register('cost')} />
              <p className="text-xs text-muted-foreground">{tf.fields.costHelp}</p>
              <FieldError message={errors.cost?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-salvage">{tf.fields.salvageValue}</Label>
              <Input id="asset-salvage" inputMode="decimal" autoComplete="off" {...form.register('salvageValue')} />
              <p className="text-xs text-muted-foreground">{tf.fields.salvageHelp}</p>
              <FieldError message={errors.salvageValue?.message} />
            </div>
            {!isEdit ? (
              <div className="space-y-1.5">
                <Label htmlFor="asset-life">{tf.fields.usefulLife}</Label>
                <Input id="asset-life" inputMode="decimal" autoComplete="off" disabled={values.customizeBooks} {...form.register('usefulLifeYears')} />
                <p className="text-xs text-muted-foreground">{tf.fields.usefulLifeHelp}</p>
                <FieldError message={errors.usefulLifeYears?.message} />
              </div>
            ) : null}
            {isUs ? (
              <div className="space-y-1.5">
                <Label htmlFor="asset-business">{tf.fields.businessUse}</Label>
                <Input id="asset-business" inputMode="decimal" autoComplete="off" placeholder="100" {...form.register('businessUsePercent')} />
                <p className="text-xs text-muted-foreground">{tf.fields.businessUseHelp}</p>
                <FieldError message={errors.businessUsePercent?.message} />
              </div>
            ) : null}
            {isUs && !isEdit ? (
              <div className="space-y-1 sm:col-span-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="asset-listed"
                    checked={values.listedProperty}
                    onCheckedChange={(checked) => form.setValue('listedProperty', checked === true, { shouldDirty: true })}
                  />
                  <Label htmlFor="asset-listed" className="font-normal">
                    {tf.fields.listedProperty}
                  </Label>
                </div>
                <p className="pl-6 text-xs text-muted-foreground">{tf.fields.listedPropertyHelp}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {isUs && !isEdit ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tf.sections.taxTreatment}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="asset-179">{tf.fields.section179}</Label>
                  <Input id="asset-179" inputMode="decimal" autoComplete="off" disabled={values.customizeBooks} {...form.register('section179Amount')} />
                  <p className="text-xs text-muted-foreground">{tf.fields.section179Help}</p>
                  <FieldError message={errors.section179Amount?.message} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="asset-bonus">{tf.fields.bonusPercent}</Label>
                  <Input id="asset-bonus" inputMode="decimal" autoComplete="off" disabled={values.customizeBooks} {...form.register('bonusPercent')} />
                  <p className="text-xs text-muted-foreground">{tf.fields.bonusHelp}</p>
                  <FieldError message={errors.bonusPercent?.message} />
                </div>
                <div className="flex items-center gap-2 sm:col-span-2">
                  <Checkbox
                    id="asset-bonus-reduced"
                    checked={values.bonusReducedElection}
                    disabled={values.customizeBooks}
                    onCheckedChange={(checked) => form.setValue('bonusReducedElection', checked === true, { shouldDirty: true })}
                  />
                  <Label htmlFor="asset-bonus-reduced" className="font-normal">
                    {tf.fields.bonusReduced}
                  </Label>
                </div>
              </div>
              {costNumber !== null && costNumber > 0 ? <DeMinimisAdvice amount={costNumber} date={values.acquisitionDate} /> : null}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tf.sections.accounts}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="asset-account">{tf.fields.assetAccount}</Label>
              <AccountSelect
                id="asset-account"
                value={values.assetAccountId}
                onChange={(next) => form.setValue('assetAccountId', next, { shouldDirty: true })}
                types={['asset']}
                unsetLabel={isEdit ? undefined : common.chartDefault}
                disabled={financialDisabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-accumulated-account">{tf.fields.accumulatedAccount}</Label>
              <AccountSelect
                id="asset-accumulated-account"
                value={values.accumulatedDepreciationAccountId}
                onChange={(next) => form.setValue('accumulatedDepreciationAccountId', next, { shouldDirty: true })}
                types={['asset']}
                unsetLabel={isEdit ? undefined : common.chartDefault}
                disabled={financialDisabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-expense-account">{tf.fields.expenseAccount}</Label>
              <AccountSelect
                id="asset-expense-account"
                value={values.depreciationExpenseAccountId}
                onChange={(next) => form.setValue('depreciationExpenseAccountId', next, { shouldDirty: true })}
                types={['expense']}
                unsetLabel={isEdit ? undefined : common.chartDefault}
                disabled={financialDisabled}
              />
            </div>
          </CardContent>
        </Card>
      </fieldset>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tf.sections.reporting}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="asset-class-dimension">{tf.fields.class}</Label>
            <DimensionSelect
              id="asset-class-dimension"
              dimension="class"
              value={values.classId}
              onChange={(next) => form.setValue('classId', next, { shouldDirty: true })}
              unsetLabel={tf.fields.noDimension}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-location">{tf.fields.location}</Label>
            <DimensionSelect
              id="asset-location"
              dimension="location"
              value={values.locationId}
              onChange={(next) => form.setValue('locationId', next, { shouldDirty: true })}
              unsetLabel={tf.fields.noDimension}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="asset-notes">{tf.fields.notes}</Label>
            <Textarea id="asset-notes" rows={3} {...form.register('notes')} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tf.sections.books}</CardTitle>
          <CardDescription>{fa.books.intro}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isEdit && !values.customizeBooks ? (
            <>
              <BookDefaultsPreview books={preview} />
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setCustomize(true)}>
                  {fa.books.customize}
                </Button>
                <p className="mt-1 text-xs text-muted-foreground">{fa.books.customizeHelp}</p>
              </div>
            </>
          ) : (
            <>
              {locked ? <p className="text-sm text-muted-foreground">{fa.books.lockedHelp}</p> : null}
              <fieldset disabled={financialDisabled}>
                <BooksEditor form={form} isUs={isUs} disabled={financialDisabled} defaultYears={defaultYears} />
              </fieldset>
              {!isEdit ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setCustomize(false)}>
                  {fa.books.customizeBack}
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {extras}

      {submitError ? (
        <p className="text-sm text-destructive" role="alert" data-testid="asset-submit-error">
          {submitError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={submitting} data-testid="asset-submit">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {submitting ? common.saving : submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {common.cancel}
        </Button>
      </div>
    </form>
  );
}
