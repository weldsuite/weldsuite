import React from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Clock } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMeetingHistory } from '@/hooks/useMeetings';
import { MeetingCard } from '@/components/MeetingCard';

export default function HistoryScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data, loading, error, refresh } = useMeetingHistory();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>History</Text>
      </View>

      {loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#7C3AED" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: colors.muted }]}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MeetingCard meeting={item} onPress={() => router.push(`/meeting/${item.id}`)} />
          )}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor="#7C3AED" />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Clock size={48} color={colors.muted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No past meetings</Text>
              <Text style={[styles.emptyBody, { color: colors.muted }]}>
                Completed meetings will appear here.
              </Text>
            </View>
          }
          contentContainerStyle={data?.length ? { paddingVertical: 8 } : styles.emptyContainer}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  error: { fontSize: 14 },
  emptyState: { alignItems: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyBody: { fontSize: 14, textAlign: 'center' },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
});
