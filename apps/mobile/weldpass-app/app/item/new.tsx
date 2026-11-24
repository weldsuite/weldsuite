/** A new login, secure note or card (`?type=`), in the vault given (`?vaultId=`) or the default one. */

import { useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { WeldPassItemType } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { weldpassItemTypeSchema } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import {
  defaultCreateVaultId,
  emptyItemForm,
  sortVaults,
  toItemInput,
  writableVaults,
} from '@weldsuite/app-api-client/schemas/weldpass-items';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { ItemForm } from '@/components/ItemForm';
import { Screen } from '@/components/Screen';
import { useCreateItem, useVaults } from '@/hooks/use-passwords';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';

export default function NewItemScreen() {
  const params = useLocalSearchParams<{ type?: string; vaultId?: string }>();
  const type: WeldPassItemType = weldpassItemTypeSchema.safeParse(params.type).data ?? 'login';
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const vaults = useVaults();
  const create = useCreateItem();

  const writable = useMemo(() => sortVaults(writableVaults(vaults.data ?? [])), [vaults.data]);
  const vaultId = defaultCreateVaultId(writable, params.vaultId);

  let body;
  if (vaults.isLoading) {
    body = <Spinner />;
  } else if (!vaultId) {
    body = <EmptyState title={vaults.error ? passErrorMessage(t, vaults.error) : t.form.noWritableVault} />;
  } else {
    body = (
      <ItemForm
        initial={emptyItemForm(type, vaultId)}
        vaults={writable}
        allowVaultChoice
        saving={create.isPending}
        onSubmit={(values) => {
          create
            .mutateAsync({ vaultId: values.vaultId, input: toItemInput(values) })
            .then((item) => {
              toast.success(t.form.created);
              router.replace({ pathname: '/item/[vaultId]/[itemId]', params: { vaultId: item.vaultId, itemId: item.id } });
            })
            .catch((error: unknown) => toast.error(passErrorMessage(t, error)));
        }}
      />
    );
  }

  return (
    <Screen title={t.form.newTitle[type]} back>
      {body}
    </Screen>
  );
}
