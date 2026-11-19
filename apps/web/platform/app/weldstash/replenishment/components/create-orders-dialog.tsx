/**
 * Turns the selected Reorder rows into draft purchase orders (one per supplier
 * and warehouse), after showing what will be skipped and what looks off:
 * rows without a supplier, zero quantities, and a supplier's lines adding up
 * to less than its minimum order value. Afterwards, for a warehouse managed in
 * Odoo, offers to send the new orders on as RFQs.
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type {
  CreatePurchaseOrdersFromPlansResult,
  ReplenishmentPlan,
  SkippedPlanReason,
} from '@weldsuite/app-api-client/schemas/replenishment';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useRouter } from '@/lib/router';
import { useCreatePurchaseOrdersFromPlans } from '@/hooks/queries/use-replenishment-queries';
import { useSendPurchaseOrderToOdoo } from '@/hooks/queries/use-purchasing-queries';
import { formatMoney } from '../../lib/numbers';
import { createWarnings, effectiveQuantity, lineValue } from '../lib/reorder';

interface CreateOrdersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: readonly ReplenishmentPlan[];
  /** Quantities the user changed, by plan id. */
  edits: Readonly<Record<string, number>>;
  /** Supplier id -> minimum order value. */
  minimumOrderValues: Readonly<Record<string, string | number | null | undefined>>;
  /** Called when the dialog closes after orders were created, so the caller can clear its selection. */
  onCreated: () => void;
}

export function CreateOrdersDialog({
  open,
  onOpenChange,
  plans,
  edits,
  minimumOrderValues,
  onCreated,
}: Readonly<CreateOrdersDialogProps>) {
  const t = getTranslations('weldstashReplenishment').createOrders;
  const locale = getLocale();
  const router = useRouter();
  const create = useCreatePurchaseOrdersFromPlans();
  const sendToOdoo = useSendPurchaseOrderToOdoo();

  const [result, setResult] = useState<CreatePurchaseOrdersFromPlansResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});

  const warnings = useMemo(() => createWarnings(plans, edits, minimumOrderValues), [plans, edits, minimumOrderValues]);
  const creatable = plans.filter((p) => p.supplierId && effectiveQuantity(p, edits) > 0);
  const total = creatable.reduce((sum, p) => sum + lineValue(p, effectiveQuantity(p, edits)), 0);
  const currency = creatable[0]?.currency ?? null;
  const odooWarehouses = useMemo(
    () => new Set(plans.filter((p) => p.warehouseManagedByConnectionId).map((p) => p.warehouseId)),
    [plans],
  );

  const submit = async () => {
    setError(null);
    const quantities: Record<string, number> = {};
    for (const plan of creatable) {
      const quantity = effectiveQuantity(plan, edits);
      if (quantity !== plan.suggestedQty) quantities[plan.id] = quantity;
    }
    try {
      const created = await create.mutateAsync({
        planIds: creatable.map((p) => p.id),
        ...(Object.keys(quantities).length > 0 ? { quantities } : {}),
      });
      setResult(created);
    } catch (err) {
      setError((err as Error).message || t.failed);
    }
  };

  const sendOne = async (orderId: string) => {
    setSending((s) => ({ ...s, [orderId]: true }));
    try {
      const res = await sendToOdoo.mutateAsync(orderId);
      setSent((s) => ({ ...s, [orderId]: res.odoo.name }));
    } catch (err) {
      toast.error((err as Error).message || t.odooFailed);
    } finally {
      setSending((s) => ({ ...s, [orderId]: false }));
    }
  };

  const reasonText = (reason: SkippedPlanReason) => t.skippedReasons[reason];
  const planName = (planId: string) => {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return planId;
    return plan.productSku ? `${plan.productName} (${plan.productSku})` : (plan.productName ?? planId);
  };
  const odooOrders = result?.purchaseOrders.filter((po) => odooWarehouses.has(po.warehouseId)) ?? [];

  const close = (next: boolean) => {
    if (!next) {
      // The caller clears its selection only now: the offer to send to Odoo reads the selected rows.
      if (result) onCreated();
      setResult(null);
      setError(null);
      setSent({});
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{result ? t.doneTitle : t.title}</DialogTitle>
          <DialogDescription>
            {result
              ? plural(result.purchaseOrders.length, t.doneDescription, getLocale())
              : plural(creatable.length, t.description, getLocale()).replace('{value}', formatMoney(total, currency, locale))}
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            {warnings.withoutSupplier.length > 0 && (
              <InfoBanner variant="warning" title={plural(warnings.withoutSupplier.length, t.noSupplierTitle, getLocale())}>
                {t.noSupplierBody}{' '}
                <span className="text-muted-foreground">{warnings.withoutSupplier.map((p) => p.productName).join(', ')}</span>
              </InfoBanner>
            )}
            {warnings.zeroQuantity.length > 0 && (
              <InfoBanner variant="warning" title={plural(warnings.zeroQuantity.length, t.zeroQuantityTitle, getLocale())}>
                {warnings.zeroQuantity.map((p) => p.productName).join(', ')}
              </InfoBanner>
            )}
            {warnings.belowMinimum.map((w) => (
              <InfoBanner key={w.supplierId} variant="warning" title={t.belowMinimumTitle.replace('{supplier}', w.supplierName ?? '')}>
                {t.belowMinimumBody
                  .replace('{total}', formatMoney(w.total, w.currency, locale))
                  .replace('{minimum}', formatMoney(w.minimum, w.currency, locale))}
              </InfoBanner>
            ))}
            {odooWarehouses.size > 0 && <InfoBanner variant="info">{t.odooNote}</InfoBanner>}
            {creatable.length === 0 && <InlineError>{t.nothingToCreate}</InlineError>}
            {error && <InlineError>{error}</InlineError>}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <ul className="divide-y rounded-md border text-sm">
              {result.purchaseOrders.map((po) => (
                <li key={po.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => router.push(`/weldstash/purchase-orders/${po.id}`)}
                    >
                      {po.poNumber}
                    </button>
                    <span className="ml-2 text-muted-foreground">
                      {po.supplierName} · {plural(po.lineCount, t.lines, getLocale())} · {formatMoney(po.total, currency, locale)}
                    </span>
                  </div>
                  {odooWarehouses.has(po.warehouseId) &&
                    (sent[po.id] ? (
                      <span className="text-xs text-muted-foreground">{t.sentToOdoo.replace('{name}', sent[po.id])}</span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={sending[po.id]} onClick={() => void sendOne(po.id)}>
                        {t.sendToOdoo}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
            {result.skipped.length > 0 && (
              <InfoBanner variant="warning" title={plural(result.skipped.length, t.skippedTitle, getLocale())}>
                <ul className="list-disc pl-4">
                  {result.skipped.map((s) => (
                    <li key={s.planId}>
                      {planName(s.planId)}: {reasonText(s.reason)}
                    </li>
                  ))}
                </ul>
              </InfoBanner>
            )}
            {odooOrders.length > 1 && odooOrders.some((po) => !sent[po.id]) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void (async () => {
                    for (const po of odooOrders) if (!sent[po.id]) await sendOne(po.id);
                  })()
                }
              >
                {t.sendAllToOdoo}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                {t.close}
              </Button>
              <Button onClick={() => router.push('/weldstash/purchase-orders')}>{t.viewOrders}</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                {t.cancel}
              </Button>
              <Button onClick={() => void submit()} disabled={create.isPending || creatable.length === 0}>
                {create.isPending ? t.creating : t.create}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
