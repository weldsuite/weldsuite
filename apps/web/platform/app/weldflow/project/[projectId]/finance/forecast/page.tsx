import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useFinanceSettings,
  useProjectFinance,
  useSaveForecast,
} from '@/hooks/queries/use-project-finance-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { formatMoney, formatSigned } from '../_lib/finance';
import { FinanceErrorState, PercentOnlyNotice, Tile, useFinanceEnv } from '../_components/finance-parts';

interface ForecastFormValues {
  amount: string;
  reason: string;
}

/** Finance › Forecast: the forecast at completion, a manual one with its reason, and the history. */
export default function FinanceForecastPage() {
  const { projectId, copy, format, intlLocale } = useFinanceEnv();
  const c = copy.forecast;
  const finance = useProjectFinance(projectId);
  const settings = useFinanceSettings(projectId);
  const save = useSaveForecast(projectId);
  const { isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const mayEdit = isAdmin && can('projects:update');

  const schema = z.object({
    amount: z
      .string()
      .trim()
      .min(1, c.form.amountRequired)
      .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0, c.form.amountInvalid),
    reason: z.string().trim().min(1, c.form.reasonRequired).max(1000, c.form.reasonTooLong),
  });
  const form = useForm<ForecastFormValues>({ resolver: zodResolver(schema), defaultValues: { amount: '', reason: '' } });
  const manual = settings.data?.manualForecast ?? null;
  const { reset } = form;
  useEffect(() => {
    reset({ amount: manual?.amount ?? '', reason: manual?.reason ?? '' });
  }, [manual?.amount, manual?.reason, reset]);

  if (finance.isLoading || settings.isLoading) return <Skeleton className="h-64 rounded-lg" role="status" aria-busy="true" />;
  if (finance.isError || !finance.data || settings.isError || !settings.data) {
    return <FinanceErrorState onRetry={() => { void finance.refetch(); void settings.refetch(); }} />;
  }

  const data = finance.data;
  const { figures } = data;
  const money = (value: string | null) => formatMoney(value, data.currency, intlLocale);
  const overBudget = Number(figures.variance ?? 0) > 0;
  const sourceNote =
    figures.forecastSource === 'manual' ? c.manual : figures.forecastSource === 'cpi' ? c.calculated : figures.forecastSource === 'budget' ? c.calculatedBudget : undefined;

  const submit = (values: ForecastFormValues) =>
    save.mutate(
      { forecast: Number(values.amount), reason: values.reason.trim() },
      { onSuccess: () => toast.success(c.form.saved), onError: () => toast.error(c.form.saveFailed) },
    );
  const clear = () =>
    save.mutate({ forecast: null }, { onSuccess: () => toast.success(c.form.cleared), onError: () => toast.error(c.form.saveFailed) });

  const date = (iso: string) => new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">{c.title}</h2>
        <p className="text-sm text-muted-foreground">{c.description}</p>
      </div>
      {data.canSeeAmounts ? null : <PercentOnlyNotice />}

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]">
        <Tile label={c.current} value={money(figures.forecast)} note={sourceNote} tone={overBudget ? 'warning' : 'default'} />
        <Tile label={c.budget} value={money(figures.budget)} />
        <Tile label={c.variance} value={formatSigned(figures.variance, data.currency, intlLocale)} />
      </div>

      {data.canSeeAmounts ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section aria-labelledby="forecast-form-title" className="rounded-lg border bg-card p-4">
            <h3 id="forecast-form-title" className="text-sm font-semibold">
              {c.form.title}
            </h3>
            {mayEdit ? (
              <form onSubmit={form.handleSubmit(submit)} noValidate className="mt-3 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="forecast-amount">{c.form.amount}</Label>
                  <Input id="forecast-amount" inputMode="decimal" aria-describedby="forecast-amount-hint" aria-invalid={!!form.formState.errors.amount} {...form.register('amount')} />
                  <p id="forecast-amount-hint" className="text-xs text-muted-foreground">
                    {format(c.form.amountHint, { currency: data.currency ?? 'EUR' })}
                  </p>
                  {form.formState.errors.amount ? <p role="alert" className="text-xs text-destructive">{form.formState.errors.amount.message}</p> : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="forecast-reason">{c.form.reason}</Label>
                  <Textarea id="forecast-reason" rows={3} aria-describedby="forecast-reason-hint" aria-invalid={!!form.formState.errors.reason} {...form.register('reason')} />
                  <p id="forecast-reason-hint" className="text-xs text-muted-foreground">
                    {c.form.reasonHint}
                  </p>
                  {form.formState.errors.reason ? <p role="alert" className="text-xs text-destructive">{form.formState.errors.reason.message}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? c.form.saving : c.form.save}
                  </Button>
                  {manual ? (
                    <Button type="button" variant="outline" disabled={save.isPending} onClick={clear}>
                      {c.form.clear}
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">{c.form.readOnly}</p>
            )}
          </section>

          <section aria-labelledby="forecast-history-title" className="rounded-lg border bg-card p-4">
            <h3 id="forecast-history-title" className="text-sm font-semibold">
              {c.history.title}
            </h3>
            {settings.data.history.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{c.history.empty}</p>
            ) : (
              <ol className="mt-2">
                {settings.data.history.map((entry) => (
                  <li key={entry.setAt} className="border-t py-2.5 first:border-t-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold tabular-nums">{entry.amount === null ? c.history.cleared : money(entry.amount)}</span>
                      <span className="text-xs text-muted-foreground">{date(entry.setAt)}</span>
                    </div>
                    {entry.reason ? <p className="mt-0.5 text-sm text-muted-foreground">{entry.reason}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
