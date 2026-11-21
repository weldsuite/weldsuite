/**
 * One item's plan in the library's detail panel: the weekly demand chart
 * (a year back, a quarter ahead), the numbers behind the suggestion, a plain
 * sentence explaining it, and the rule editor.
 */

import { useMemo } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailPanel, type EntityField } from '@weldsuite/ui/components/entity-detail-panel';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getLocale, getTranslations } from '@/lib/i18n';
import { usePlan, usePlanDemand, useRestorePlan } from '@/hooks/queries/use-replenishment-queries';
import { formatDate, formatMoney, formatNumber, toNumberOrNull } from '../../lib/numbers';
import { OdooManagedBadge } from '../../components/odoo-managed-badge';
import { buildExplanation } from '../lib/explain';
import { isOverstock, urgencyOf, todayUtc } from '../lib/reorder';
import { DemandChart } from './demand-chart';
import { RuleEditor } from './rule-editor';

export function PlanPanel({ planId, onClose }: Readonly<{ planId: string | null; onClose: () => void }>) {
  const t = getTranslations('weldstashReplenishment').panel;
  const locale = getLocale();
  const { can } = usePermissions();
  const detail = usePlan(planId);
  const demand = usePlanDemand(planId);
  const restore = useRestorePlan();
  const plan = detail.data?.plan;
  const rule = detail.data?.rule ?? null;

  const explanation = useMemo(
    () => (plan ? buildExplanation(plan, t.explain) : ''),
    [plan, t],
  );

  const fields: EntityField[] = plan
    ? [
        { label: t.fields.onHand, value: plan.onHand },
        { label: t.fields.allocated, value: plan.allocated },
        { label: t.fields.incoming, value: plan.incoming },
        { label: t.fields.position, value: plan.inventoryPosition },
        { label: t.fields.perDay, value: formatNumber(plan.avgDailyDemand, 1, locale) || '—' },
        {
          label: t.fields.cover,
          value: (
            <span className="flex items-center gap-2">
              {toNumberOrNull(plan.daysOfCover) === null ? '—' : t.days.replace('{count}', formatNumber(plan.daysOfCover, 0, locale))}
              {isOverstock(plan) && <SoftBadge tone="warning">{t.overstock}</SoftBadge>}
            </span>
          ),
        },
        {
          label: t.fields.runsOut,
          value: (
            <span className="flex items-center gap-2">
              {formatDate(plan.stockoutDate, locale) || '—'}
              {(() => {
                const urgency = urgencyOf(plan, todayUtc());
                return urgency ? <SoftBadge tone={urgency === 'review' ? 'warning' : 'danger'}>{t.urgency[urgency]}</SoftBadge> : null;
              })()}
            </span>
          ),
        },
        { label: t.fields.leadTime, value: plan.leadTimeDays === null ? '—' : t.days.replace('{count}', String(plan.leadTimeDays)) },
        { label: t.fields.reviewPeriod, value: plan.reviewPeriodDays === null ? '—' : t.days.replace('{count}', String(plan.reviewPeriodDays)) },
        {
          label: t.fields.serviceLevel,
          value: toNumberOrNull(plan.serviceLevel) === null ? '—' : `${Math.round(Number(plan.serviceLevel) * 1000) / 10}%`,
        },
        { label: t.fields.safetyStock, value: plan.safetyStock ?? '—' },
        { label: t.fields.reorderPoint, value: plan.reorderPoint ?? '—' },
        { label: t.fields.orderUpTo, value: plan.orderUpTo ?? '—' },
        { label: t.fields.suggested, value: <span className="font-medium">{plan.suggestedQty}</span> },
        { label: t.fields.supplier, value: plan.supplierName ?? t.noSupplier },
        { label: t.fields.unitCost, value: plan.unitCost ? formatMoney(plan.unitCost, plan.currency, locale) : '—' },
        { label: t.fields.method, value: (t.methods as Record<string, string>)[plan.method] ?? plan.method },
        { label: t.fields.confidence, value: (t.confidences as Record<string, string>)[plan.confidence] ?? plan.confidence },
        { label: t.fields.calculated, value: formatDate(plan.computedAt, locale) || '—' },
      ]
    : [];

  const handleRestore = async () => {
    if (!plan) return;
    try {
      await restore.mutateAsync(plan.id);
      toast.success(t.toastRestored);
    } catch (err) {
      toast.error((err as Error).message || t.restoreFailed);
    }
  };

  return (
    <EntityDetailPanel
      isOpen={!!planId}
      onClose={onClose}
      title={plan?.productName ?? t.loading}
      topOffset="60px"
      width="560px"
      showHeaderActions={false}
      visibilityText={plan ? [plan.productSku, plan.variantName, plan.warehouseName].filter(Boolean).join(' · ') : ''}
      fields={fields}
    >
      {detail.isLoading && <InlineSpinner className="py-6" />}
      {detail.isError && (
        <ErrorState message={(detail.error as Error)?.message || t.loadError} onRetry={() => void detail.refetch()} />
      )}
      {plan && (
        <div className="mt-4 space-y-5">
          {plan.warehouseManagedByConnectionId && <OdooManagedBadge />}
          {plan.reviewStatus === 'dismissed' && (
            <InfoBanner
              variant="neutral"
              action={
                can('inventory:update') ? (
                  <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => void handleRestore()}>
                    {t.restore}
                  </Button>
                ) : undefined
              }
            >
              {plan.dismissedUntil ? t.dismissedUntil.replace('{date}', formatDate(plan.dismissedUntil, locale)) : t.dismissed}
            </InfoBanner>
          )}
          {plan.reviewStatus === 'ordered' && <InfoBanner variant="success">{t.ordered}</InfoBanner>}

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t.why}</h3>
            <p className="text-sm text-muted-foreground" data-testid="plan-explanation">
              {explanation}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t.demand}</h3>
            {demand.isLoading && <InlineSpinner className="py-6" />}
            {demand.isError && <ErrorState message={(demand.error as Error)?.message || t.demandError} onRetry={() => void demand.refetch()} />}
            {demand.data && <DemandChart demand={demand.data} />}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t.ruleTitle}</h3>
            <RuleEditor plan={plan} rule={rule} canManage={can('inventory:manage')} />
          </section>
        </div>
      )}
    </EntityDetailPanel>
  );
}
