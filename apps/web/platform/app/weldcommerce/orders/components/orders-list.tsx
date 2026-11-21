import { useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import type { OrderSummary } from '@/hooks/queries/use-commerce-orders-queries';
import { useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { buildOrderColumns } from '../config/order-columns';
import { OrderFilters, type OrderFilterKey, type OrderFilterValues } from './order-filters';

interface OrdersListProps {
  orders: OrderSummary[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  filters: OrderFilterValues;
  onFilterChange: (key: OrderFilterKey, value: string | undefined) => void;
  onClearFilters: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

/**
 * The WeldCommerce order list. A row opens the order panel; New order opens
 * the order form. Orders are not deleted (they are cancelled, in the panel),
 * and editing happens in the panel too, so the row has no menu.
 */
export function OrdersList({
  orders,
  isLoading,
  search,
  onSearchChange,
  filters,
  onFilterChange,
  onClearFilters,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: Readonly<OrdersListProps>) {
  const t = getTranslations('commerce');
  const to = t.orders;
  const router = useRouter();
  const permissions = usePermissionsMaybe();
  const canCreate = permissions?.can('orders:create') ?? false;
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/orders');

  const goToNew = () => router.push('/weldcommerce/orders/new');
  useCreateIntent(() => {
    if (canCreate) goToNew();
  });

  const columns = useMemo(() => buildOrderColumns(), []);
  const isFiltered = search.trim() !== '' || Object.values(filters).some(Boolean);
  const create = canCreate ? { label: to.newButton, onClick: goToNew } : undefined;

  // The list can't tell its own filters from "no orders at all", so the empty state is chosen here.
  const emptyState = isFiltered
    ? { title: to.noResults, description: t.common.noResultsHint }
    : {
        icon: (
          <EmptyStateIllustration>
            <ClipboardList className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: to.empty,
        description: to.emptyDescription,
        action: create,
      };

  return (
    <PanelEntityList<OrderSummary>
      items={orders}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(o) => openObjectPanel({ type: 'order', id: o.id })}
      objectPanel={{ type: 'order' }}
      searchQuery={search}
      onSearchChange={onSearchChange}
      searchPlaceholder={to.searchPlaceholder}
      hideFilter
      leftActionButtons={<OrderFilters values={filters} onChange={onFilterChange} onClear={onClearFilters} />}
      createButton={create}
      hasMore={hasMore}
      isLoadingMore={isFetchingMore}
      onLoadMore={onLoadMore}
      emptyState={emptyState}
      noResultsState={{ title: to.noResults, description: t.common.noResultsHint }}
    />
  );
}
