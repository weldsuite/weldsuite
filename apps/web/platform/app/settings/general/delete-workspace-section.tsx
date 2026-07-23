/**
 * Delete workspace section — "Danger zone" on Settings → General.
 *
 * Owner-only, irreversible deletion of the active workspace via app-api
 * `POST /api/workspace-settings/delete`. The owner confirms by typing the
 * workspace slug (guards against deleting the wrong workspace). Deletion
 * cancels any Stripe subscription, deletes the Clerk org (cascade webhook →
 * workspace soft-delete + Neon teardown), then drops the caller into their
 * next workspace (or onboarding).
 *
 * Rendered only when the current member is the workspace OWNER.
 */

import { useState } from 'react';
import { useOrganization, useOrganizationList } from '@clerk/clerk-react';
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
import type { WorkspaceDeletionStatus } from '@weldsuite/app-api-client/schemas/workspace-settings';

export function DeleteWorkspaceSection() {
  const appApi = useAppApi();
  const { organization } = useOrganization();
  const orgList = useOrganizationList({ userMemberships: true });
  const { t } = useI18n();
  const td = (t.settings.generalSettings as any).deleteWorkspace as Record<string, any>;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [status, setStatus] = useState<WorkspaceDeletionStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const slug = status?.slug ?? organization?.slug ?? '';

  const openDialog = async () => {
    setConfirmText('');
    setStatus(null);
    setDialogOpen(true);
    setIsLoadingStatus(true);
    try {
      const result = await appApi.workspaceSettings.getDeletionStatus();
      setStatus(result.data);
    } catch (error) {
      console.error('Failed to fetch workspace deletion status:', error);
      toast.error(td.messages.statusFailed);
      setDialogOpen(false);
    } finally {
      setIsLoadingStatus(false);
    }
  };

  const handleDelete = async () => {
    if (!status || confirmText !== status.slug) return;

    setIsDeleting(true);
    try {
      await appApi.workspaceSettings.deleteWorkspace({ confirmation: status.slug });
      toast.success(td.messages.deleted);
      // Auto-select the caller's next remaining workspace (falls back to
      // onboarding at "/" when this was their last one). Filter out the
      // just-deleted org, which may still linger in the membership list.
      const deletedOrgId = organization?.id;
      const nextOrgId = orgList.userMemberships?.data
        ?.map((m) => m.organization.id)
        .find((id) => id && id !== deletedOrgId);
      // Drop the persisted query cache so the next workspace doesn't hydrate
      // with the deleted workspace's data (parity with switchWorkspace).
      try {
        window.localStorage.removeItem('weldsuite:query-cache');
      } catch {
        // ignore — private mode / storage disabled
      }
      if (nextOrgId && orgList.setActive) {
        await orgList.setActive({ organization: nextOrgId }).catch(() => {});
      }
      window.location.href = '/';
    } catch (error) {
      console.error('Failed to delete workspace:', error);
      const message = error instanceof Error ? error.message : td.messages.unknown;
      toast.error(td.messages.deleteFailed.replace('{error}', message));
      setIsDeleting(false);
    }
  };

  const canConfirm =
    !isLoadingStatus &&
    !isDeleting &&
    !!status &&
    confirmText === status.slug;

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
          ) : status ? (
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4 text-destructive shrink-0" />
                  {td.warningTitle}
                </p>
                <ul className="mt-2 list-disc pl-5 space-y-1 text-muted-foreground">
                  <li>{td.warningMembers.replace('{count}', String(status.memberCount))}</li>
                  <li>{td.warningData}</li>
                  {status.hasActiveSubscription && <li>{td.warningSubscription}</li>}
                </ul>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {td.confirmLabel.replace('{slug}', slug)}
                </p>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={slug}
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
