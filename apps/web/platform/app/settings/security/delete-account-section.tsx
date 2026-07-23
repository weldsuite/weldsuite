
import { useState } from 'react';
import { useClerk } from '@clerk/clerk-react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { toast } from 'sonner';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import type { AccountDeletionStatus } from '@weldsuite/app-api-client/schemas/account';
import { DELETE_ACCOUNT_CONFIRMATION } from '@weldsuite/app-api-client/schemas/account';

/**
 * "Danger zone" on Settings → Security: self-service deletion of the caller's
 * WeldSuite account via app-api `/api/account`. This page doubles as the web
 * deletion resource required by Google Play's account-deletion policy for the
 * Weld* mobile apps.
 */
export function DeleteAccountSection() {
  const appApi = useAppApi();
  const { signOut } = useClerk();
  const { t } = useI18n();
  const td = t.settings.security.deleteAccount;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [status, setStatus] = useState<AccountDeletionStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const openDialog = async () => {
    setConfirmText('');
    setStatus(null);
    setDialogOpen(true);
    setIsLoadingStatus(true);
    try {
      const result = await appApi.account.getDeletionStatus();
      setStatus(result.data);
    } catch (error) {
      console.error('Failed to fetch account deletion status:', error);
      toast.error(td.messages.statusFailed);
      setDialogOpen(false);
    } finally {
      setIsLoadingStatus(false);
    }
  };

  const handleDelete = async () => {
    if (confirmText !== DELETE_ACCOUNT_CONFIRMATION || !status?.canDelete) return;

    setIsDeleting(true);
    try {
      await appApi.account.deleteAccount({ confirmation: DELETE_ACCOUNT_CONFIRMATION });
      toast.success(td.messages.deleted);
      await signOut({ redirectUrl: '/' });
    } catch (error) {
      console.error('Failed to delete account:', error);
      const message = error instanceof Error ? error.message : t.settings.security.unknown;
      toast.error(td.messages.deleteFailed.replace('{error}', message));
      setIsDeleting(false);
    }
  };

  const canConfirm =
    !isLoadingStatus &&
    !isDeleting &&
    status?.canDelete === true &&
    confirmText === DELETE_ACCOUNT_CONFIRMATION;

  return (
    <div>
      <h3 className="text-base font-medium mb-3 text-destructive">{td.sectionTitle}</h3>
      <div className="flex items-center justify-between gap-4 rounded-md border border-destructive/40 p-4">
        <div>
          <p className="font-medium">{td.title}</p>
          <p className="text-sm text-muted-foreground">{td.description}</p>
        </div>
        <Button variant="destructive" size="sm" className="shrink-0" onClick={openDialog}>
          {td.button}
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !isDeleting && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{td.dialogTitle}</DialogTitle>
            <DialogDescription>{td.dialogDescription}</DialogDescription>
          </DialogHeader>

          {isLoadingStatus ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : status && !status.canDelete ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 text-destructive shrink-0" />
                {td.blockedTitle}
              </p>
              <p className="text-muted-foreground mt-1">{td.blockedDescription}</p>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                {status.blockers.map((blocker) => (
                  <li key={blocker.workspaceId}>
                    <span className="font-medium">{blocker.name}</span>{' '}
                    <span className="text-muted-foreground">
                      ({td.blockedMembers.replace('{count}', String(blocker.otherMemberCount))})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : status ? (
            <div className="space-y-4">
              {status.workspacesToDelete.length > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <p className="text-muted-foreground">{td.workspacesToDelete}</p>
                  <ul className="mt-2 list-disc pl-5 space-y-1">
                    {status.workspacesToDelete.map((ws) => (
                      <li key={ws.workspaceId} className="font-medium">
                        {ws.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="space-y-2">
                <p className="text-sm font-medium">{td.confirmLabel}</p>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={DELETE_ACCOUNT_CONFIRMATION}
                  autoComplete="off"
                  disabled={isDeleting}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isDeleting}>
              {td.cancel}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={!canConfirm}>
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {td.deleting}
                </>
              ) : (
                td.confirmButton
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
