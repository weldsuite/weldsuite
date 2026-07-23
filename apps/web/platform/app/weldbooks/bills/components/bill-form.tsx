import { useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
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
  useAccountingCustomers,
  useAccountingTaxRates,
  useAccountingAccounts,
} from '@/hooks/queries/use-accounting-queries';
import type { BillDetail } from '@/lib/api/domains/weldbooks';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

function createBillFormSchema(st: (key: string) => string) {
  const lineItemSchema = z.object({
    description: z.string().min(1, st('sweep.weldbooks.billForm.descriptionRequired')),
    quantity: z.coerce.number().min(0.01, st('sweep.weldbooks.billForm.quantityMin')),
    unitPrice: z.coerce.number().min(0, st('sweep.weldbooks.billForm.unitPriceMin')),
    unit: z.string().optional(),
    discountPercent: z.coerce.number().min(0).max(100).optional(),
    taxRateId: z.string().optional(),
    accountId: z.string().optional(),
  });

  return z.object({
    contactId: z.string().min(1, st('sweep.weldbooks.billForm.supplierRequired')),
    issueDate: z.string().min(1, st('sweep.weldbooks.billForm.issueDateRequired')),
    dueDate: z.string().min(1, st('sweep.weldbooks.billForm.dueDateRequired')),
    externalReference: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    items: z.array(lineItemSchema).min(1, st('sweep.weldbooks.billForm.atLeastOneLineItem')),
  });
}

export type BillFormValues = z.infer<ReturnType<typeof createBillFormSchema>>;

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
  onSubmit: (data: BillFormValues) => void;
  isSubmitting?: boolean;
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value);

const emptyItem = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  unit: '',
  discountPercent: 0,
  taxRateId: '',
  accountId: '',
};

export function BillForm({ mode, bill, prefill, onSubmit, isSubmitting }: BillFormProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const tb = t.accounting.billForm;
  const billFormSchema = useMemo(() => createBillFormSchema(st), [st]);
  const { data: contactsData } = useAccountingCustomers({ role: 'supplier' });
  const { data: taxRatesData } = useAccountingTaxRates();
  const { data: accountsData } = useAccountingAccounts({ type: 'expense' });

  const contacts = contactsData?.data ?? [];
  const taxRates = taxRatesData?.data ?? [];
  const accounts = accountsData?.data ?? [];

  const today = new Date().toISOString().split('T')[0];
  const defaultDue = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  const prefilledItems =
    prefill?.items && prefill.items.length > 0
      ? prefill.items.map((item) => ({
          description: item.description ?? '',
          quantity: Number(item.quantity ?? 1),
          unitPrice: Number(item.unitPrice ?? 0),
          unit: '',
          discountPercent: 0,
          taxRateId: '',
          accountId: '',
        }))
      : null;

  const form = useForm<BillFormValues>({
    resolver: zodResolver(billFormSchema),
    defaultValues: {
      contactId: bill?.contactId ?? prefill?.matchedContactId ?? '',
      issueDate:
        bill?.issueDate?.split('T')[0] ??
        (prefill?.issueDate ? prefill.issueDate.split('T')[0] : today),
      dueDate:
        bill?.dueDate?.split('T')[0] ??
        (prefill?.dueDate ? prefill.dueDate.split('T')[0] : defaultDue),
      externalReference: bill?.externalReference ?? prefill?.externalReference ?? '',
      notes: bill?.notes ?? '',
      internalNotes: bill?.internalNotes ?? '',
      items: bill?.items?.length
        ? bill.items.map((item) => ({
            description: item.description,
            quantity: Number(item.quantity ?? 1),
            unitPrice: Number(item.unitPrice ?? 0),
            unit: item.unit ?? '',
            discountPercent: Number(item.discountPercent ?? 0),
            taxRateId: item.taxRateId ?? '',
            accountId: item.accountId ?? '',
          }))
        : prefilledItems ?? [{ ...emptyItem }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  const watchedItems = form.watch('items');

  const calculateLineTotal = (item: (typeof watchedItems)[number]) => {
    const qty = item.quantity || 0;
    const price = item.unitPrice || 0;
    const discount = item.discountPercent || 0;
    const base = qty * price;
    return base - base * (discount / 100);
  };

  const calculateLineTax = (item: (typeof watchedItems)[number]) => {
    const lineTotal = calculateLineTotal(item);
    if (!item.taxRateId) return 0;
    const rate = taxRates.find((tr) => tr.id === item.taxRateId);
    if (!rate) return 0;
    return lineTotal * (Number(rate.rate) / 100);
  };

  const subtotal = watchedItems.reduce((sum, item) => sum + calculateLineTotal(item), 0);
  const taxTotal = watchedItems.reduce((sum, item) => sum + calculateLineTax(item), 0);
  const total = subtotal + taxTotal;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{tb.billDetails}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="contactId">{tb.supplier}</Label>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[250px]">{tb.description}</TableHead>
                <TableHead className="w-[80px]">{tb.qty}</TableHead>
                <TableHead className="w-[110px]">{tb.unitPrice}</TableHead>
                <TableHead className="w-[80px]">{tb.discountPercent}</TableHead>
                <TableHead className="w-[150px]">{tb.taxRate}</TableHead>
                <TableHead className="w-[150px]">{tb.account}</TableHead>
                <TableHead className="w-[110px] text-right">{tb.lineTotal}</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => {
                const lineTotal = calculateLineTotal(watchedItems[index]);
                return (
                  <TableRow key={field.id}>
                    <TableCell>
                      <Input
                        placeholder={tb.description}
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
                        {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        {...form.register(`items.${index}.discountPercent`, {
                          valueAsNumber: true,
                        })}
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={form.watch(`items.${index}.taxRateId`) || '__none__'}
                        onValueChange={(val) =>
                          form.setValue(
                            `items.${index}.taxRateId`,
                            val === '__none__' ? '' : val,
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={tb.none} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{tb.none}</SelectItem>
                          {taxRates.map((tr) => (
                            <SelectItem key={tr.id} value={tr.id}>
                              {tr.name} ({tr.rate}%)
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                        <SelectTrigger>
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
                      {formatCurrency(lineTotal)}
                    </TableCell>
                    <TableCell>
                      {fields.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(index)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <Separator className="my-4" />

          <div className="flex justify-end">
            <div className="w-64 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tb.subtotal}</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tb.tax}</span>
                <span>{formatCurrency(taxTotal)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>{tb.total}</span>
                <span>{formatCurrency(total)}</span>
              </div>
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
          {isSubmitting
            ? tb.saving
            : mode === 'add'
              ? tb.createBill
              : tb.updateBill}
        </Button>
      </div>
    </form>
  );
}
