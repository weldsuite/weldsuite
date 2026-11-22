/** Column definitions for the WeldCommerce discounts list. */

import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { LIST_PRIMARY_COLUMN } from '@/app/weldcommerce/products/config/product-columns';
import type { CommerceDiscount } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { discountStatusLabel, discountStatusTone, formatDiscountValue, formatUsage } from '../../lib/discounts';

export function DiscountStatusBadge({ status }: Readonly<{ status: string }>) {
  return <SoftBadge tone={discountStatusTone(status)}>{discountStatusLabel(status)}</SoftBadge>;
}

/** "5 Jan – 28 Feb", "From 5 Jan", "Until 28 Feb", or "Any time". */
export function formatValidity(discount: Pick<CommerceDiscount, 'startsAt' | 'endsAt'>): string {
  const t = getTranslations('commerce').discounts;
  const from = formatPanelDate(discount.startsAt);
  const until = formatPanelDate(discount.endsAt);
  if (from && until) return `${from} – ${until}`;
  if (from) return t.panel.from.replace('{date}', from);
  if (until) return t.panel.until.replace('{date}', until);
  return t.fields.anyTime;
}

export function buildDiscountColumns(): ColumnDef<CommerceDiscount>[] {
  const t = getTranslations('commerce').discounts.columns;
  return [
    {
      id: 'name',
      header: t.name,
      width: LIST_PRIMARY_COLUMN,
      render: (d) => <span className="block truncate font-medium">{d.name}</span>,
    },
    {
      id: 'code',
      header: t.code,
      width: 'hidden @lg/list:block w-[150px]',
      render: (d) => <code className="block truncate text-xs">{d.code}</code>,
    },
    {
      id: 'value',
      header: t.value,
      width: 'w-[130px]',
      render: (d) => <span className="tabular-nums">{formatDiscountValue(d)}</span>,
    },
    {
      id: 'usage',
      header: t.usage,
      width: 'hidden @2xl/list:block w-[100px]',
      render: (d) => <span className="tabular-nums text-muted-foreground">{formatUsage(d)}</span>,
    },
    {
      id: 'validity',
      header: t.validity,
      width: 'hidden @4xl/list:block w-[190px]',
      render: (d) => <span className="block truncate text-muted-foreground tabular-nums">{formatValidity(d)}</span>,
    },
    {
      id: 'status',
      header: t.status,
      width: 'hidden @xl/list:block w-[120px]',
      render: (d) => <DiscountStatusBadge status={d.effectiveStatus} />,
    },
  ];
}
