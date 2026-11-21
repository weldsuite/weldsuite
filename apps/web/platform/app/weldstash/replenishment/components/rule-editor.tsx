/**
 * The reorder rule of one item: how its reorder point is worked out (the
 * forecast, a fixed min/max, or not at all), and the overrides for service
 * level, review period, lead time and supplier. No rule means the workspace
 * defaults with the automatic method.
 */

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { ReorderRule, ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import { useDeleteReorderRule, useUpsertReorderRule } from '@/hooks/queries/use-replenishment-queries';
import { useProductSuppliers } from '@/hooks/queries/use-purchasing-queries';
import { formToRuleInput, makeRuleFormSchema, ruleToForm, type RuleFormField, type RuleFormValues } from '../lib/rule-form';

const PREFERRED = '__preferred__';

interface RuleEditorProps {
  plan: ReplenishmentPlan;
  rule: ReorderRule | null;
  canManage: boolean;
}

export function RuleEditor({ plan, rule, canManage }: Readonly<RuleEditorProps>) {
  const t = getTranslations('weldstashReplenishment').rule;
  const upsert = useUpsertReorderRule();
  const remove = useDeleteReorderRule();
  const suppliers = useProductSuppliers({ productId: plan.productId, variantId: plan.variantId ?? 'none' });

  const schema = useMemo(() => makeRuleFormSchema({ invalid: t.invalid, minmax: t.minMax }), [t]);
  const form = useForm<RuleFormValues>({ resolver: zodResolver(schema), defaultValues: ruleToForm(rule) });

  // A different item, or a saved rule coming back from the server, resets the form.
  const ruleKey = rule ? `${rule.id}:${rule.updatedAt}` : 'none';
  useEffect(() => {
    form.reset(ruleToForm(rule));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, ruleKey]);

  const method = form.watch('method');

  const onSubmit = async (values: RuleFormValues) => {
    const result = formToRuleInput(values, plan);
    if (!result.ok) return;
    try {
      await upsert.mutateAsync(result.input);
      toast.success(t.toastSaved);
    } catch (err) {
      toast.error((err as Error).message || t.saveFailed);
    }
  };

  const reset = async () => {
    if (!rule) return;
    try {
      await remove.mutateAsync(rule.id);
      toast.success(t.toastReset);
    } catch (err) {
      toast.error((err as Error).message || t.saveFailed);
    }
  };

  const optionalNumber = (name: RuleFormField, label: string, placeholder: string, description?: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input inputMode="decimal" placeholder={placeholder} disabled={!canManage} {...field} />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="method"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.method}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange} disabled={!canManage}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="auto">{t.methods.auto}</SelectItem>
                  <SelectItem value="min_max">{t.methods.min_max}</SelectItem>
                  <SelectItem value="off">{t.methods.off}</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t.methodHints[method]}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {method === 'min_max' && (
          <div className="grid gap-3 sm:grid-cols-2">
            {optionalNumber('minQty', t.min, '0', t.minHint)}
            {optionalNumber('maxQty', t.max, '0', t.maxHint)}
          </div>
        )}

        {method !== 'off' && (
          <div className="grid gap-3 sm:grid-cols-3">
            {method === 'auto' && optionalNumber('serviceLevelPct', t.serviceLevel, t.defaultPlaceholder)}
            {optionalNumber('reviewPeriodDays', t.reviewPeriod, t.defaultPlaceholder)}
            {optionalNumber('leadTimeDaysOverride', t.leadTime, t.defaultPlaceholder)}
          </div>
        )}

        {method !== 'off' && (
          <FormField
            control={form.control}
            name="productSupplierId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t.supplier}</FormLabel>
                <Select
                  value={field.value || PREFERRED}
                  onValueChange={(value) => field.onChange(value === PREFERRED ? '' : value)}
                  disabled={!canManage}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={PREFERRED}>{t.preferredSupplier}</SelectItem>
                    {(suppliers.data ?? []).map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.supplierName}
                        {row.isPreferred ? ` (${t.preferred})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {canManage ? (
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={upsert.isPending}>
              {upsert.isPending ? t.saving : t.save}
            </Button>
            {rule && (
              <Button type="button" size="sm" variant="ghost" disabled={remove.isPending} onClick={() => void reset()}>
                {t.reset}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t.readOnly}</p>
        )}
      </form>
    </Form>
  );
}
