import { Fragment, useEffect, useMemo, useRef } from 'react';
import { Controller, useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  useAccountingCustomer,
  useAccountingCustomers,
  useAccountingTaxRates,
  useAccountingAccounts,
} from '@/hooks/queries/use-accounting-queries';
import type { BillDetail } from '@/lib/api/domains/weldbooks';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { Plus, Trash2 } from 'lucide-react';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { AddressFields } from '@/components/address/address-fields';
import {
  formatPostalAddressLines,
  isPostalAddressEmpty,
  toPostalAddressFormValue,
} from '@/components/address/postal-address';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { addDaysToIsoDate, toCalendarDate } from '@/lib/weldbooks/format';
import { FORM_1099_ACCOUNT_BOXES, FORM_1099_OMIT, form1099BoxName } from '@/lib/weldbooks/form-1099';
import { NO_TAX_RATE } from '@/lib/weldbooks/document-tax';
import { WELD_TAX_CODES } from '@/lib/weldbooks/tax-codes';
import { DimensionSelects } from '@/app/weldbooks/invoices/components/dimension-selects';
import { DocumentTaxPanel } from '@/app/weldbooks/invoices/components/document-tax-panel';
import { useDocumentTaxPreview } from '@/app/weldbooks/invoices/components/use-document-tax-preview';
import { buildBillPayload, type BillPayload } from './bill-payload';

export type { BillPayload };

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

function createBillFormSchema(st: (key: string) => string) {
  const lineItemSchema = z.object({
    description: z.string().min(1, st('sweep.weldbooks.billForm.descriptionRequired')),
    quantity: z.coerce.number().min(0.01, st('sweep.weldbooks.billForm.quantityMin')),
    unitPrice: z.coerce.number().min(0, st('sweep.weldbooks.billForm.unitPriceMin')),
    unit: z.string().optional(),
    discountPercent: z.coerce.number().min(0).max(100).optional(),
    taxRateId: z.string().optional(),
    vendorTaxRate: z.string().default(''),
    accountId: z.string().optional(),
    taxCode: z.string().default(''),
    accrueUseTax: z.boolean().default(false),
    form1099Box: z.string().default(''),
    classId: z.string().default(''),
    locationId: z.string().default(''),
  });

  return z.object({
    contactId: z.string().min(1, st('sweep.weldbooks.billForm.supplierRequired')),
    issueDate: z.string().min(1, st('sweep.weldbooks.billForm.issueDateRequired')),
    dueDate: z.string().min(1, st('sweep.weldbooks.billForm.dueDateRequired')),
    externalReference: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    vendorAddress: addressSchema,
    deliveryDifferent: z.boolean().default(false),
    deliveryAddress: addressSchema,
    items: z.array(lineItemSchema).min(1, st('sweep.weldbooks.billForm.atLeastOneLineItem')),
  });
}

type BillFormValues = z.infer<ReturnType<typeof createBillFormSchema>>;

export interface BillPrefill {
  contactName?: string | null;
  externalReference?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  items?: Array<{
    description?: string;
    quantity?: string | number;
    unitPrice?: string | number;
    taxRate?: string | number | null;
    sortOrder?: number;
  }>;
  subtotal?: number | null;
  taxTotal?: number | null;
  total?: number | null;
  sourceDocumentId?: string;
  matchedContactId?: string | null;
  confidence?: { overall?: number; fields?: Record<string, number> };
}

interface BillFormProps {
  mode: 'add' | 'edit';
  bill?: BillDetail;
  prefill?: BillPrefill;
  onSubmit: (data: BillPayload) => void;
  isSubmitting?: boolean;
}

const emptyItem = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  unit: '',
  discountPercent: 0,
  taxRateId: '',
  vendorTaxRate: '',
  accountId: '',
  taxCode: '',
  accrueUseTax: false,
  form1099Box: '',
  classId: '',
  locationId: '',
};

/** Select value of the default tax code / 1099 box; never stored. */
const DEFAULT = '__default__';

