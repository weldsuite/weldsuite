/**
 * Edit an item. Saving replaces the whole item, so the form starts from the
 * revealed fields: opening it asks Face ID (or the passcode) and is a reveal
 * the server audits. A cancelled prompt closes the screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { WeldPassRevealedItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import {
  canEditVault,
  itemToFormValues,
  toItemInput,
} from '@weldsuite/app-api-client/schemas/weldpass-items';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { useAppLock } from '@weldsuite/mobile-ui/contexts/AppLockContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { ItemForm } from '@/components/ItemForm';
import { Screen } from '@/components/Screen';
import { useRevealItem, useUpdateItem, useVaults } from '@/hooks/use-passwords';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { usePreventScreenshots } from '@/lib/privacy';

export default function EditItemScreen() {
  const { vaultId, itemId } = useLocalSearchParams<{ vaultId: string; itemId: string }>();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const lock = useAppLock();
  const vaults = useVaults();
  const reveal = useRevealItem('server');
  const update = useUpdateItem();
  const [item, setItem] = useState<WeldPassRevealedItem | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const started = useRef(false);
  usePreventScreenshots();

  const vault = vaults.data?.find((candidate) => candidate.id === vaultId);
  const { mutateAsync } = reveal;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      if (!(await lock.confirm(t.lock.editPrompt))) {
        router.back();
        return;
      }
      try {
        setItem(await mutateAsync({ vaultId, itemId }));
      } catch (error) {
        setFailed(passErrorMessage(t, error));
      }
    })();
  }, [itemId, lock, mutateAsync, router, t, vaultId]);

  const initial = useMemo(() => (item ? itemToFormValues(item, item.fields) : null), [item]);

  let body;
  if (failed) {
    body = <EmptyState title={failed} />;
  } else if (vault && !canEditVault(vault)) {
    body = <EmptyState title={t.errors.viewerOnly} />;
  } else if (!initial) {
    body = <Spinner />;
  } else {
    body = (
      <ItemForm
        initial={initial}
        vaults={vault ? [vault] : []}
        allowVaultChoice={false}
        saving={update.isPending}
        onSubmit={(values) => {
          update
            .mutateAsync({ vaultId, itemId, input: toItemInput(values) })
            .then(() => {
              toast.success(t.form.saved);
              router.back();
            })
            .catch((error: unknown) => toast.error(passErrorMessage(t, error)));
        }}
      />
    );
  }

  return (
    <Screen title={t.form.editTitle} back>
      {body}
    </Screen>
  );
}
