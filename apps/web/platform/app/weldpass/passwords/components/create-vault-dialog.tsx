/** Create a shared vault. The creator becomes its first manager. */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useCreateWeldPassVault } from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';
import { VaultDetailsForm } from './vault-details-form';

export function CreateVaultDialog({
  onClose,
  onCreated,
}: Readonly<{ onClose: () => void; onCreated: (vault: WeldPassVault) => void }>) {
  const tp = usePasswordsT();
  const createVault = useCreateWeldPassVault();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && !createVault.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tp('vaultForm.createTitle')}</DialogTitle>
          <DialogDescription>{tp('vaultForm.createDescription')}</DialogDescription>
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
              });
              onCreated(res.data);
            } catch (err) {
              setFailure(errorMessage(err, tp('vaultForm.createFailed')));
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
