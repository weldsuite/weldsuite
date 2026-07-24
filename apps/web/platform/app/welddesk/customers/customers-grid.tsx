
import React, { useState, useMemo } from 'react';
import { useRouter } from '@/lib/router';
import { toast } from 'sonner';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import type { Customer } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateHelpdeskCustomer, useDeleteHelpdeskCustomer } from '@/hooks/queries/use-helpdesk-queries';
import { EntityGrid, EntityGridActions, GridPaginationState } from '@/components/entity-grid';
import { getCustomerGridConfig } from './customer-grid-config';
import { CustomerDetailPanel } from '@/app/weldmail/components/customer-detail-panel';

interface CustomersGridProps {
  customers: Customer[];
  pagination: GridPaginationState;
  searchParams?: {
    page?: string;
    search?: string;
    status?: string;
  };
}

export function CustomersGrid({
  customers,
  pagination,
  searchParams,
}: CustomersGridProps) {
  const router = useRouter();
  const { t } = useI18n();
  const tc = t.helpdesk.customers;
  const customerGridConfig = useMemo(() => getCustomerGridConfig(tc), [tc]);
  const updateCustomerMutation = useUpdateHelpdeskCustomer();
  const deleteCustomerMutation = useDeleteHelpdeskCustomer();

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tc.title },
  ]);

  // Customer detail panel state
  const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; email: string; name: string } | null>(null);
  const [showCustomerPanel, setShowCustomerPanel] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Actions configuration
  const actions: EntityGridActions<Customer> = useMemo(
    () => ({
      onUpdateEntity: async (id, updates) => {
        const result = await updateCustomerMutation.mutateAsync({ id, data: updates });
        if (!result.success) {
          toast.error(tc.failedToUpdateCustomer);
        }
        return result;
      },
      onDeleteEntity: async (id) => {
        const result = await deleteCustomerMutation.mutateAsync(id);
        if (!result.success) {
          toast.error(tc.failedToDeleteCustomer);
        } else {
          toast.success(tc.customerDeleted);
        }
        return result;
      },
      onBulkDelete: async (ids) => {
        let succeeded = 0;
        let failed = 0;
        for (const id of ids) {
          const result = await deleteCustomerMutation.mutateAsync(id);
          if (result.success) {
            succeeded++;
          } else {
            failed++;
          }
        }
        if (failed === 0) {
          toast.success(
            tc.bulkDeleteSuccess.replace('{count}', String(succeeded)).replace('{plural}', succeeded > 1 ? 's' : '')
          );
        } else {
          toast.error(
            tc.bulkDeletePartial.replace('{succeeded}', String(succeeded)).replace('{failed}', String(failed)).replace('{plural}', failed > 1 ? 's' : '')
          );
        }
      },
      onRowClick: (customer) => {
        setSelectedCustomer({ id: customer.id, email: customer.email, name: customer.name });
        setShowCustomerPanel(true);
      },
      onCreateEntity: () => {
        router.push('/welddesk/contacts/new');
      },
    }),
    [router, deleteCustomerMutation, updateCustomerMutation, tc.bulkDeletePartial, tc.bulkDeleteSuccess, tc.customerDeleted, tc.failedToDeleteCustomer, tc.failedToUpdateCustomer]
  );

  return (
    <>
      <EntityGrid
        config={customerGridConfig}
        actions={actions}
        entities={customers}
        pagination={pagination}
        searchParams={searchParams}
      />

      {/* Customer Detail Panel */}
      {selectedCustomer && showCustomerPanel && (
        <CustomerDetailPanel
          email={selectedCustomer.email}
          name={selectedCustomer.name}
          customerId={selectedCustomer.id}
          isOpen={showCustomerPanel}
          onClose={() => {
            setShowCustomerPanel(false);
            setSelectedCustomer(null);
            setIsExpanded(false);
          }}
          topOffset="60px"
          isExpanded={isExpanded}
          onToggleExpand={() => setIsExpanded(prev => !prev)}
        />
      )}
    </>
  );
}
