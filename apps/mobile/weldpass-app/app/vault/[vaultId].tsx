/** One vault's items. Adding is offered where the person may write. */

import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { canEditVault, isNonMemberView } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ItemList } from '@/components/ItemList';
import { NewItemSheet } from '@/components/NewItemSheet';
import { HeaderButton, Screen } from '@/components/Screen';
import { useItems, useVaults } from '@/hooks/use-passwords';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';
import { vaultLabel } from '@/lib/vaults';

export default function VaultScreen() {
  const { vaultId } = useLocalSearchParams<{ vaultId: string }>();
  const { t } = useI18n();
  const { colors } = useTheme();
  const vaults = useVaults();
  const items = useItems();
  const [adding, setAdding] = useState(false);

  const vault = vaults.data?.find((candidate) => candidate.id === vaultId);
  const vaultItems = useMemo(() => items.data?.filter((item) => item.vaultId === vaultId), [items.data, vaultId]);
  const writable = canEditVault(vault);

  if (vault && isNonMemberView(vault)) {
    return (
      <Screen title={vault.name} back>
        <EmptyState title={t.vaults.notMember} />
      </Screen>
    );
  }

  let note: string | null = null;
  if (vault?.kind === 'personal') note = t.vaults.personalDescription;
  else if (vault && !writable) note = t.vaults.readOnly;

  return (
    <Screen
      title={vault ? vaultLabel(t, vault) : ''}
      back
      actions={
        writable ? (
          <HeaderButton label={t.items.add} onPress={() => setAdding(true)} testID="add-item-in-vault">
            <Plus size={20} color={colors.text} />
          </HeaderButton>
        ) : null
      }
    >
      <ItemList
        items={vaultItems}
        loading={items.isLoading || vaults.isLoading}
        refreshing={items.isRefetching}
        onRefresh={() => {
          void items.refetch();
          void vaults.refetch();
        }}
        error={items.error && !items.data ? passErrorMessage(t, items.error) : null}
        empty={{ title: t.vaults.noItems, description: t.vaults.noItemsDescription }}
        header={
          note ? (
            <View style={styles.note}>
              <Text style={[styles.noteText, { color: colors.mutedForeground }]}>{note}</Text>
            </View>
          ) : null
        }
      />
      <NewItemSheet visible={adding} onClose={() => setAdding(false)} vaultId={vaultId} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { paddingBottom: 4 },
  noteText: { fontSize: 14 },
});