export function BillForm({ mode, bill, prefill, onSubmit, isSubmitting }: Readonly<BillFormProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { formatMoney, today: localToday, entity } = useWeldbooksFormat();
  const { labels, features } = useJurisdictionLabels();
  const displayCurrency = bill?.currency;
  const tb = t.accounting.billForm;
  const td = useDocumentTexts();
  const submitLabel = mode === 'add' ? tb.createBill : tb.updateBill;
  const billFormSchema = useMemo(() => createBillFormSchema(st), [st]);
  const { data: contactsData } = useAccountingCustomers({ role: 'supplier' });
  const { data: taxRatesData } = useAccountingTaxRates();
  const { data: accountsData } = useAccountingAccounts({ type: 'expense' });

  const contacts = contactsData?.data ?? [];
  const taxRates = taxRatesData?.data ?? [];
  const accounts = accountsData?.data ?? [];

  const stored = bill as unknown as BillWithTax | undefined;
  const today = localToday();
  const defaultDue = addDaysToIsoDate(today, 30);

  const prefilledItems =
    prefill?.items && prefill.items.length > 0
      ? prefill.items.map((item) => ({
          ...emptyItem,
          description: item.description ?? '',
          quantity: Number(item.quantity ?? 1),
          unitPrice: Number(item.unitPrice ?? 0),
        }))
      : null;

  const deliveryStored = normalizeAccountingAddress(stored?.deliveryAddress);

  const form = useForm({
    resolver: zodResolver(billFormSchema),
    defaultValues: {
      contactId: bill?.contactId ?? prefill?.matchedContactId ?? '',
      issueDate: toCalendarDate(bill?.issueDate) ?? toCalendarDate(prefill?.issueDate) ?? today,
      dueDate: toCalendarDate(bill?.dueDate) ?? toCalendarDate(prefill?.dueDate) ?? defaultDue,
      externalReference: bill?.externalReference ?? prefill?.externalReference ?? '',
      notes: bill?.notes ?? '',
      internalNotes: bill?.internalNotes ?? '',
      vendorAddress: toPostalAddressFormValue(normalizeAccountingAddress(bill?.vendorAddress)),
      deliveryDifferent: Boolean(deliveryStored),
      deliveryAddress: toPostalAddressFormValue(deliveryStored),
      items: stored?.items?.length
        ? stored.items.map((item) => ({
            description: item.description,
            quantity: Number(item.quantity ?? 1),
            unitPrice: Number(item.unitPrice ?? 0),
            unit: item.unit ?? '',
            discountPercent: Number(item.discountPercent ?? 0),
            taxRateId: item.taxRateId ?? '',
            // A US bill keeps the vendor's tax as a plain rate on the line.
            vendorTaxRate: !item.taxRateId && Number(item.taxRate ?? 0) > 0 ? String(Number(item.taxRate)) : '',
            accountId: item.accountId ?? '',
            taxCode: item.taxCode ?? '',
            accrueUseTax: Boolean(item.accrueUseTax),
            form1099Box: item.form1099Box ?? '',
            classId: item.classId ?? '',
            locationId: item.locationId ?? '',
          }))
        : prefilledItems ?? [{ ...emptyItem }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  const watched = form.watch();
  const watchedItems = watched.items;

  // The server calculates the totals and each line's tax (and the use tax on the lines marked for it).
  const { salesTax, preview, totals, lineTax } = useDocumentTaxPreview({
    kind: 'bill',
    contactId: watched.contactId,
    issueDate: watched.issueDate,
    currency: displayCurrency,
    billingAddress: watched.vendorAddress,
    deliveryAddress: watched.deliveryDifferent ? watched.deliveryAddress : null,
    lines: (watchedItems ?? []).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      taxRateId: item.taxRateId,
      vendorTaxRate: item.vendorTaxRate,
      taxCode: item.taxCode,
      accrueUseTax: item.accrueUseTax,
    })),
  });
  const showLineOptions = salesTax || features.form1099;

  // Copy the supplier's billing address in when the supplier changes (not
  // when an existing bill is opened).
  const watchedContactId = watched.contactId;
  const { data: contactData } = useAccountingCustomer(watchedContactId);
  const prefilledFor = useRef<string | null>(mode === 'edit' ? (bill?.contactId ?? null) : null);
  useEffect(() => {
    const contact = contactData?.data;
    if (!watchedContactId || !contact || contact.id !== watchedContactId) return;
    if (prefilledFor.current === watchedContactId) return;
    prefilledFor.current = watchedContactId;
    form.setValue(
      'vendorAddress',
      toPostalAddressFormValue(normalizeAccountingAddress(contact.billingAddress)),
      { shouldDirty: true },
    );
  }, [watchedContactId, contactData, form]);

  const submit = (values: BillFormValues) => {
    onSubmit(buildBillPayload(values, { mode, salesTax, form1099: features.form1099 }));
  };

  const entityAddressLines = formatPostalAddressLines(normalizeAccountingAddress(entity?.address));
  const lineCostLabel = salesTax ? td.bill.lineCostWithTax : tb.lineTotal;

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{tb.billDetails}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="contactId">{labels.supplier}</Label>
            <Select
              value={form.watch('contactId')}
              onValueChange={(val) => form.setValue('contactId', val, { shouldValidate: true })}
            >
              <SelectTrigger id="contactId">
                <SelectValue placeholder={tb.selectSupplier} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.contactId && (
              <p className="text-sm text-destructive">{form.formState.errors.contactId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="externalReference">{tb.externalReference}</Label>
            <Input
              id="externalReference"
              placeholder={tb.supplierInvoiceNumber}
              {...form.register('externalReference')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="issueDate">{tb.issueDate}</Label>
            <Input id="issueDate" type="date" {...form.register('issueDate')} />
            {form.formState.errors.issueDate && (
              <p className="text-sm text-destructive">{form.formState.errors.issueDate.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="dueDate">{tb.dueDate}</Label>
            <Input id="dueDate" type="date" {...form.register('dueDate')} />
            {form.formState.errors.dueDate && (
              <p className="text-sm text-destructive">{form.formState.errors.dueDate.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{labels.supplierAddress}</CardTitle>
          <p className="text-sm text-muted-foreground">{tb.vendorAddressHelp}</p>
        </CardHeader>
        <CardContent>
          <Controller
            control={form.control}
            name="vendorAddress"
            render={({ field }) => (
              <AddressFields idPrefix="vendor" value={field.value} onChange={field.onChange} />
            )}
          />
        </CardContent>
      </Card>

      {salesTax && (
        <Card>
          <CardHeader>
            <CardTitle>{td.bill.deliveryTitle}</CardTitle>
            <p className="text-sm text-muted-foreground">{td.bill.deliveryHelp}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-center gap-2 text-sm" htmlFor="deliveryDifferent">
              <Checkbox
                id="deliveryDifferent"
                checked={watched.deliveryDifferent}
                onCheckedChange={(checked) => {
                  const next = checked === true;
                  form.setValue('deliveryDifferent', next, { shouldDirty: true });
                  if (next && isPostalAddressEmpty(form.getValues('deliveryAddress'))) {
                    form.setValue('deliveryAddress', toPostalAddressFormValue(normalizeAccountingAddress(entity?.address)));
                  }
                }}
              />
              {td.bill.deliveryDifferent}
            </label>
            {watched.deliveryDifferent ? (
              <Controller
                control={form.control}
                name="deliveryAddress"
                render={({ field }) => (
                  <AddressFields idPrefix="delivery" value={field.value} onChange={field.onChange} />
                )}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {entityAddressLines.length > 0
                  ? td.shipFrom.originDefault.replace('{address}', entityAddressLines.join(', '))
                  : td.shipFrom.originNone}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{tb.lineItems}</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ ...emptyItem })}
          >
            <Plus className="h-4 w-4 mr-1" />
            {tb.addLine}
          </Button>
        </CardHeader>
        <CardContent>
          {form.formState.errors.items?.root && (
            <p className="text-sm text-destructive mb-2">
              {form.formState.errors.items.root.message}
            </p>
          )}
          {salesTax && <p className="mb-3 text-xs text-muted-foreground">{td.bill.costNote}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[250px]">{tb.description}</TableHead>
                <TableHead className="w-[80px]">{tb.qty}</TableHead>
                <TableHead className="w-[110px]">{tb.unitPrice}</TableHead>
                <TableHead className="w-[80px]">{tb.discountPercent}</TableHead>
                <TableHead className="w-[150px]">{salesTax ? td.bill.vendorTax : labels.taxRate}</TableHead>
                <TableHead className="w-[150px]">{tb.account}</TableHead>
                <TableHead className="w-[110px] text-right">{lineCostLabel}</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => {
                const line = watchedItems?.[index];
                const calculated = lineTax(index);
                const lineTotal = salesTax ? calculated?.lineTotalWithTax : calculated?.lineTotal;
                const account = accounts.find((acc) => acc.id === line?.accountId);
                const accountBox = account?.form1099Box
                  ? account.form1099Box === FORM_1099_OMIT
                    ? td.bill.form1099Omit
                    : form1099BoxName(account.form1099Box)
                  : null;
                return (
                  <Fragment key={field.id}>
                    <TableRow>
                      <TableCell>
                        <Input
                          placeholder={tb.description}
                          aria-label={tb.description}
                          {...form.register(`items.${index}.description`)}
                        />
                        {form.formState.errors.items?.[index]?.description && (
                          <p className="text-xs text-destructive mt-1">
                            {form.formState.errors.items[index].description?.message}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          aria-label={tb.qty}
                          {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          aria-label={tb.unitPrice}
                          {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          aria-label={tb.discountPercent}
                          {...form.register(`items.${index}.discountPercent`, {
                            valueAsNumber: true,
                          })}
                        />
                      </TableCell>
                      <TableCell>
                        {salesTax ? (
                          <Input
                            type="number"
                            step="0.0001"
                            min="0"
                            inputMode="decimal"
                            aria-label={td.bill.vendorTax}
                            placeholder="0"
                            {...form.register(`items.${index}.vendorTaxRate`)}
                          />
                        ) : (
                          <Select
                            value={form.watch(`items.${index}.taxRateId`) || NO_TAX_RATE}
                            onValueChange={(val) =>
                              form.setValue(`items.${index}.taxRateId`, val === NO_TAX_RATE ? '' : val)
                            }
                          >
                            <SelectTrigger aria-label={labels.taxRate}>
                              <SelectValue placeholder={labels.noTax} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_TAX_RATE}>{labels.noTax}</SelectItem>
                              {taxRates.map((tr) => (
                                <SelectItem key={tr.id} value={tr.id}>
                                  {tr.name} ({Number(tr.rate)}%)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={form.watch(`items.${index}.accountId`) || '__none__'}
                          onValueChange={(val) =>
                            form.setValue(
                              `items.${index}.accountId`,
                              val === '__none__' ? '' : val,
                            )
                          }
                        >
                          <SelectTrigger aria-label={tb.account}>
                            <SelectValue placeholder={tb.none} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">{tb.none}</SelectItem>
                            {accounts.map((acc) => (
                              <SelectItem key={acc.id} value={acc.id}>
                                {acc.code} - {acc.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatMoney(lineTotal ?? 0, displayCurrency)}
                      </TableCell>
                      <TableCell>
                        {fields.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={td.bill.removeLine}
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>

                    {showLineOptions && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30" data-testid={`bill-line-${index}-options`}>
                        <TableCell colSpan={8}>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            {salesTax && (
                              <div className="space-y-1.5">
                                <Label htmlFor={`bill-${index}-taxCode`} className="text-xs">
                                  {td.bill.taxCode}
                                </Label>
                                <Select
                                  value={line?.taxCode || DEFAULT}
                                  onValueChange={(val) =>
                                    form.setValue(`items.${index}.taxCode`, val === DEFAULT ? '' : val, { shouldDirty: true })
                                  }
                                >
                                  <SelectTrigger id={`bill-${index}-taxCode`} className="shadow-none" aria-label={td.bill.taxCode}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={DEFAULT}>
                                      {td.line.taxCodeDefault.replace('{code}', td.taxCodes.general)}
                                    </SelectItem>
                                    {WELD_TAX_CODES.map((code) => (
                                      <SelectItem key={code} value={code}>
                                        {td.taxCodes[code]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            {salesTax && (
                              <div className="space-y-1">
                                <label
                                  className="flex items-center gap-2 text-sm lg:pt-6"
                                  htmlFor={`bill-${index}-accrueUseTax`}
                                >
                                  <Checkbox
                                    id={`bill-${index}-accrueUseTax`}
                                    checked={Boolean(line?.accrueUseTax)}
                                    onCheckedChange={(checked) =>
                                      form.setValue(`items.${index}.accrueUseTax`, checked === true, { shouldDirty: true })
                                    }
                                  />
                                  {td.bill.accrueUseTax}
                                </label>
                                <p className="text-xs text-muted-foreground">{td.bill.accrueUseTaxHelp}</p>
                              </div>
                            )}
                            {features.form1099 && (
                              <div className="space-y-1.5">
                                <Label htmlFor={`bill-${index}-1099`} className="text-xs">
                                  {td.bill.form1099Box}
                                </Label>
                                <Select
                                  value={line?.form1099Box || DEFAULT}
                                  onValueChange={(val) =>
                                    form.setValue(`items.${index}.form1099Box`, val === DEFAULT ? '' : val, { shouldDirty: true })
                                  }
                                >
                                  <SelectTrigger id={`bill-${index}-1099`} className="shadow-none" aria-label={td.bill.form1099Box}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={DEFAULT}>
                                      {accountBox
                                        ? td.bill.form1099Default.replace('{box}', accountBox)
                                        : td.bill.form1099DefaultNone}
                                    </SelectItem>
                                    <SelectItem value={FORM_1099_OMIT}>{td.bill.form1099Omit}</SelectItem>
                                    {FORM_1099_ACCOUNT_BOXES.map((box) => (
                                      <SelectItem key={box.code} value={box.code}>
                                        {form1099BoxName(box.code)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            <DimensionSelects
                              idPrefix={`bill-${index}`}
                              classId={line?.classId ?? ''}
                              locationId={line?.locationId ?? ''}
                              onClassChange={(value) => form.setValue(`items.${index}.classId`, value, { shouldDirty: true })}
                              onLocationChange={(value) =>
                                form.setValue(`items.${index}.locationId`, value, { shouldDirty: true })
                              }
                              className="contents"
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>

          <Separator className="my-4" />

          <div className="flex justify-end">
            <div className="w-full sm:w-72 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tb.subtotal}</span>
                <span>{formatMoney(totals.subtotal, displayCurrency)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{salesTax ? td.bill.vendorTaxLabel : labels.tax}</span>
                <span>{formatMoney(totals.taxTotal, displayCurrency)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>{tb.total}</span>
                <span>{formatMoney(totals.total, displayCurrency)}</span>
              </div>
              <DocumentTaxPanel
                state={preview}
                salesTax={salesTax}
                currency={displayCurrency}
                taxLabel={labels.tax}
                kind="bill"
                className="space-y-2 pt-2"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tb.notes}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="notes">{tb.notesVisibleToSupplier}</Label>
            <Textarea id="notes" rows={3} {...form.register('notes')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="internalNotes">{tb.internalNotes}</Label>
            <Textarea id="internalNotes" rows={3} {...form.register('internalNotes')} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? tb.saving : submitLabel}
        </Button>
      </div>
    </form>
  );
}
