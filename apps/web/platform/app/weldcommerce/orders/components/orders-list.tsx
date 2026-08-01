import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { ShoppingCart } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useCompanies } from '@/components/objects/company/use-company-data';
import {
  useDeleteCommerceOrder,
  type CommerceOrder,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { buildOrderColumns } from '../config/order-columns';
import { OrderDialog } from './order-dialog';

interface OrdersListProps {
  orders: CommerceOrder[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function OrdersList({
  orders,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: OrdersListProps) {
  const t = getTranslations('commerce').module;
  const deleteMut = useDeleteCommerceOrder();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/orders');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CommerceOrder | undefined>();

  // Orders carry only `customerId`; resolve names once for the whole list.
  const { data: companies } = useCompanies({ limit: 100 });
  const customerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies?.data ?? []) map.set(c.id, c.name);
    return map;
  }, [companies]);

  const columns = useMemo(() => buildOrderColumns(customerNames), [customerNames]);

  const handleDelete = async (order: CommerceOrder) => {
    if (!confirm(t.orders.confirmDelete)) return;
    try {
      await deleteMut.mutateAsync(order.id);
      toast.success(t.orders.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
      <PanelEntityList<CommerceOrder>
        items={orders}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(o) => openObjectPanel({ type: 'order', id: o.id })}
        onEdit={setEditing}
        onDelete={handleDelete}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.orders.searchPlaceholder}
        createButton={{ label: t.orders.newButton, onClick: () => setCreateOpen(true) }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <ShoppingCart className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: t.orders.empty,
          description: t.orders.searchPlaceholder,
          action: { label: t.orders.newButton, onClick: () => setCreateOpen(true) },
        }}
      />

      {createOpen && <OrderDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <OrderDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(undefined)}
          order={editing}
        />
      )}
    </>
  );
}
