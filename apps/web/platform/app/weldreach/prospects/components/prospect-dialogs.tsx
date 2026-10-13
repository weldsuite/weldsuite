/** Every dialog of the prospects page, and the deletes that ask for confirmation first. */

import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachProspect, ReachProspectList } from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDeleteReachList,
  useDeleteReachProspect,
} from '@/hooks/queries/use-reach-prospect-queries';
import { errorMessage } from '@/app/weldreach/components/engage/kit';
import { ImportDialog } from './import/import-dialog';
import { AddToListDialog, ListFormDialog } from './list-dialogs';
import { ProspectDialog } from './prospect-dialog';

export type ProspectsDialog =
  | { kind: 'create' }
  | { kind: 'edit'; prospect: ReachProspect }
  | { kind: 'delete'; prospect: ReachProspect }
  | { kind: 'import' }
  | { kind: 'addToList' }
  | { kind: 'listForm'; list?: ReachProspectList }
  | { kind: 'deleteList'; list: ReachProspectList }
  | null;

export function ProspectDialogs({
  dialog,
  listId,
  selectedIds,
  onClose,
  onShowList,
  onProspectDeleted,
  onListDeleted,
  onAddedToList,
}: Readonly<{
  dialog: ProspectsDialog;
  /** The list the table is filtered to; a prospect added by hand joins it. */
  listId: string | undefined;
  selectedIds: string[];
  onClose: () => void;
  /** Filter the table to a list (after an import filled it). */
  onShowList: (listId: string) => void;
  onProspectDeleted: (prospectId: string) => void;
  onListDeleted: (listId: string) => void;
  onAddedToList: () => void;
}>) {
  const t = useTranslations();
  const deleteProspect = useDeleteReachProspect();
  const deleteList = useDeleteReachList();

  async function confirmDeleteProspect(prospect: ReachProspect) {
    try {
      await deleteProspect.mutateAsync(prospect.id);
      onProspectDeleted(prospect.id);
      toast.success(t('reachEngage.prospects.deleted'));
    } catch (err) {
      toast.error(errorMessage(err, t('reachEngage.prospects.deleteFailed')));
    } finally {
      onClose();
    }
  }

  async function confirmDeleteList(list: ReachProspectList) {
    try {
      await deleteList.mutateAsync(list.id);
      onListDeleted(list.id);
      toast.success(t('reachEngage.prospects.lists.deleted', { name: list.name }));
    } catch (err) {
      toast.error(errorMessage(err, t('reachEngage.prospects.lists.deleteFailed')));
    } finally {
      onClose();
    }
  }

  return (
    <>
      {dialog?.kind === 'create' && <ProspectDialog listId={listId} onClose={onClose} />}
      {dialog?.kind === 'edit' && <ProspectDialog prospect={dialog.prospect} onClose={onClose} />}
      {dialog?.kind === 'import' && <ImportDialog onClose={onClose} onViewList={onShowList} />}
      {dialog?.kind === 'addToList' && (
        <AddToListDialog
          prospectIds={selectedIds}
          onClose={onClose}
          onDone={() => {
            onClose();
            onAddedToList();
            toast.success(t('reachEngage.prospects.addToList.done'));
          }}
        />
      )}
      {dialog?.kind === 'listForm' && <ListFormDialog list={dialog.list} onClose={onClose} />}

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(open) => !open && onClose()}
        title={t('reachEngage.prospects.deleteTitle')}
        description={t('reachEngage.prospects.deleteDescription', {
          prospect: dialog?.kind === 'delete' ? dialog.prospect.email : '',
        })}
        confirmLabel={t('reachEngage.common.delete')}
        cancelLabel={t('reachEngage.common.cancel')}
        variant="destructive"
        onConfirm={() => (dialog?.kind === 'delete' ? confirmDeleteProspect(dialog.prospect) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'deleteList'}
        onOpenChange={(open) => !open && onClose()}
        title={t('reachEngage.prospects.lists.deleteTitle')}
        description={t('reachEngage.prospects.lists.deleteDescription', {
          name: dialog?.kind === 'deleteList' ? dialog.list.name : '',
        })}
        confirmLabel={t('reachEngage.common.delete')}
        cancelLabel={t('reachEngage.common.cancel')}
        variant="destructive"
        onConfirm={() => (dialog?.kind === 'deleteList' ? confirmDeleteList(dialog.list) : undefined)}
      />
    </>
  );
}
