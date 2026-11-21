/**
 * Column definitions for the WeldCommerce products list: the selling view of
 * the catalogue WeldStash shares (price, variants, brand), where the WeldStash
 * list shows stock thresholds and tracking.
 */

import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import { formatPanelMoney } from '@/components/objects/_shared/simple-object-panel';
import type { CommerceProduct } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';

/**
 * Column widths of the commerce lists. The first column grows and keeps a
 * minimum width; the others appear as the list gets wider (`@…/list` is the
 * list's own width, see `PanelEntityList`), least important last, so the
 * first column is never squeezed to nothing next to an open panel.
 */
export const LIST_PRIMARY_COLUMN = 'flex-1 min-w-[140px]';

export function statusTone(status: string | null | undefined): SoftTone {
  if (status === 'active') return 'success';
  if (status === 'draft') return 'warning';
  return 'neutral';
}

/** A product or variant status in the UI language; an unknown one as stored. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  const labels: Record<string, string> = getTranslations('commerce').status;
  return labels[status] ?? status;
}

export function StatusBadge({ status }: Readonly<{ status: string | null | undefined }>) {
  return <SoftBadge tone={statusTone(status)}>{statusLabel(status)}</SoftBadge>;
}

export function buildProductColumns(): ColumnDef<CommerceProduct>[] {
  const t = getTranslations('commerce').products.columns;
  return [
    {
      id: 'name',
      header: t.name,
      width: LIST_PRIMARY_COLUMN,
      render: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          {p.featuredImageUrl ? (
            // Pages of 50 rows: load the thumbnails as they scroll into view.
            <img
              src={p.featuredImageUrl}
              alt=""
              width={32}
              height={32}
              loading="lazy"
              className="h-8 w-8 shrink-0 rounded object-cover bg-muted"
            />
          ) : (
            <span className="h-8 w-8 shrink-0 rounded bg-muted" aria-hidden="true" />
          )}
          <span className="truncate font-medium">{p.name}</span>
        </span>
      ),
    },
    {
      id: 'sku',
      header: t.sku,
      width: 'hidden @3xl/list:block w-[150px]',
      render: (p) => <span className="text-muted-foreground truncate block">{p.sku?.trim() || '—'}</span>,
    },
    {
      id: 'price',
      header: t.price,
      width: 'w-[130px]',
      render: (p) => <span className="tabular-nums">{formatPanelMoney(p.price, p.currency) ?? '—'}</span>,
    },
    {
      id: 'variants',
      header: t.variants,
      width: 'hidden @4xl/list:block w-[100px]',
      render: (p) => <span className="tabular-nums text-muted-foreground">{p.variantCount ? p.variantCount : '—'}</span>,
    },
    {
      id: 'stock',
      header: t.stock,
      width: 'hidden @4xl/list:block w-[100px]',
      render: (p) => <span className="tabular-nums">{p.inventoryQuantity ?? 0}</span>,
    },
    {
      id: 'brand',
      header: t.brand,
      width: 'hidden @6xl/list:block w-[130px]',
      render: (p) => <span className="text-muted-foreground truncate block">{p.brand?.trim() || '—'}</span>,
    },
    {
      id: 'status',
      header: t.status,
      width: 'hidden @lg/list:block w-[120px]',
      render: (p) => <StatusBadge status={p.status} />,
    },
  ];
}
