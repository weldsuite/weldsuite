import { ConfirmDialog } from '@/components/confirm-dialog';
import { useTranslations } from '@weldsuite/i18n/client';

interface DeleteMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/** Confirmation shared by the hover bar and the right-click menu: deleting a message cannot be undone. */
export function DeleteMessageDialog({ open, onOpenChange, onConfirm, loading }: Readonly<DeleteMessageDialogProps>) {
  const st = useTranslations();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={st('sweep.weldchat.messageMenus.deleteTitle')}
      description={st('sweep.weldchat.messageMenus.deleteDescription')}
      confirmLabel={st('sweep.weldchat.messageMenus.delete')}
      cancelLabel={st('sweep.weldchat.messageMenus.cancel')}
      variant="destructive"
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
