/** Every item the person can open, across vaults, with search. */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CloudOff, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ItemList } from '@/components/ItemList';
import { NewItemSheet } from '@/components/NewItemSheet';
import { HeaderButton, Screen } from '@/components/Screen';
import { useOffline } from '@/contexts/OfflineContext';
import { useItems } from '@/hooks/use-passwords';
import { passErrorMessage } from '@/lib/errors';
import { formatWhen } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function ItemsScreen() {
  const { t, format, intlLocale } = useI18n();
  const { colors } = useTheme();
  const items = useItems();
  const offline = useOffline();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    hideAppSplash();
  }, []);

  return (
    <Screen
      title={t.items.title}
      actions={
        <HeaderButton label={t.items.add} onPress={() => setAdding(true)} testID="add-item">
          <Plus size={20} color={colors.text} />
        </HeaderButton>
      }
    >
      <ItemList
        items={items.data}
        loading={items.isLoading}
        refreshing={items.isRefetching}
        onRefresh={() => void items.refetch()}
        error={items.error && !items.data ? passErrorMessage(t, items.error) : null}
        empty={{ title: t.items.empty, description: t.items.emptyDescription }}
        header={
          offline.offline && offline.copy ? (
            <View style={[styles.banner, { backgroundColor: colors.secondary }]} testID="offline-banner">
              <CloudOff size={16} color={colors.mutedForeground} />
              <Text style={[styles.bannerText, { color: colors.mutedForeground }]}>
                {format(t.items.offlineBanner, { time: formatWhen(offline.copy.syncedAt, intlLocale) })}
              </Text>
            </View>
          ) : null
        }
      />
      <NewItemSheet visible={adding} onClose={() => setAdding(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  bannerText: { fontSize: 13, flex: 1 },
});
