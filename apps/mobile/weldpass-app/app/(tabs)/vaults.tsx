/** The vaults the person can see: their personal vault first, then shared ones by name. */

import { useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Lock, Users } from 'lucide-react-native';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { sortVaults } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Screen } from '@/components/Screen';
import { useVaults } from '@/hooks/use-passwords';
import { brandFor } from '@/lib/brand';
import { passErrorMessage } from '@/lib/errors';
import { useI18n, type Translations } from '@/lib/i18n';
import { vaultLabel } from '@/lib/vaults';

function vaultSubtitle(t: Translations, plural: (n: number, f: { one: string; other: string }) => string, vault: WeldPassVault) {
  const parts: string[] = [];
  if (vault.itemCount != null) parts.push(plural(vault.itemCount, t.items.count));
  if (vault.kind === 'shared') {
    if (vault.memberCount != null) parts.push(plural(vault.memberCount, t.vaults.members));
    if (vault.role) parts.push(t.vaults.roles[vault.role]);
  }
  return parts.join(' · ');
}

export default function VaultsScreen() {
  const { t, plural } = useI18n();
  const { colors, theme } = useTheme();
  const router = useRouter();
  const vaults = useVaults();
  const sorted = useMemo(() => sortVaults(vaults.data ?? []), [vaults.data]);

  let empty = <EmptyState title={t.vaults.empty} description={t.vaults.emptyDescription} />;
  if (vaults.isLoading) {
    empty = (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  } else if (vaults.error) {
    empty = <EmptyState title={passErrorMessage(t, vaults.error)} />;
  }

  return (
    <Screen title={t.vaults.title}>
      <FlatList
        data={sorted}
        keyExtractor={(vault) => vault.id}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={vaults.isRefetching} onRefresh={() => void vaults.refetch()} />}
        ListEmptyComponent={empty}
        renderItem={({ item: vault }) => {
          const Icon = vault.kind === 'personal' ? Lock : Users;
          return (
            <Pressable
              onPress={() => router.push({ pathname: '/vault/[vaultId]', params: { vaultId: vault.id } })}
              accessibilityRole="button"
              testID={`vault-${vault.kind === 'personal' ? 'personal' : vault.name}`}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}
            >
              <View style={[styles.icon, { backgroundColor: colors.secondary }]}>
                <Icon size={20} color={brandFor(theme)} />
              </View>
              <View style={styles.text}>
                <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                  {vaultLabel(t, vault)}
                </Text>
                <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {vault.kind === 'personal' ? t.vaults.personalDescription : vaultSubtitle(t, plural, vault)}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, flexGrow: 1 },
  center: { paddingTop: 48, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  icon: { width: 40, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 14 },
});
