/**
 * Discount object panel.
 *
 *   details     → the code, what it takes off, what it applies to, its
 *                 minimums, limits and dates (Edit opens the discount form)
 *   redemptions → the orders the code was used on, newest first
 */

import { useState } from 'react';
import { Pencil, Receipt } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useObjectPanel } from '@/components/object-panel';
import {
  useCommerceDiscount,
  useCommerceDiscountRedemptions,
  type DiscountRedemption,
} from '@/hooks/queries/use-commerce-orders-queries';
import { formatDiscountValue, formatUsage } from '@/app/weldcommerce/lib/discounts';
import { money } from '@/app/weldcommerce/lib/orders';
import { fill } from '@/app/weldcommerce/lib/text';
import { DiscountStatusBadge, formatValidity } from '@/app/weldcommerce/discounts/config/discount-columns';
import { DiscountDialog } from '@/app/weldcommerce/discounts/components/discount-dialog';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab, extraTab } from '@/components/objects/_shared/focused-tabs';

function Redemptions({ discountId }: Readonly<{ discountId: string }>) {
  const t = getTranslations('commerce').discounts.panel;
  const tc = getTranslations('commerce').common;
  const { open } = useObjectPanel();
  const query = useCommerceDiscountRedemptions(discountId);
  const rows: DiscountRedemption[] = query.data?.pages.flatMap((page) => page.data ?? []) ?? [];

  if (query.isError) return <ErrorBanner error={t.redemptionsFailed} className="m-4" />;
  if (rows.length === 0 && !query.isLoading) return <ProseBlock>{t.noRedemptions}</ProseBlock>;
  return (
    <div className="space-y-2 pb-3">
      <SectionHeader>{t.tabRedemptions}</SectionHeader>
      <LineItemList
        items={rows}
        getKey={(row) => row.id}
        renderLeft={(row) => (
          <span className="block min-w-0">
            <button type="button" className="block truncate text-left hover:underline" onClick={() => open({ type: 'order', id: row.orderId, stack: true })}>
              {row.orderNumber ? fill(t.redemptionOrder, { number: row.orderNumber }) : t.redemptionOrderUnknown}
            </button>
            <span className="block truncate text-xs text-muted-foreground">
              {[row.customerEmail, formatPanelDate(row.createdAt)].filter(Boolean).join(' · ')}
            </span>
          </span>
        )}
        renderRight={(row) => <span className="tabular-nums">{money(row.amount, row.currency)}</span>}
      />
      {query.hasNextPage && (
        <div className="px-4">
          <Button type="button" size="sm" variant="ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {tc.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DiscountPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = getTranslations('commerce').discounts;
  const tp = t.panel;
  const { id } = props;
  const { data, isLoading, error } = useCommerceDiscount(id);
  const discount = data?.data;
  const permissions = usePermissionsMaybe();
  const canEdit = permissions?.can('discounts:update') ?? false;
  const [editing, setEditing] = useState(false);

  const scope = (() => {
    if (!discount) return null;
    const locale = getLocale();
    if (discount.appliesTo === 'products') return plural(discount.productIds.length + discount.variantIds.length, tp.scopeProducts, locale);
    if (discount.appliesTo === 'categories') return plural(discount.categoryIds.length, tp.scopeCategories, locale);
    return t.appliesTo.all;
  })();

  return (
    <>
      {editing && discount && <DiscountDialog open onOpenChange={(open) => !open && setEditing(false)} discount={discount} />}
      <SimpleObjectPanel
        {...props}
        objectType="discount"
        isLoading={isLoading}
        hasError={!!error}
        hasData={!!discount}
        title={discount?.name}
        subtitle={discount?.code}
        openHref={discount ? `/weldcommerce/discounts?stack=discount:${encodeURIComponent(discount.id)}` : undefined}
        tabs={[detailsTab(tp.tabDetails), extraTab('redemptions', tp.tabRedemptions, Receipt)]}
        renderTab={(tabId) => (tabId === 'redemptions' && discount ? <Redemptions discountId={discount.id} /> : null)}
        statusBadges={discount && <DiscountStatusBadge status={discount.effectiveStatus} />}
        fields={
          discount
            ? [
                { label: t.fields.type, value: t.type[discount.type] },
                { label: t.columns.value, value: formatDiscountValue(discount) },
                { label: t.fields.maxDiscountAmount, value: formatPanelMoney(discount.maxDiscountAmount, discount.currency) },
                { label: tp.appliesTo, value: scope },
                { label: t.fields.minimumSubtotal, value: formatPanelMoney(discount.minimumSubtotal, discount.currency ?? 'EUR') },
                { label: t.fields.minimumQuantity, value: discount.minimumQuantity },
                { label: t.columns.usage, value: formatUsage(discount) },
                { label: t.fields.usageLimitPerCustomer, value: discount.usageLimitPerCustomer },
                { label: tp.validity, value: formatValidity(discount) },
              ]
            : []
        }
        extras={
          discount && (
            <div className="space-y-3">
              {canEdit && (
                <div className="px-4 pt-3">
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                    <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    {tp.edit}
                  </Button>
                </div>
              )}
              {discount.description && <ProseBlock>{discount.description}</ProseBlock>}
            </div>
          )
        }
      />
    </>
  );
}
