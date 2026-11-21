/**
 * The approval threshold of a company (phase 6): orders of this company above
 * the amount wait for an approver or admin. An empty amount means no approval
 * (it is saved as no threshold). Read-only without `companies:update`.
 */

import { useMemo, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import {
  useCompanyCommerceSettings,
  useUpdateCompanyCommerceSettings,
} from '@/hooks/queries/use-commerce-buyers-queries';
import { useCommerceSettings } from '@/hooks/queries/use-commerce-orders-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import { amountWithCurrency, buyerErrorMessage, limitIssues } from '@/app/weldcommerce/lib/buyers';

interface ThresholdValues {
  amount: string;
  currency: string;
}

const thresholdSchema = z
  .object({ amount: z.string(), currency: z.string() })
  .superRefine((values, ctx) => limitIssues(values.amount, values.currency, ctx, 'amount', 'currency'));

function ThresholdForm({
  companyId,
  values,
  canEdit,
}: Readonly<{ companyId: string; values: ThresholdValues; canEdit: boolean }>) {
  const t = getTranslations('commerce').buyers;
  const tt = t.threshold;
  const save = useUpdateCompanyCommerceSettings(companyId);
  const form = useForm<ThresholdValues>({
    resolver: zodResolver(thresholdSchema, formSchemaOptions()),
    values,
  });

  const onSubmit = async (next: ThresholdValues) => {
    const limit = amountWithCurrency(next.amount, next.currency);
    try {
      await save.mutateAsync({ approvalThreshold: limit.amount, approvalThresholdCurrency: limit.currency });
      toast.success(tt.saved);
    } catch (err) {
      toast.error(buyerErrorMessage(err, t.errors.generic));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_6rem_auto] sm:items-start">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tt.amount}</FormLabel>
                <FormControl>
                  <Input {...field} readOnly={!canEdit} inputMode="decimal" autoComplete="off" enterKeyHint="next" className="tabular-nums" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="currency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tt.currency}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    readOnly={!canEdit}
                    onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                    maxLength={3}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    enterKeyHint="done"
                    className="uppercase"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {canEdit && (
            <Button type="submit" disabled={submitting} className="sm:mt-[1.625rem]">
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? tt.saving : tt.save}
            </Button>
          )}
        </div>
        {!canEdit && <p className="text-xs text-muted-foreground">{tt.readOnly}</p>}
      </form>
    </Form>
  );
}

export function ApprovalThreshold({ companyId, canEdit }: Readonly<{ companyId: string; canEdit: boolean }>) {
  const tt = getTranslations('commerce').buyers.threshold;
  const settings = useCompanyCommerceSettings(companyId);
  const defaults = useCommerceSettings();
  const defaultCurrency = defaults.data?.data.defaultCurrency ?? 'EUR';
  const data = settings.data?.data;

  const values = useMemo<ThresholdValues>(
    () => ({
      amount: data?.approvalThreshold ?? '',
      currency: data?.approvalThresholdCurrency ?? defaultCurrency,
    }),
    [data?.approvalThreshold, data?.approvalThresholdCurrency, defaultCurrency],
  );

  let body: ReactNode;
  if (settings.isPending) body = <InlineSpinner className="py-4" />;
  else if (settings.isError) body = <InlineError>{tt.loadFailed}</InlineError>;
  else body = <ThresholdForm companyId={companyId} values={values} canEdit={canEdit} />;

  return (
    <section aria-labelledby="company-approval-threshold" className="space-y-2">
      <h3 id="company-approval-threshold" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {tt.title}
      </h3>
      <p className="text-sm text-muted-foreground">{tt.description}</p>
      {body}
    </section>
  );
}
