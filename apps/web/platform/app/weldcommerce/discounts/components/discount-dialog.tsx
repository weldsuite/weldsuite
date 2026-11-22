/**
 * Create and edit form for a discount code: name, code, what it takes off
 * (a percentage, a fixed amount, free shipping), what it applies to, its
 * minimums, limits and dates, and its status. A code another discount already
 * uses is refused by the API (409 `CODE_TAKEN`) and shown on the code field.
 */

import { useMemo } from 'react';
import { useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCommerceSettings,
  useCreateCommerceDiscount,
  useUpdateCommerceDiscount,
  type CommerceDiscount,
} from '@/hooks/queries/use-commerce-orders-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import {
  DISCOUNT_STATUSES,
  DISCOUNT_TYPES,
  buildDiscountFormSchema,
  emptyDiscountValues,
  toDiscountInput,
  valuesFromDiscount,
  type DiscountFormValues,
} from '../../lib/discounts';
import { apiErrorInfo, hasErrorCode } from '../../lib/orders';
import { errorMessage } from '../../lib/text';
import { DiscountScopeFields } from './discount-scope-fields';

function ValueFields() {
  const t = getTranslations('commerce').discounts;
  const form = useFormContext<DiscountFormValues>();
  const type = form.watch('type');

  return (
    <div className="grid gap-3">
      <FormField
        control={form.control}
        name="type"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.fields.type}</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {DISCOUNT_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t.type[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {type !== 'free_shipping' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="value"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{type === 'percentage' ? t.fields.percentage : t.fields.amount}</FormLabel>
                <FormControl>
                  <Input {...field} inputMode="decimal" autoComplete="off" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {type === 'fixed_amount' ? (
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.fields.currency}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                      maxLength={3}
                      autoComplete="off"
                      spellCheck={false}
                      className="uppercase"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : (
            <FormField
              control={form.control}
              name="maxDiscountAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.fields.maxDiscountAmount}</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="decimal" autoComplete="off" />
                  </FormControl>
                  <FormDescription>{t.fields.maxDiscountAmountHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CountField({ name, label }: Readonly<{ name: 'minimumQuantity' | 'usageLimit' | 'usageLimitPerCustomer'; label: string }>) {
  const form = useFormContext<DiscountFormValues>();
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <NumberInput
              ref={field.ref}
              name={field.name}
              onBlur={field.onBlur}
              min={1}
              value={field.value}
              // Blank is NaN, not undefined: react-hook-form puts an undefined value back to its default.
              onValueChange={(value) => field.onChange(value ?? Number.NaN)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function LimitFields() {
  const t = getTranslations('commerce').discounts;
  const form = useFormContext<DiscountFormValues>();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField
        control={form.control}
        name="minimumSubtotal"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.fields.minimumSubtotal}</FormLabel>
            <FormControl>
              <Input {...field} inputMode="decimal" autoComplete="off" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <CountField name="minimumQuantity" label={t.fields.minimumQuantity} />
      <CountField name="usageLimit" label={t.fields.usageLimit} />
      <CountField name="usageLimitPerCustomer" label={t.fields.usageLimitPerCustomer} />
      <p className="text-xs text-muted-foreground sm:col-span-2">{t.fields.noLimitHint}</p>
      <FormField
        control={form.control}
        name="startsAt"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.fields.startsAt}</FormLabel>
            <FormControl>
              <Input {...field} type="datetime-local" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="endsAt"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.fields.endsAt}</FormLabel>
            <FormControl>
              <Input {...field} type="datetime-local" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

export function DiscountDialog({
  open,
  onOpenChange,
  discount,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; discount?: CommerceDiscount }>) {
  const t = getTranslations('commerce');
  const td = t.discounts;
  const common = getTranslations('common');
  const isEdit = !!discount;
  const create = useCreateCommerceDiscount();
  const update = useUpdateCommerceDiscount();
  // A new fixed-amount code starts in the workspace's default currency.
  const settings = useCommerceSettings();
  const schema = useMemo(() => buildDiscountFormSchema(), []);

  const form = useForm<DiscountFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: discount ? valuesFromDiscount(discount) : emptyDiscountValues(settings.data?.data.defaultCurrency ?? 'EUR'),
  });

  const onSubmit = async (values: DiscountFormValues) => {
    try {
      const body = toDiscountInput(values);
      if (discount) {
        await update.mutateAsync({ id: discount.id, data: body });
        toast.success(td.toastUpdated);
      } else {
        await create.mutateAsync(body);
        toast.success(td.toastCreated);
      }
      onOpenChange(false);
    } catch (err) {
      const info = apiErrorInfo(err);
      if (hasErrorCode(err, 'CODE_TAKEN') || (info.status === 409 && info.details?.field === 'code')) {
        form.setError('code', { message: td.form.codeTaken }, { shouldFocus: true });
        return;
      }
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{isEdit ? td.editTitle : td.newTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{td.fields.name}</FormLabel>
                    <FormControl>
                      <Input {...field} required maxLength={255} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{td.fields.code}</FormLabel>
                    <FormControl>
                      {/* A code is typed by customers: no spellcheck, autocorrect or auto-capitalisation. */}
                      <Input {...field} required maxLength={64} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    </FormControl>
                    <FormDescription>{td.fields.codeHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{td.fields.description}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={2} maxLength={2000} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <ValueFields />
            <DiscountScopeFields />

            <fieldset className="grid gap-3">
              <legend className="mb-2 text-sm font-medium">{td.fields.sectionLimits}</legend>
              <LimitFields />
            </fieldset>

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem className="sm:max-w-xs">
                  <FormLabel>{td.fields.status}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DISCOUNT_STATUSES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {td.status[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {isEdit ? common.actions.save : common.actions.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
