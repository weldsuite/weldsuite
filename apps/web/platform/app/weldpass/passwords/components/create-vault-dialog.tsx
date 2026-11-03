/**
 * Create a shared vault. The creator becomes its first manager; the teammates
 * picked under "Who has access" join it in the same request.
 */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useCreateWeldPassVault } from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';
import { VaultAccessPicker, type InitialVaultMember } from './vault-access-picker';
import { VaultDetailsForm } from './vault-details-form';

export function CreateVaultDialog({
  currentUserId,
  onClose,
  onCreated,
}: Readonly<{
  currentUserId: string | undefined;
  onClose: () => void;
  onCreated: (vault: WeldPassVault) => void;
}>) {
  const tp = usePasswordsT();
  const createVault = useCreateWeldPassVault();
  const [failure, setFailure] = useState<string | null>(null);
  const [members, setMembers] = useState<InitialVaultMember[]>([]);

  return (
    <Dialog open onOpenChange={(open) => !open && !createVault.isPending && onClose()}>
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{tp('vaultForm.createTitle')}</DialogTitle>
        </DialogHeader>

        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

        <VaultDetailsForm
          defaultValues={{ name: '', description: '' }}
          submitLabel={tp('vaultForm.create')}
          pending={createVault.isPending}
          onCancel={onClose}
          onSubmit={async (values) => {
            setFailure(null);
            try {
              const res = await createVault.mutateAsync({
                name: values.name.trim(),
                description: values.description.trim() || null,
                members,
              });
              onCreated(res.data);
            } catch (err) {
              setFailure(errorMessage(err, tp('vaultForm.createFailed')));
            }
          }}
        >
          <VaultAccessPicker
            value={members}
            onChange={setMembers}
            currentUserId={currentUserId}
            disabled={createVault.isPending}
          />
        </VaultDetailsForm>
      </DialogContent>
    </Dialog>
  );
}
