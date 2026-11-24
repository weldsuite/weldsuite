/**
 * A searchable list of items: all items (the Items tab) or one vault's.
 * Search and the type filter run on the device over what a list carries
 * (titles, usernames, sites), never a secret, so a keystroke costs no request.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { KeyRound } from 'lucide-react-native';
import type { WeldPassItem, WeldPassItemType } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { filterItems, TYPE_FILTER } from '@weldsuite/app-api-client/schemas/weldpass-items';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ItemIcon } from '@/components/ItemIcon';
import { useI18n } from '@/lib/i18n';

type TypeChoice = 'all' | WeldPassItemType;

export function ItemList({
  items,
  loading,
  refreshing,
  onRefresh,
  error,
  empty,
  header,
}: Readonly<{
  items: readonly WeldPassItem[] | undefined;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** Shown instead of the list when it couldn't be loaded and nothing is cached. */
  error?: string | null;
  empty: { title: string; description: string };
  header?: ReactElement | null;
}>) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeChoice>('all');

  const visible = useMemo(
    () =>
      filterItems(items ?? [], {
        query,
        pills: type === 'all' ? [] : [{ id: 'type', field: TYPE_FILTER, operator: 'is', value: type }],
      }),
    [items, query, type],
  );
  const filtering = query.trim() !== '' || type !== 'all';

  let emptyView: ReactElement;
  if (loading) {
    emptyView = (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  } else if (error) {
    emptyView = <EmptyState title={error} />;
  } else if (filtering) {
    emptyView = <EmptyState title={t.items.noMatches} description={t.items.noMatchesDescription} />;
  } else {
    emptyView = (
      <EmptyState
        icon={<KeyRound size={28} color={colors.mutedForeground} />}
        title={empty.title}
        description={empty.description}
      />
    );
  }

  return (
    <FlatList
      data={visible}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={
        <View style={styles.controls}>
          {header}
          <SearchBar value={query} onChangeText={setQuery} placeholder={t.items.search} autoCorrect={false} autoCapitalize="none" />
          <SegmentedControl
            value={type}
            onValueChange={(value) => setType(value as TypeChoice)}
            options={[
              { label: t.items.all, value: 'all' },
              { label: t.types.loginPlural, value: 'login' },
              { label: t.types.notePlural, value: 'note' },
              { label: t.types.cardPlural, value: 'card' },
            ]}
          />
        </View>
      }
      ListEmptyComponent={emptyView}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push({ pathname: '/item/[vaultId]/[itemId]', params: { vaultId: item.vaultId, itemId: item.id } })}
          accessibilityRole="button"
          testID={`item-${item.title}`}
          style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}
        >
          <ItemIcon type={item.type} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
              {item.title}
            </Text>
            {item.subtitle || item.host ? (
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
                {[item.subtitle, item.host].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, flexGrow: 1 },
  controls: { paddingHorizontal: 16, gap: 12, paddingBottom: 8 },
  center: { paddingTop: 48, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 14 },
});
