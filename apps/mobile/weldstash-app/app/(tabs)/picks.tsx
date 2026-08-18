import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ClipboardList } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import type { PickListRow } from '@weldsuite/app-api-client/domains/pick-lists';
import { appApi } from '@/services/app-api';

const OPEN_STATUSES = ['pending', 'assigned', 'in_progress', 'completed', 'packed'];

export default function PicksScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useClerkAuth();

  const [lists, setLists] = useState<PickListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLists = useCallback(async () => {
    try {
      setError(null);
      const response = await appApi.pickLists.list({
        limit: 50,
        assignedTo: user?.id,
      });
      const rows = (response.data ?? []).filter((row) => OPEN_STATUSES.includes(row.status));
      setLists(rows);
    } catch (err) {
      setError((err as Error).message || 'Failed to load pick lists');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    setLoading(true);
    void fetchLists();
  }, [fetchLists]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Picks</Text>
      </View>
      {loading && lists.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={colors.text} />
      ) : (
        <FlatList
          data={lists}
          keyExtractor={(item) => item.id}
          contentContainerStyle={lists.length === 0 ? styles.emptyContainer : styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void fetchLists(); }} />
          }
          ListEmptyComponent={
            <EmptyState
              icon={<ClipboardList size={40} color={colors.muted} />}
              title={error ? 'Could not load picks' : 'No assigned picks'}
              description={error ?? 'When a supervisor assigns you a pick list, it will show up here.'}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/pick/${item.id}`)}
              style={[styles.row, { backgroundColor: colors.card, borderColor: colors.divider }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>{item.pickListNumber}</Text>
                <Text style={[styles.rowMeta, { color: colors.muted }]}>
                  {item.status.replace('_', ' ')} · {item.pickedItems ?? 0}/{item.totalItems ?? 0} lines
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  emptyContainer: { flexGrow: 1, paddingHorizontal: 16 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  rowTitle: { fontSize: 17, fontWeight: '600' },
  rowMeta: { fontSize: 14, marginTop: 4, textTransform: 'capitalize' },
});
