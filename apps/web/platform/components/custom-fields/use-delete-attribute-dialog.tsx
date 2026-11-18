/**
 * "Delete column" on a grid column that shows a custom field: the attribute
 * itself is deleted (with its value on every record), after a confirmation.
 * It used to only drop the column from the grid and say "Column deleted"
 * without a request, so the column came back on reload (TASK-1462).
 */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useDeleteCustomField } from '@/hooks/queries/use-settings-queries';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

export function useDeleteAttributeDialog() {
  const t = useTranslations();
  const deleteField = useDeleteCustomField();
  const [open, setOpen] = useState(false);
  // Kept after the dialog closes, so its title doesn't flash an empty name
  // while it animates out.
  const [target, setTarget] = useState<CustomFieldDefinition | null>(null);

  const requestDelete = useCallback((def: CustomFieldDefinition) => {
    setTarget(def);
    setOpen(true);
  }, []);

  const dialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={t('sweep.entities.deleteAttributeTitle', { name: target?.name ?? '' })}
      description={t('sweep.entities.deleteAttributeDescription')}
      confirmLabel={t('sweep.entities.deleteAttribute')}
      variant="destructive"
      onConfirm={async () => {
        if (!target) return;
        try {
          await deleteField.mutateAsync(target.id);
          toast.success(t('sweep.entities.attributeDeleted'));
          setOpen(false);
        } catch {
          toast.error(t('sweep.entities.attributeDeleteFailed'));
        }
      }}
    />
  );

  return { requestDelete, dialog };
}
