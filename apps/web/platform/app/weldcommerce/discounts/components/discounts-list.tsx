import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Percent } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useDeleteCommerceDiscount, type CommerceDiscount } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { DISCOUNT_EFFECTIVE_STATUSES, discountStatusLabel } from '../../lib/discounts';
import { useConfirmDelete } from '../../lib/use-confirm-delete';
import { errorMessage } from '../../lib/text';
import { buildDiscountColumns } from '../config/discount-columns';
import { DiscountDialog } from './discount-dialog';

interface DiscountsListProps {
  discounts: CommerceDiscount[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  effectiveStatus: string | undefined;
  onEffectiveStatusChange: (value: string | undefined) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

/**
 * The WeldCommerce discount list. A row opens the discount panel (details and
 * redemptions); create, edit and delete show only to a member who may do them.
 */
export function DiscountsList({
  discounts,
  isLoading,
  search,
  onSearchChange,
  effectiveStatus,
  onEffectiveStatusChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: Readonly<DiscountsListProps>) {
  const t = getTranslations('commerce');
  const td = t.discounts;
  const permissions = usePermissionsMaybe();
  const canCreate = permissions?.can('discounts:create') ?? false;
  const canUpdate = permissions?.can('discounts:update') ?? false;
  const canDelete = permissions?.can('discounts:delete') ?? false;

  const deleteMut = useDeleteCommerceDiscount();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/discounts');

  const [createOpen, setCreateOpen] = useState(false);
  useCreateIntent(() => {
    if (canCreate) setCreateOpen(true);
  });
  const [editing, setEditing] = useState<CommerceDiscount | undefined>();

  const columns = useMemo(() => buildDiscountColumns(), []);

  const confirmDelete = useConfirmDelete<CommerceDiscount>({
    title: td.confirmDelete,
    name: (discount) => discount.name,
    onDelete: async (discount) => {
      try {
        await deleteMut.mutateAsync(discount.id);
        toast.success(td.toastDeleted);
      } catch (err) {
        toast.error(errorMessage(err, t.common.deleteFailed));
      }
    },
  });

  const create = canCreate ? { label: td.newButton, onClick: () => setCreateOpen(true) } : undefined;
  const isFiltered = search.trim() !== '' || effectiveStatus !== undefined;
  const emptyState = isFiltered
    ? { title: td.noResults, description: t.common.noResultsHint }
    : {
        icon: (
          <EmptyStateIllustration>
            <Percent className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: td.empty,
        description: td.emptyDescription,
        action: create,
      };

  return (
    <>
      <PanelEntityList<CommerceDiscount>
        items={discounts}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(d) => openObjectPanel({ type: 'discount', id: d.id })}
        objectPanel={{ type: 'discount' }}
        onEdit={canUpdate ? setEditing : undefined}
        onDelete={canDelete ? confirmDelete.request : undefined}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={td.searchPlaceholder}
        hideFilter
        leftActionButtons={
          <FilterSelect
            value={effectiveStatus}
            onChange={onEffectiveStatusChange}
            options={DISCOUNT_EFFECTIVE_STATUSES.map((value) => ({ value, label: discountStatusLabel(value) }))}
            allLabel={td.filters.allStatuses}
            ariaLabel={td.filters.status}
          />
        }
        createButton={create}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={emptyState}
        noResultsState={{ title: td.noResults, description: t.common.noResultsHint }}
      />
      {confirmDelete.dialog}

      {createOpen && <DiscountDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && <DiscountDialog open onOpenChange={(open) => !open && setEditing(undefined)} discount={editing} />}
    </>
  );
}
