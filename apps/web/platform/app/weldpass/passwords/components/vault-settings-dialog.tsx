/**
 * A shared vault's settings: rename, members, activity, delete.
 *
 * Managers (and workspace admins) get all of it. Any other member gets the
 * member list and a way to leave. A workspace admin who is not a member of the
 * vault can manage who is in it — including adding themselves — but this
 * dialog never shows them its items.
 */

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDeleteWeldPassVault,
  useUpdateWeldPassVault,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';
import { VaultActivityPanel } from './vault-activity-panel';
import { VaultDetailsForm } from './vault-details-form';
import { VaultMembersPanel } from './vault-members-panel';

export function VaultSettingsDialog({
  vault,
  canAdminister,
  currentUserId,
  onClose,
  onGone,
}: Readonly<{
  vault: WeldPassVault;
  canAdminister: boolean;
  currentUserId: string | undefined;
  onClose: () => void;
  /** The vault was deleted, or the caller left it. */
  onGone: (reason: 'deleted' | 'left') => void;
}>) {
  const tp = usePasswordsT();
  const updateVault = useUpdateWeldPassVault();
  const deleteVault = useDeleteWeldPassVault();

  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function remove() {
    try {
      await deleteVault.mutateAsync(vault.id);
      onGone('deleted');
    } catch (err) {
      setConfirmingDelete(false);
      setFailure(errorMessage(err, tp('settings.deleteFailed')));
    }
  }

  const members = (
    <VaultMembersPanel
      vault={vault}
      canAdminister={canAdminister}
      currentUserId={currentUserId}
      onLeft={() => onGone('left')}
    />
  );

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tp('settings.title', { vault: vault.name })}</DialogTitle>
            <DialogDescription>
              {canAdminister ? tp('settings.descriptionManager') : tp('settings.descriptionMember')}
            </DialogDescription>
          </DialogHeader>

          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          {canAdminister ? (
            <Tabs defaultValue="members">
              <TabsList>
                <TabsTrigger value="members">{tp('settings.tabMembers')}</TabsTrigger>
                <TabsTrigger value="details">{tp('settings.tabDetails')}</TabsTrigger>
                <TabsTrigger value="activity">{tp('settings.tabActivity')}</TabsTrigger>
              </TabsList>

              <TabsContent value="members" className="pt-4">
                {members}
              </TabsContent>

              <TabsContent value="details" className="space-y-6 pt-4">
                <VaultDetailsForm
                  defaultValues={{ name: vault.name, description: vault.description ?? '' }}
                  submitLabel={tp('common.save')}
                  pending={updateVault.isPending}
                  onSubmit={async (values) => {
                    setFailure(null);
                    setSaved(false);
                    try {
                      await updateVault.mutateAsync({
                        vaultId: vault.id,
                        name: values.name.trim(),
                        description: values.description.trim() || null,
                      });
                      setSaved(true);
                    } catch (err) {
                      setFailure(errorMessage(err, tp('settings.saveFailed')));
                    }
                  }}
                />
                {saved && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
                    {tp('settings.saved')}
                  </p>
                )}

                <div className="space-y-2 rounded-md border border-destructive/30 p-3">
                  <p className="text-sm font-medium">{tp('settings.dangerTitle')}</p>
                  <p className="text-xs text-muted-foreground">{tp('settings.dangerDescription')}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    {tp('settings.delete')}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="activity" className="pt-4">
                <VaultActivityPanel vaultId={vault.id} />
              </TabsContent>
            </Tabs>
          ) : (
            members
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={tp('settings.deleteTitle', { vault: vault.name })}
        description={tp('settings.deleteDescription')}
        confirmLabel={tp('settings.delete')}
        cancelLabel={tp('common.cancel')}
        variant="destructive"
        onConfirm={remove}
      />
    </>
  );
}
