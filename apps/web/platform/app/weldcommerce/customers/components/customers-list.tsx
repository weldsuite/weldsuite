import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useDeleteCompany } from '@/components/objects/company/use-company-data';
import { useDeletePerson } from '@/components/objects/person/use-person-data';
import { getTranslations } from '@/lib/i18n';
import { buildCustomerColumns } from '../config/customer-columns';
import type { CustomerRow } from '../config/customer-row';
import { CustomerDialog } from './customer-dialog';

interface CustomersListProps {
  customers: CustomerRow[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function CustomersList({
  customers,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: CustomersListProps) {
  const t = getTranslations('commerce').module;
  const deleteCompany = useDeleteCompany();
  const deletePerson = useDeletePerson();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/customers');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerRow | undefined>();

  const columns = useMemo(() => buildCustomerColumns(), []);

  const handleDelete = async (row: CustomerRow) => {
    if (!confirm(t.customers.confirmDelete)) return;
    try {
      // Route to the object the row actually came from.
      if (row.kind === 'company') await deleteCompany.mutateAsync(row.id);
      else await deletePerson.mutateAsync(row.id);
      toast.success(t.customers.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
      <PanelEntityList<CustomerRow>
        items={customers}
        isLoading={isLoading}
        columns={columns}
        // `kind` doubles as the object-panel type — 'company' and 'person' are
        // both registered panels.
        onRowClick={(c) => openObjectPanel({ type: c.kind, id: c.id })}
        onEdit={setEditing}
        onDelete={handleDelete}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.customers.searchPlaceholder}
        createButton={{ label: t.customers.newButton, onClick: () => setCreateOpen(true) }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Users className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: t.customers.empty,
          description: t.customers.sharedWithCrm,
          action: { label: t.customers.newButton, onClick: () => setCreateOpen(true) },
        }}
      />

      {createOpen && <CustomerDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <CustomerDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(undefined)}
          customer={editing}
        />
      )}
    </>
  );
}
