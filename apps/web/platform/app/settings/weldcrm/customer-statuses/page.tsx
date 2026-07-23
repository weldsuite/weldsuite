import { useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus, Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';
import { CUSTOMER_STATUS_OPTIONS } from './constants';
import {
  useCustomerStatusesQuery,
  useCreateCustomerStatusMutation,
  useUpdateCustomerStatusMutation,
  useDeleteCustomerStatusMutation,
  useReorderCustomerStatusesMutation,
  STATUS_STYLE_MAP,
} from '@/hooks/queries/use-weldcrm-customer-statuses';
import type { CustomerStatus } from '@weldsuite/core-api-client/schemas/customer-statuses';
import type { CreateCustomerStatusInput } from '@weldsuite/core-api-client/schemas/customer-statuses';
import { StatusRow } from './status-row';
import { StatusFormDialog } from './status-form-dialog';

const TH_CLASS =
  'h-[42px] px-3 text-left font-medium text-[13.5px] text-foreground bg-white dark:bg-background';

export default function CustomerStatusesPage() {
  const { t } = useI18n();
  const ts = t.crm.settings.customerStatuses;
  const settingsT = getTranslations('settings');
  const { can } = usePermissions();
  const canManage = can('settings:manage');

  const { data, isLoading } = useCustomerStatusesQuery();
  const createMutation = useCreateCustomerStatusMutation();
  const updateMutation = useUpdateCustomerStatusMutation();
  const deleteMutation = useDeleteCustomerStatusMutation();
  const reorderMutation = useReorderCustomerStatusesMutation();

  const [formOpen, setFormOpen] = useState(false);
  const [editingStatus, setEditingStatus] = useState<CustomerStatus | undefined>(undefined);
  const [deletingStatus, setDeletingStatus] = useState<CustomerStatus | undefined>(undefined);

  const customStatuses = [...(data?.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const totalRows = CUSTOMER_STATUS_OPTIONS.length + customStatuses.length;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = customStatuses.findIndex((s) => s.id === active.id);
    const newIndex = customStatuses.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(customStatuses, oldIndex, newIndex);
    reorderMutation.mutate(reordered.map((s) => s.id));
  }

  function handleFormSubmit(values: CreateCustomerStatusInput) {
    if (editingStatus) {
      updateMutation.mutate(
        { id: editingStatus.id, data: values },
        {
          onSuccess: () => {
            toast.success(ts.messages.updated);
            setFormOpen(false);
            setEditingStatus(undefined);
          },
          onError: () => toast.error(ts.messages.updateError),
        }
      );
    } else {
      createMutation.mutate(values, {
        onSuccess: () => {
          toast.success(ts.messages.created);
          setFormOpen(false);
        },
        onError: () => toast.error(ts.messages.createError),
      });
    }
  }

  function handleEdit(status: CustomerStatus) {
    setEditingStatus(status);
    setFormOpen(true);
  }

  function handleDeleteConfirm() {
    if (!deletingStatus) return;
    deleteMutation.mutate(deletingStatus.id, {
      onSuccess: () => {
        toast.success(ts.messages.deleted);
        setDeletingStatus(undefined);
      },
      onError: () => toast.error(ts.messages.deleteError),
    });
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Lock className="h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">{ts.noAccess}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{ts.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{ts.subtitle}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditingStatus(undefined);
            setFormOpen(true);
          }}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          {ts.addStatus}
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">{ts.loading}</div>
      ) : (
        // DndContext/SortableContext wrap the whole <table> rather than
        // sitting between <thead> and <tbody>. @dnd-kit renders hidden
        // accessibility nodes (a <div> live region) at the context's
        // location; placing the context as a direct child of <table> made
        // that <div> an invalid child of <table> (React 19 hydration error).
        // Wrapping the table keeps those nodes as siblings of <table>.
        <div className="border rounded-md overflow-hidden bg-white dark:bg-background">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={customStatuses.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <table className="w-full bg-white dark:bg-background text-sm">
                <thead className="bg-white dark:bg-background">
                  <tr className="border-b bg-white dark:bg-background">
                    <th className={TH_CLASS}>{settingsT.weldcrm.customerStatuses.nameColumn}</th>
                    <th className={TH_CLASS}>{settingsT.weldcrm.customerStatuses.slugColumn}</th>
                    <th className={cn(TH_CLASS, 'w-[120px]')}>{settingsT.weldcrm.customerStatuses.typeColumn}</th>
                    <th className={cn(TH_CLASS, 'w-[60px] text-right')} />
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-background">
                  {CUSTOMER_STATUS_OPTIONS.map((opt, idx) => {
                    const style = STATUS_STYLE_MAP[opt.color] ?? STATUS_STYLE_MAP.gray;
                    const rowIndex = idx;
                    const isLast = rowIndex === totalRows - 1;
                    return (
                      <tr
                        key={opt.value}
                        className={cn(
                          'bg-white dark:bg-background hover:bg-muted/50 transition-colors',
                          !isLast && 'border-b'
                        )}
                      >
                        <td className="h-[42px] px-3 align-middle">
                          <span
                            className={cn(
                              'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                              style.color,
                              style.bg
                            )}
                          >
                            {opt.label}
                          </span>
                        </td>
                        <td className="h-[42px] px-3 align-middle text-xs text-muted-foreground font-mono">
                          {opt.value}
                        </td>
                        <td className="h-[42px] px-3 align-middle">
                          <span
                            className={cn(
                              'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none border border-border text-muted-foreground'
                            )}
                          >
                            {ts.builtInBadge}
                          </span>
                        </td>
                        <td className="h-[42px] px-3 align-middle text-right" />
                      </tr>
                    );
                  })}
                  {customStatuses.map((status, idx) => {
                    const rowIndex = CUSTOMER_STATUS_OPTIONS.length + idx;
                    return (
                      <StatusRow
                        key={status.id}
                        status={status}
                        isLast={rowIndex === totalRows - 1}
                        onEdit={handleEdit}
                        onDelete={setDeletingStatus}
                      />
                    );
                  })}
                </tbody>
              </table>
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* Add / Edit dialog */}
      <StatusFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingStatus(undefined);
        }}
        status={editingStatus}
        onSubmit={handleFormSubmit}
        isPending={isPending}
      />

      {/* Delete confirmation dialog */}
      <Dialog open={!!deletingStatus} onOpenChange={(open) => !open && setDeletingStatus(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{ts.deleteDialog.title}</DialogTitle>
            <DialogDescription>
              {ts.deleteDialog.description.replace('{name}', deletingStatus?.name ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingStatus(undefined)}
              className="shadow-none"
            >
              {ts.deleteDialog.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleteMutation.isPending}
            >
              {ts.deleteDialog.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
