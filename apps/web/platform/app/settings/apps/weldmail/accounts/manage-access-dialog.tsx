import { useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Loader2 } from 'lucide-react';
import { useAssignMailAccountUsers } from '@/hooks/queries/use-mail-queries';
import {
  MailAccessPicker,
  useMailAccessSelection,
} from '@/app/weldmail/components/mail-access-picker';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

interface ManageAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountEmail: string;
  defaultIsShared: boolean;
  defaultAssignedUserIds: string[];
}

export function ManageAccessDialog({
  open,
  onOpenChange,
  accountId,
  accountEmail,
  defaultIsShared,
  defaultAssignedUserIds,
}: ManageAccessDialogProps) {
  const ts = getTranslations('settings');
  const tma = ts.weldmail.manageAccess;
  const assignMutation = useAssignMailAccountUsers();
  const access = useMailAccessSelection(defaultIsShared, defaultAssignedUserIds);
  const { reset } = access;

  // Reset when dialog opens with new data
  useEffect(() => {
    if (open) {
      reset(defaultIsShared, defaultAssignedUserIds);
    }
  }, [open, defaultIsShared, defaultAssignedUserIds, reset]);

  const handleSave = async () => {
    try {
      await assignMutation.mutateAsync({ id: accountId, ...access.resolve() });
      toast.success(tma.messages.updated);
      onOpenChange(false);
    } catch {
      toast.error(tma.messages.updateFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tma.title}</DialogTitle>
          <DialogDescription>
            {tma.description.replace('{email}', accountEmail)}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <MailAccessPicker selection={access} idPrefix="manage-access" />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tma.cancel}
          </Button>
          <Button onClick={handleSave} disabled={assignMutation.isPending}>
            {assignMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {tma.saving}
              </>
            ) : (
              tma.save
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
